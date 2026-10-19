/**
 * 喵杀 · 联机房间 Hook
 * ---------------------------------------------------------------
 * 一个 hook 管住：建房 / 凭邀请码入房 / 准备 / 房主开局 / 轮询同步 / 心跳。
 * 房主浏览器是权威端；客人端只读房主下发的（已过滤）局面。
 */
import { useCallback, useEffect, useRef } from "react";
import { useAtom } from "jotai";
import {
  MP_HOST_TIMEOUT_MS,
  apiAppendAction,
  apiCreateRoom,
  apiDeleteRoom,
  apiGetRoom,
  createRoomData,
  getPlayerId,
  getPlayerName,
  joinRoomData,
  mutateRoom,
  normalizeCode,
  openRoomStream,
  readInviteCodeFromUrl,
  savePlayerName,
  saveRoomCode,
  type MpAction,
  type MpRoomData,
  type MpRoomState,
} from "@/lib/meowroom/client";
import { mpErrorAtom, mpLocalSeatAtom, mpRoleAtom, mpRoomAtom } from "@/store/meowroom-atoms";

const WAITING_INTERVAL = 1200;
const PLAYING_INTERVAL = 500;
const HOST_BEAT_INTERVAL = 5000;
/**
 * SSE 可用时，轮询只用来「保险」（正常变更由 SSE 即时推送），故间隔放宽到 5s
 * —— 请求数比原先 0.5s 轮询下降一个数量级；SSE 断开时自动退回原间隔。
 */
const FALLBACK_INTERVAL = 5000;

