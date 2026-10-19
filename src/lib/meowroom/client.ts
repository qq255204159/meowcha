/**
 * 喵杀 · 联机房间客户端（meowroom REST + 轮询同步）
 * ---------------------------------------------------------------
 * 设计要点：
 *  · 传输走同源 REST（nginx 反代 /meowcha/mp/ → meowroom 容器），房间码即凭据；
 *  · 写入采用「读-改-写 + 版本号乐观锁」，冲突（409）自动重读重试；
 *  · 房主浏览器跑引擎，其余客户端只渲染房主下发的（已过滤隐藏信息的）局面。
 */
import { assetPath } from "@/lib/site-path";

export const MP_API_BASE = assetPath("/mp");

export const MP_PLAYER_ID_KEY = "meowcha_player_id";
export const MP_PLAYER_NAME_KEY = "meowcha_player_name";
export const MP_ROOM_CODE_KEY = "meowcha_room_code";

/**
 * 房主心跳超时（毫秒）——超过即视为「良久没同步到」。
 * 喵杀（十七轮 · 站长实测）：原先 15s 太短 —— 房主**切屏/最小化**时浏览器会把后台标签页
 * 的定时器节流甚至整个冻结，5s 心跳与 0.8s 下发都会停，客人几秒后就被误报「房主掉线，整局暂停」，
 * 而房主回来后一切照旧。放宽到 60s；同时房主切屏时会主动打 hostAway 标记，客人看到的是
 * 「房主切屏中」这种温和提示，而不是「掉线」。
 */
export const MP_HOST_TIMEOUT_MS = 60000;

export interface MpPlayer {
  id: string;
  name: string;
  /** 游戏座位号（0 基，与服务端 seat 一致） */
  seat: number;
  isHost: boolean;
  isReady: boolean;
  lastSeen: number;
  /** 该玩家是否是本局「真人」——房主建房时按房间座位数标记 */
  isHuman?: boolean;
}

/** 客户端→房主的操作请求（仅房主会消费） */
export interface MpAction {
  id: string;
  playerId: string;
  seat: number;
  type:
    | "speech"
    | "finish_speech"
    | "vote"
    | "night_action"
    | "wwk_boom"
    | "badge_signup"
    | "badge_transfer"
    | "continue_reveal"
    // 喵杀（十七轮）：客人上报「我还差几句台词没读完」（content = 未读条数的十进制字符串）。
    // 房主据此在**进入投票前**等所有真人把已生成的台词读完（站长要求：投票要等全员读完+发言完）。
    | "reading"
    // 喵杀（2026-10-17）：任一真人「推进对话」——联机时两人各自按回车即可推进，
    // 不必等房主（房主引擎是唯一真源，由客人把动作发过去消费）。
    | "advance";
  payload?: {
    content?: string;
    targetSeat?: number;
    witchAction?: "save" | "poison" | "pass";
  };
  timestamp: number;
}

export interface MpRoomData {
  hostId: string;
  status: "waiting" | "playing" | "ended";
  /** 本局总座位数（含 AI 补位） */
  seats: number;
  /** 房主建房时选定的人机难度等开局参数 */
  options?: Record<string, unknown>;
  players: MpPlayer[];
  /** 房主每轮下发的局面快照（客户端已按座位过滤隐藏信息） */
  gameState?: unknown;
  /** 房主记录：这份快照是给哪个座位看的（seat → 过滤后的 state） */
  views?: Record<string, unknown>;
  actions?: MpAction[];
  /** 房主已消费到的操作序号 */
  actionCursor?: number;
  /** 房主心跳时间戳 */
  hostBeat?: number;
  /**
   * 房主主动标记「我切屏了/最小化了」——由房主在 visibilitychange 时写入。
   * 客人据此显示「房主切屏中，稍候喵」，避免把后台节流误判成掉线。
   */
  hostAway?: boolean;
  /**
   * 投票门提示条（房主写入）——例如「3号 还没发言，正在等他」「等 2号(还差N句) 读完再投票」。
   * 喵杀修复（2026-10-18 · 站长实测）：原先这条只在房主本机的 gateNotice 里，
   * 客人快进到推不动时看不到任何提示，站长要求**两边都有**，所以随局面一起下发。
   */
  notice?: string;
  /**
   * 旁白口令（房主写入）——客人端本地不跑引擎，听不到 `playNarrator(...)`；
   * 房主每播一句旁白就把这里的 key 换一次（id 递增），客人据此播同一句。
   * 喵杀修复（2026-10-19 · 站长实测）：朋友端原先完全没有旁白（天黑/睁眼/天亮/死讯…）。
   */
  narration?: { key: string; id: number };
}

