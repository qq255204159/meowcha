# -*- coding: utf-8 -*-
"""
联机房间服务（meowroom）· 通用版
------------------------------------------------------------------
职责：房间数据存储（SQLite 单文件）+ 版本号乐观锁 + SSE 变更推送。

设计要点：
  · 前端是纯静态站点，通过 nginx 同源反代访问本服务（例如 /meowcha/mp/ → 本服务根路径），
    房间码即凭据；本服务**不含**任何会话闸门 / 口令 / 站点路径逻辑。
  · 写入用「读-改-写 + 版本号乐观锁」：PUT 必须带 version，不一致就返回 409，由客户端重读重试。
  · 客人操作走 POST /rooms/{code}/actions —— 在服务端锁内原子追加，不整房读改写，
    避免与房主高频 PUT 撞版本号。
  · 变更推送只用 SSE 下发「版本号变了」这一信号，客户端收到后自行 GET 最新房间；
    因此这里不新增任何数据下发路径。

配置全部走环境变量（见 README.md）。
"""
import os
import json
import time
import sqlite3
import secrets
import threading
import asyncio

from fastapi import FastAPI, Request, Body
from fastapi.responses import JSONResponse, StreamingResponse

APP_VERSION = "1.0.0"

# ------------------------------------------------------------------ 配置
# 数据库文件：本地跑用相对路径；容器里建议挂到 /data（见 Dockerfile 与 docker-compose.yml）
DB_PATH = os.environ.get("DB_PATH", "./rooms.db")
# 房间 TTL（小时）：超过这段时间没有更新的房间会被自动清理（通用策略，可按需调整）
ROOM_TTL_HOURS = float(os.environ.get("ROOM_TTL_HOURS", "12"))
ROOM_TTL_SECONDS = int(ROOM_TTL_HOURS * 3600)
# 房间数上限：防止数据库无限增长，达到上限时建房返回 503（0 表示不限制）
MAX_ROOMS = int(os.environ.get("MAX_ROOMS", "800"))

# 房间码字符集：去掉易混的 I O 0 1
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LEN = 8

_db_lock = threading.Lock()
app = FastAPI(title="meowroom", version=APP_VERSION)

# ------------------------------------------------------------ SSE 变更推送
# 进程内发布订阅：容器是**单 uvicorn worker**，所有请求都在同一个事件循环里，
# 所以用 asyncio.Queue 直接唤醒 stream 客户端即可（天然线程安全）。
# 队列里只放「新版本号」这一个整数；队列满时丢弃（客户端稍后仍会拿到更新的版本号）。
SUB_QUEUE_MAX = 16
_subscribers = {}  # code -> set(asyncio.Queue)


# ------------------------------------------------------------------ 存储

def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _init_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    with _db_lock:
        conn = _conn()
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS rooms ("
                " code TEXT PRIMARY KEY,"
                " version INTEGER NOT NULL,"
                " data TEXT NOT NULL,"
                " created_at INTEGER NOT NULL,"
                " updated_at INTEGER NOT NULL)"
            )
            conn.commit()
        finally:
            conn.close()


_init_db()


def _now() -> int:
    return int(time.time())


def _sweep(conn: sqlite3.Connection) -> None:
    """清理过期房间（TTL 见 ROOM_TTL_HOURS）。"""
    conn.execute("DELETE FROM rooms WHERE updated_at < ?", (_now() - ROOM_TTL_SECONDS,))