export function useMeowRoom() {
  const [room, setRoom] = useAtom(mpRoomAtom);
  const [role, setRole] = useAtom(mpRoleAtom);
  const [seat, setSeat] = useAtom(mpLocalSeatAtom);
  const [error, setError] = useAtom(mpErrorAtom);
  const codeRef = useRef<string>("");
  const statusRef = useRef<MpRoomState["data"]["status"]>("waiting");
  statusRef.current = room?.data.status ?? "waiting";

  // ------------------------------------------------------- 变更推送（SSE）
  /** SSE 是否处于可用状态 —— 可用时轮询退化为低频兜底 */
  const streamOkRef = useRef(false);
  /** 当前已知的房间版本（用于过滤 SSE 重复/过期信号，免一次请求） */
  const verRef = useRef(0);
  verRef.current = room?.version ?? 0;

  useEffect(() => {
    const code = room?.code;
    if (!code) return;

    const refresh = async () => {
      try {
        const fresh = await apiGetRoom(code);
        if (!fresh) {
          // 房间被删（房主离场/过期）→ 本地退出联机
          setRoom(null);
          setRole("none");
          setSeat(-1);
          setError("房主已关闭房间");
          return;
        }
        setRoom((prev) => (prev && prev.version > fresh.version ? prev : fresh));
      } catch {
        /* 网络抖动忽略 */
      }
    };

    const close = openRoomStream(code, {
      // 建立/重连成功：立刻重同步一次（重连间隙可能错过变更）
      onOpen: () => {
        streamOkRef.current = true;
        void refresh();
      },
      onChanged: (version) => {
        if (version > 0 && version <= verRef.current) return; // 已是最新，省一次请求
        void refresh();
      },
      onError: () => {
        streamOkRef.current = false; // 退回兜底轮询
      },
    });

    return () => {
      streamOkRef.current = false;
      close();
    };
  }, [room?.code, setRoom, setRole, setSeat, setError]);

  // ---------------------------------------------------------------- 兜底轮询
  useEffect(() => {
    const code = room?.code;
    if (!code) return;
    let stopped = false;

    const loop = async () => {
      while (!stopped) {
        const interval = streamOkRef.current
          ? FALLBACK_INTERVAL
          : (statusRef.current === "playing" ? PLAYING_INTERVAL : WAITING_INTERVAL);
        await new Promise((r) => setTimeout(r, interval));
        if (stopped) return;
        try {
          const fresh = await apiGetRoom(code);
          if (stopped) return;
          if (!fresh) {
            // 房间被删（房主离场/过期）→ 本地退出联机
            setRoom(null);
            setRole("none");
            setSeat(-1);
            setError("房主已关闭房间");
            return;
          }
          setRoom((prev) => (prev && prev.version > fresh.version ? prev : fresh));
        } catch {
          /* 网络抖动忽略，下一轮再试 */
        }
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }, [room?.code, setRoom]);

  // 本地座位随房间数据派生（房主恒 0；客人取自己在 players 里的 index）

  useEffect(() => {
    if (!room) return;
    const me = room.data.players.find((p) => p.id === getPlayerId());
    if (me) {
      if (seat !== me.seat) setSeat(me.seat);
    }
  }, [room, seat, setSeat]);

  // 房主心跳：让客人能判断房主是否掉线
  useEffect(() => {
    if (!room || role !== "host") return;
    const code = room.code;
    const timer = window.setInterval(() => {
      void mutateRoom(code, (d) => ({
        ...d,
        hostBeat: Date.now(),
        players: d.players.map((p) =>
          p.id === getPlayerId() ? { ...p, lastSeen: Date.now() } : p
        ),
      }));
    }, HOST_BEAT_INTERVAL);
    return () => window.clearInterval(timer);
  }, [room?.code, role]);

  // ---------------------------------------------------------------- 操作

  const createRoom = useCallback(
    async (hostName: string, seats: number, options?: Record<string, unknown>): Promise<boolean> => {
      setError(null);
      const name = hostName.trim();
      if (!name) {
        setError("先签个名字喵");
        return false;
      }
      try {
        const playerId = getPlayerId();
        savePlayerName(name);
        const data = createRoomData(playerId, name, seats, options);
        const { code, version } = await apiCreateRoom(data);
        saveRoomCode(code);
        codeRef.current = code;
        setRoom({ code, version, updatedAt: Date.now(), data });
        setRole("host");
        setSeat(0);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "建房失败");
        return false;
      }
    },
    [setError, setRoom, setRole, setSeat]
  );

  const joinRoom = useCallback(
    async (rawCode: string, playerName: string): Promise<boolean> => {
      setError(null);
      const code = normalizeCode(rawCode);
      const name = playerName.trim();
      if (!/^[A-Z0-9]{4,32}$/.test(code)) {
        setError("邀请码看起来不对喵");
        return false;
      }
      if (!name) {
        setError("先签个名字喵");
        return false;
      }
      try {
        const playerId = getPlayerId();
        savePlayerName(name);
        const existing = await apiGetRoom(code);
        if (!existing) {
          setError("这个房间不存在或已经过期了喵");
          return false;
        }
        if (existing.data.status === "playing") {
          const me = existing.data.players.find((p) => p.id === playerId);
          if (!me) {
            setError("这一局已经开始了，等下一局吧喵");
            return false;
          }
        }
        const next = joinRoomData(existing.data, playerId, name);
        const updated = await mutateRoom(code, () => next);
        if (!updated) {
          setError("加入失败了喵，再试一次");
          return false;
        }
        saveRoomCode(code);
        codeRef.current = code;
        setRoom(updated);
        setRole(updated.data.hostId === playerId ? "host" : "guest");
        setSeat(updated.data.players.find((p) => p.id === playerId)?.seat ?? -1);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "加入失败");
        return false;
      }
    },
    [setError, setRoom, setRole, setSeat]
  );

  const claimInviteFromUrl = useCallback(
    async (): Promise<boolean> => {
      const code = readInviteCodeFromUrl();
      if (!code) return false;
      const name = getPlayerName() || "";
      if (!name) return false;
      return joinRoom(code, name);
    },
    [joinRoom]
  );

  const setReady = useCallback(
    async (ready: boolean): Promise<void> => {
      if (!room) return;
      const playerId = getPlayerId();
      const updated = await mutateRoom(room.code, (d) => ({
        ...d,
        players: d.players.map((p) =>
          p.id === playerId ? { ...p, isReady: ready, lastSeen: Date.now() } : p
        ),
      }));
      if (updated) setRoom(updated);
    },
    [room, setRoom]
  );

  const hostStart = useCallback(async (): Promise<boolean> => {
    if (!room) return false;
    const playerId = getPlayerId();
    const mySeat = room.data.players.find((p) => p.id === playerId)?.seat ?? 0;
    const updated = await mutateRoom(room.code, (d) => ({
      ...d,
      status: "playing",
      hostAway: false,
      hostBeat: Date.now(),
      players: d.players.map((p) => ({ ...p, isReady: true })),
    }));
    if (!updated) {
      setError("开局失败，请重试");
      return false;
    }
    setRoom(updated);
    setSeat(mySeat);
    return true;
  }, [room, setRoom, setSeat, setError]);

  /**
   * 断线重连辅助（2026-10-17）：房主页面被刷新 → 本地引擎状态丢失，本局已无法继续。
   * 把房间退回大厅（本局作废），朋友仍留在房内、可等房主重新开局。
   */
  const resetToLobby = useCallback(async (): Promise<void> => {
    if (!room) return;
    const updated = await mutateRoom(room.code, (d) => ({
      ...d,
      status: "waiting",
      views: undefined,
      gameState: undefined,
      hostAway: false,
      players: d.players.map((p) => ({ ...p, isReady: p.isHost })),
    }));
    if (updated) setRoom(updated);
  }, [room, setRoom]);

  /**
   * 房主标记「我暂时不在前台」。
   * 喵杀（十七轮 · 站长实测）：房主切屏/最小化后，后台标签页的定时器会被节流甚至冻结，
   * 心跳与下发都会停 → 客人端会误报「房主掉线，整局暂停」。切屏瞬间主动打这个标记，
   * 客人看到的就是「房主切屏中，稍候喵」（温和提示、不锁定界面），房主回来自动清掉。
   */
  const markHostAway = useCallback(
    async (away: boolean): Promise<void> => {
      if (!room) return;
      const updated = await mutateRoom(room.code, (d) => ({
        ...d,
        hostAway: away,
        hostBeat: Date.now(),
      }));
      if (updated) setRoom(updated);
    },
    [room, setRoom]
  );

  /** 房主下发局面（views: 座位号 → 该座位可见的 gameState） */
  const publishViews = useCallback(
    async (views: Record<string, unknown>, extra?: Partial<MpRoomData>) => {
      if (!room) return;
      const updated = await mutateRoom(room.code, (d) => ({
        ...d,
        views,
        hostBeat: Date.now(),
        // 房主只要还在正常下发，就说明人在前台 → 顺手清掉「切屏中」标记
        //（这样即使切回前台时的 visibilitychange 没跑到，标记也不会一直挂着）
        hostAway: false,
        ...(extra || {}),
      }));
      if (updated) setRoom(updated);
    },
    [room, setRoom]
  );

  /** 客人提交操作 */
  const sendAction = useCallback(
    async (action: Omit<MpAction, "id" | "playerId" | "seat" | "timestamp">): Promise<boolean> => {
      if (!room) return false;
      const playerId = getPlayerId();
      const mySeat = room.data.players.find((p) => p.id === playerId)?.seat ?? -1;
      const full: MpAction = {
        ...action,
        id: `${playerId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        playerId,
        seat: mySeat,
        timestamp: Date.now(),
      };
      try {
        // 服务端原子追加：不和房主的 view PUT 抢版本号
        const version = await apiAppendAction(room.code, full);
        setRoom((prev) => {
          if (!prev) return prev;
          const existing = (prev.data.actions || []).some((a) => a.id === full.id);
          return {
            ...prev,
            version: Math.max(prev.version, version),
            data: {
              ...prev.data,
              actions: existing ? (prev.data.actions || []) : [...(prev.data.actions || []), full],
            },
          };
        });
        return true;
      } catch (e) {
        console.warn("[meowcha] sendAction failed", e);
        return false;
      }
    },
    [room, setRoom]
  );

  /** 房主消费操作游标 */
  const advanceCursor = useCallback(
    async (cursor: number): Promise<void> => {
      if (!room) return;
      const updated = await mutateRoom(room.code, (d) => ({ ...d, actionCursor: cursor }));
      if (updated) setRoom(updated);
    },
    [room, setRoom]
  );

  const leaveRoom = useCallback(async (): Promise<void> => {
    if (room) {
      const playerId = getPlayerId();
      const isHost = room.data.hostId === playerId;
      if (isHost || room.data.players.length <= 1) {
        await apiDeleteRoom(room.code);
      } else {
        await mutateRoom(room.code, (d) => ({
          ...d,
          players: d.players.filter((p) => p.id !== playerId),
        }));
      }
      saveRoomCode("");
    }
    codeRef.current = "";
    setRoom(null);
    setRole("none");
    setSeat(-1);
    setError(null);
  }, [room, setRoom, setRole, setSeat, setError]);

  return {
    room,
    role,
    seat,
    error,
    hostOffline: !!room && room.data.status === "playing" &&
      (room.data.hostBeat ?? 0) > 0 &&
      Date.now() - (room.data.hostBeat ?? 0) > MP_HOST_TIMEOUT_MS,
    createRoom,
    joinRoom,
    claimInviteFromUrl,
    setReady,
    hostStart,
    resetToLobby,
    markHostAway,
    publishViews,
    sendAction,
    advanceCursor,
    leaveRoom,
    setError,
  };
}
