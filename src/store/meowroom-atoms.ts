/**
 * 喵杀 · 联机房间状态 Atoms
 */
import { atom } from "jotai";
import { MP_HOST_TIMEOUT_MS, type MpRoomState, type MpRoomData } from "@/lib/meowroom/client";

/** 当前所在房间（含版本号与原始数据）；null = 未联机 */
export const mpRoomAtom = atom<MpRoomState | null>(null);

/** 我在房间里的角色：房主 / 客人 / 未联机 */
export const mpRoleAtom = atom<"none" | "host" | "guest">("none");

/** 我在本局的座位号（0 基）；-1 表示未分配（大厅阶段） */
export const mpLocalSeatAtom = atom<number>(-1);

/** 联机错误提示 */
export const mpErrorAtom = atom<string | null>(null);

/** 是否处于「等朋友」的大厅阶段 */
export const mpInLobbyAtom = atom((get) => {
  const room = get(mpRoomAtom);
  return !!room && room.data.status === "waiting";
});

/** 房主是否掉线（对局中整局暂停） */
export const mpHostOfflineAtom = atom((get) => {
  const room = get(mpRoomAtom);
  if (!room || room.data.status !== "playing") return false;
  const beat = room.data.hostBeat ?? 0;
  return beat > 0 && Date.now() - beat > MP_HOST_TIMEOUT_MS;
});

/** 房主我是否已收到全部真人准备完成 */
export const mpAllReadyAtom = atom((get) => {
  const room = get(mpRoomAtom);
  if (!room) return false;
  return room.data.players.length >= 2 && room.data.players.every((p) => p.isReady);
});

/** 我是不是「已开局房间里的客人」——客人端不跑引擎，只渲染房主下发的局面 */
export const mpGuestPlayingAtom = atom((get) => {
  const role = get(mpRoleAtom);
  const room = get(mpRoomAtom);
  return role === "guest" && !!room && room.data.status === "playing";
});

export type { MpRoomState, MpRoomData };
