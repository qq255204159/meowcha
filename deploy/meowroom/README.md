# meowroom · 联机房间服务（通用版）

静态站点的联机房间后端：SQLite 单文件存房间 + 版本号乐观锁 + SSE 变更推送。
前端通过 nginx 同源反代访问（如 `/meowcha/mp/` → 本服务根路径），**房间码即凭据**，无会话/口令。

## 单独运行

```bash
docker build -t meowroom:latest .
docker run -d --name meowroom -p 8000:8000 -v meowroom-data:/data meowroom:latest
```

或本机直跑（无需 Docker）：

```bash
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/rooms` | 建房，body 为初始房间数据 → `{code, version}` |
| GET | `/rooms/{code}` | 取房间 → `{code, version, updatedAt, data}`；**404** = 不存在/已过期 |
| PUT | `/rooms/{code}` | 整房覆盖，body `{version, data}`；版本不一致 → **409** |
| DELETE | `/rooms/{code}` | 删除房间 |
| POST | `/rooms/{code}/actions` | 原子追加一条操作到 `data.actions`（同 `id` 幂等）→ `{version, duplicate?}` |
| GET | `/rooms/{code}/stream` | SSE，房间变更时下发 `{"version": n}`；首行 `retry: 1500` |

另有 `GET /healthz` 健康检查。

## 配置（环境变量）

`PORT`=8000 · `DB_PATH`=`./rooms.db`（容器里用 `/data/rooms.db`）· `ROOM_TTL_HOURS`=12 · `MAX_ROOMS`=800（0 = 不限制）

## 数据

SQLite 单文件，路径见 `DB_PATH`；容器内数据目录为 `/data`，用命名卷（compose 的 `meowroom-data`）持久化。
超过 TTL（默认 12 小时）未更新的房间会被自动清理。