def _count(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COUNT(*) FROM rooms").fetchone()
    return int(row[0]) if row else 0


def _gen_code(conn: sqlite3.Connection) -> str:
    for _ in range(12):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
        if not conn.execute("SELECT 1 FROM rooms WHERE code = ?", (code,)).fetchone():
            return code
    raise RuntimeError("room code collision")


# ------------------------------------------------------------------ 工具

def _norm(code: str) -> str:
    """房间码统一大写（前端也做同样规范化）。"""
    return (code or "").strip().upper()


def _bad(msg: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": msg}, status_code=status)


def _notify(code: str, version: int) -> None:
    """房间发生变更 → 唤醒所有正在 stream 的客户端（非阻塞，异常全部吞掉）。"""
    queues = _subscribers.get(code)
    if not queues:
        return
    for q in list(queues):
        try:
            q.put_nowait(int(version))
        except asyncio.QueueFull:
            pass


def _room_exists(code: str) -> bool:
    if not code:
        return False
    with _db_lock:
        conn = _conn()
        try:
            return bool(conn.execute("SELECT 1 FROM rooms WHERE code = ?", (code,)).fetchone())
        finally:
            conn.close()


# ------------------------------------------------------------------ 健康检查

@app.get("/healthz")
async def healthz():
    with _db_lock:
        conn = _conn()
        try:
            n = _count(conn)
        finally:
            conn.close()
    return {"ok": True, "version": APP_VERSION, "rooms": n}


# ------------------------------------------------------------------ 房间 CRUD

@app.post("/rooms")
async def create_room(payload: dict = Body(default=None)):
    """建房：body 是房主下发的初始房间数据，返回 {code, version}。"""
    data = payload if isinstance(payload, dict) else {}
    with _db_lock:
        conn = _conn()
        try:
            _sweep(conn)
            if MAX_ROOMS > 0 and _count(conn) >= MAX_ROOMS:
                return _bad("房间太多了，稍后再试", 503)
            code = _gen_code(conn)
            now = _now()
            conn.execute(
                "INSERT INTO rooms (code, version, data, created_at, updated_at) VALUES (?,?,?,?,?)",
                (code, 1, json.dumps(data, ensure_ascii=False), now, now),
            )
            conn.commit()
        finally:
            conn.close()
    return {"code": code, "version": 1}


@app.get("/rooms/{code}")
async def get_room(code: str):
    """取房间；不存在 / 已过期 → 404。"""
    code = _norm(code)
    with _db_lock:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT version, data, updated_at FROM rooms WHERE code = ?", (code,)
            ).fetchone()
        finally:
            conn.close()
    if not row:
        return _bad("房间不存在或已过期", 404)
    return {"code": code, "version": row[0], "updatedAt": row[2], "data": json.loads(row[1])}


@app.put("/rooms/{code}")
async def put_room(code: str, payload: dict = Body(default=None)):
    """整房覆盖：body {version, data}；版本不一致 → 409（乐观锁核心）。"""
    code = _norm(code)
    body = payload if isinstance(payload, dict) else {}
    expect = body.get("version")
    data = body.get("data")
    if not isinstance(expect, int) or not isinstance(data, dict):
        return _bad("请求体需要 {version:int, data:object}")
    with _db_lock:
        conn = _conn()
        try:
            row = conn.execute("SELECT version FROM rooms WHERE code = ?", (code,)).fetchone()
            if not row:
                return _bad("房间不存在或已过期", 404)
            if int(row[0]) != expect:
                return JSONResponse(
                    {"error": "版本不一致", "version": int(row[0])}, status_code=409
                )
            newv = expect + 1
            conn.execute(
                "UPDATE rooms SET version = ?, data = ?, updated_at = ? WHERE code = ?",
                (newv, json.dumps(data, ensure_ascii=False), _now(), code),
            )
            conn.commit()
        finally:
            conn.close()
    _notify(code, newv)
    return {"code": code, "version": newv}


@app.post("/rooms/{code}/actions")
async def append_action(code: str, payload: dict = Body(default=None)):
    """原子追加一条操作到 data.actions 末尾并抬版本号。

    为什么单独开这个接口：房主每 0.5s 用 PUT 下发整份局面，客人若也用 PUT
    读-改-写整间房，会和房主频繁撞版本号；这里只在服务端锁内追加，不要求客人
    先读整间房。action.id 同时作为幂等键 —— 同 id 重复提交只生效一次（网络重试安全）。
    """
    code = _norm(code)
    body = payload if isinstance(payload, dict) else {}
    action = body.get("action")
    if not isinstance(action, dict) or not action.get("id"):
        return _bad("请求体需要 {action:{id,...}}")

    with _db_lock:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT version, data FROM rooms WHERE code = ?", (code,)
            ).fetchone()
            if not row:
                return _bad("房间不存在或已过期", 404)

            data = json.loads(row[1])
            actions = data.get("actions") or []
            if any(a.get("id") == action.get("id") for a in actions if isinstance(a, dict)):
                return {"version": int(row[0]), "duplicate": True}

            actions.append(action)
            data["actions"] = actions
            newv = int(row[0]) + 1
            conn.execute(
                "UPDATE rooms SET version = ?, data = ?, updated_at = ? WHERE code = ?",
                (newv, json.dumps(data, ensure_ascii=False), _now(), code),
            )
            conn.commit()
        finally:
            conn.close()
    _notify(code, newv)
    return {"version": newv}


@app.delete("/rooms/{code}")
async def delete_room(code: str):
    """删除房间；同时唤醒其 stream 客户端，让它们收尾（见 version=0 约定）。"""
    code = _norm(code)
    with _db_lock:
        conn = _conn()
        try:
            conn.execute("DELETE FROM rooms WHERE code = ?", (code,))
            conn.commit()
        finally:
            conn.close()
    _notify(code, 0)
    return {"code": code, "deleted": True}


# ------------------------------------------------------------------ SSE 推送

@app.get("/rooms/{code}/stream")
async def stream_room(code: str, request: Request):
    """房间变更推送（Server-Sent Events）。

    只在房间**有变更**时下发一帧 `event: changed / {"version": n}`；客户端收到后
    自行 GET 一次最新房间，所以这里不需要（也不应该）重复做隐藏信息过滤。
    首行 `retry: 1500` 告诉浏览器重连间隔；每 20s 发一条注释心跳防空闲超时。
    房间被删除时下发 `{"version": 0}` 后**主动收尾**（生成器结束）。
    """
    code = _norm(code)
    if not _room_exists(code):
        return _bad("房间不存在或已过期", 404)

    q = asyncio.Queue(maxsize=SUB_QUEUE_MAX)
    _subscribers.setdefault(code, set()).add(q)

    async def event_gen():
        try:
            yield "retry: 1500\n\n"
            while True:
                if await request.is_disconnected():
                    break  # 断线直接收尾，不报错
                try:
                    version = await asyncio.wait_for(q.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"  # 心跳注释
                    continue
                yield 'event: changed\ndata: {"version": %d}\n\n' % version
                if version == 0:
                    break  # 房间已被删除 → 推完最后一帧收尾
        finally:
            queues = _subscribers.get(code)
            if queues is not None:
                queues.discard(q)
                if not queues:
                    _subscribers.pop(code, None)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",  # 让 nginx 不缓冲（配合 proxy_buffering off）
            "Connection": "keep-alive",
        },
    )