export interface MpRoomState {
  code: string;
  version: number;
  updatedAt: number;
  data: MpRoomData;
}

export class MpConflict extends Error {
  constructor(public currentVersion: number) {
    super("version conflict");
  }
}

// ------------------------------------------------------------------ 玩家身份

/**
 * 玩家身份：优先用「本标签页」的 sessionStorage。
 * 这样同一台电脑开两个标签就能各坐一位（一个当房主、一个当朋友），
 * 而关掉浏览器再回来仍能从 localStorage 找回自己的身份。
 */
function readIdentity(key: string): string {
  if (typeof window === "undefined") return "";
  try {
    const perTab = window.sessionStorage.getItem(key);
    if (perTab) return perTab;
  } catch {
    /* 隐私模式可能禁用 sessionStorage */
  }
  try {
    const persisted = window.localStorage.getItem(key) || "";
    if (persisted) window.sessionStorage.setItem(key, persisted);
    return persisted;
  } catch {
    return "";
  }
}

function writeIdentity(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function getPlayerId(): string {
  if (typeof window === "undefined") return "ssr";
  let id = readIdentity(MP_PLAYER_ID_KEY);
  if (!id) {
    id = `player-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    writeIdentity(MP_PLAYER_ID_KEY, id);
  }
  return id;
}

export function getPlayerName(): string {
  if (typeof window === "undefined") return "";
  return readIdentity(MP_PLAYER_NAME_KEY);
}

export function savePlayerName(name: string): void {
  if (typeof window === "undefined") return;
  writeIdentity(MP_PLAYER_NAME_KEY, name);
}

export function getSavedRoomCode(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(MP_ROOM_CODE_KEY) || "";
}

export function saveRoomCode(code: string): void {
  if (typeof window === "undefined") return;
  if (code) window.localStorage.setItem(MP_ROOM_CODE_KEY, code);
  else window.localStorage.removeItem(MP_ROOM_CODE_KEY);
}

/** 从 URL（?code= / ?room= / ?join=）或已存记录里取邀请码 */
export function readInviteCodeFromUrl(): string {
  if (typeof window === "undefined") return "";
  const q = new URLSearchParams(window.location.search);
  const raw = (q.get("code") || q.get("room") || q.get("join") || "").trim().toUpperCase();
  return /^[A-Z0-9]{4,32}$/.test(raw) ? raw : "";
}

export function buildInviteUrl(code: string): string {
  if (typeof window === "undefined") return assetPath(`/?code=${code}`);
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("code", code);
  return url.toString();
}

// ------------------------------------------------------------------ REST

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(MP_API_BASE + path, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.error || "";
    } catch {
      /* ignore */
    }
    const err = new Error(detail || `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export async function apiCreateRoom(data: MpRoomData): Promise<{ code: string; version: number }> {
  return req<{ code: string; version: number }>("/rooms", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function apiGetRoom(code: string): Promise<MpRoomState | null> {
  try {
    const r = await req<MpRoomState>(`/rooms/${encodeURIComponent(code)}`);
    return r;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

export async function apiPutRoom(
  code: string,
  version: number,
  data: MpRoomData
): Promise<number> {
  try {
    const r = await req<{ version: number }>(`/rooms/${encodeURIComponent(code)}`, {
      method: "PUT",
      body: JSON.stringify({ version, data }),
    });
    return r.version;
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 409) throw new MpConflict(version);
    throw err;
  }
}

export async function apiDeleteRoom(code: string): Promise<void> {
  try {
    await req(`/rooms/${encodeURIComponent(code)}`, { method: "DELETE" });
  } catch {
    /* 删除失败不影响本地退出 */
  }
}

/** 原子追加真人操作（服务端锁内完成，不整房读改写） */
export async function apiAppendAction(code: string, action: MpAction): Promise<number> {
  const r = await req<{ version: number; duplicate?: boolean }>(
    `/rooms/${encodeURIComponent(code)}/actions`,
    { method: "POST", body: JSON.stringify({ action }) }
  );
  return r.version;
}

/**
 * 读-改-写（乐观锁）。冲突时重读并重跑 updater，最多 5 次。
 */
export async function mutateRoom(
  code: string,
  updater: (data: MpRoomData) => MpRoomData,
  attempts = 5
): Promise<MpRoomState | null> {
  for (let i = 0; i < attempts; i++) {
    const room = await apiGetRoom(code);
    if (!room) return null;
    const next = updater(room.data);
    try {
      const v = await apiPutRoom(code, room.version, next);
      return { code, version: v, updatedAt: Date.now(), data: next };
    } catch (e) {
      if (e instanceof MpConflict) {
        await new Promise((r) => setTimeout(r, 120 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  return null;
}

// ------------------------------------------------------------------ SSE 变更推送

/**
 * 打开房间变更推送（Server-Sent Events）。
 * 服务端只在「房间有变更」时发一帧（含新版本号），收到后由调用方自行 GET 最新房间；
 * 因此这里不新增任何数据下发路径，隐藏信息过滤逻辑不变。
 * 断线由浏览器 EventSource 自动重连（服务端下发的 `retry: 1500` 生效）。
 * @returns 关闭函数
 */
export function openRoomStream(
  code: string,
  handlers: {
    /** 连接建立/重连成功（可借此做一次状态重同步） */
    onOpen?: () => void;
    /** 房间有变更；version 为新版本号（0 表示首帧对齐或房间已被删除） */
    onChanged: (version: number) => void;
    /** 连接出错（此时可切回兜底轮询；浏览器仍会自动重连） */
    onError?: () => void;
  }
): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return () => {};
  const url = MP_API_BASE + `/rooms/${encodeURIComponent(code)}/stream`;
  let closed = false;
  let es: EventSource | null = null;
  try {
    es = new EventSource(url);
  } catch {
    return () => {};
  }
  es.onopen = () => handlers.onOpen?.();
  es.addEventListener("changed", (ev) => {
    let version = 0;
    try {
      version = Number(JSON.parse((ev as MessageEvent).data)?.version || 0);
    } catch {
      /* 首帧/异常数据按 0 处理 */
    }
    handlers.onChanged(version);
  });
  es.onerror = () => {
    if (closed) return;
    handlers.onError?.();
  };
  return () => {
    closed = true;
    try {
      es?.close();
    } catch {
      /* ignore */
    }
    es = null;
  };
}

// ------------------------------------------------------------------ 语义操作

/** 房间码统一大写 */
export function normalizeCode(code: string): string {
  return (code || "").trim().toUpperCase();
}

/**
 * 复制文本。⚠️ 站点是 http + IP 访问 → 不是 secure context，
 * `navigator.clipboard` 在部分浏览器里为 undefined/直接抛错；必须带 execCommand 兜底。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到兼容方案 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function createRoomData(hostId: string, hostName: string, seats: number, options?: Record<string, unknown>): MpRoomData {
  return {
    hostId,
    status: "waiting",
    seats,
    options,
    players: [
      { id: hostId, name: hostName, seat: 0, isHost: true, isReady: true, lastSeen: Date.now() },
    ],
    actionCursor: 0,
    hostBeat: Date.now(),
    hostAway: false,
  };
}

/** 加入房间：把玩家塞进第 players.length 个真人座位（超出房间座位数则拒绝） */
export function joinRoomData(
  data: MpRoomData,
  playerId: string,
  playerName: string
): MpRoomData {
  const existing = data.players.find((p) => p.id === playerId);
  if (existing) {
    return {
      ...data,
      players: data.players.map((p) =>
        p.id === playerId ? { ...p, name: playerName, lastSeen: Date.now() } : p
      ),
    };
  }
  const seat = data.players.length;
  if (seat >= data.seats) {
    throw new Error("房间人满了喵");
  }
  return {
    ...data,
    players: [
      ...data.players,
      { id: playerId, name: playerName, seat, isHost: false, isReady: false, lastSeen: Date.now() },
    ],
  };
}

/** 房主掉线判定：心跳太久没更新 */
export function isHostOffline(data: MpRoomData | null): boolean {
  if (!data || data.status !== "playing") return false;
  const beat = data.hostBeat ?? 0;
  return beat > 0 && Date.now() - beat > MP_HOST_TIMEOUT_MS;
}
