/**
 * 喵杀 · 联机局面过滤（隐藏信息只发当事人）
 * ---------------------------------------------------------------
 * 房主浏览器持有完整局面；下发给每个客户端前，按「这个座位该看到什么」裁一遍：
 *   · 身份：只露自己的；狼人之间互认；游戏结束（GAME_END）全公开
 *   · 夜间行动：守卫/女巫/预言家/狼各看各的（女巫额外能知道被刀的人，因为她要决定救不救）
 *   · 投票：只保留自己那一票；票型结果由引擎在 dayHistory/voteHistory 里公开发布
 *   · 事件：只发 public 事件（private 事件仅当事人可见）
 */
import type { Alignment, GameState, Phase, Player, Role } from "@/types/game";

const WOLF_ROLES: Role[] = ["Werewolf", "WhiteWolfKing"];

function isWolfRole(role: Role): boolean {
  return WOLF_ROLES.includes(role);
}

/** 无敏感内容时的占位玩家（保留座位与昵称，供桌面渲染） */
function maskPlayer(p: Player): Player {
  return {
    ...p,
    role: "Villager" as Role,
    alignment: "village" as Alignment,
    // 喵杀修复（2026-10-17 · 站长实测）：不再剥掉 agentProfile ——
    // persona 属于「角色设定」而非「身份」，是公开信息；剥掉会让客人端把其他玩家
    // 判成「未就绪」而一直显示「加载中」（isReady 依赖 agentProfile.persona）。
    // 真正需要隐藏的只有 role / alignment。
  };
}

export function buildViewForSeat(state: GameState, seat: number): GameState {
  if (!state || typeof seat !== "number" || seat < 0) return state;
  const viewer = state.players.find((p) => p.seat === seat);
  if (!viewer) return state;

  const revealAll: boolean = state.phase === ("GAME_END" as Phase);
  const viewerIsWolf = isWolfRole(viewer.role);

  // ---- 身份 ----
  const players: Player[] = state.players.map((p) => {
    if (revealAll || p.seat === seat) return p;
    // 狼队友互认（狼营内部信息，属于「当事人」范畴）
    if (viewerIsWolf && isWolfRole(p.role)) return p;
    return maskPlayer(p);
  });

  // ---- 夜间行动 ----
  const na = state.nightActions;
  const nightActions: GameState["nightActions"] = revealAll
    ? na
    : {
        ...na,
        guardTarget: viewer.role === "Guard" ? na.guardTarget : undefined,
        lastGuardTarget: viewer.role === "Guard" ? na.lastGuardTarget : undefined,
        wolfVotes: viewerIsWolf ? na.wolfVotes : undefined,
        // 狼营与女巫都能看到今晚的刀口（女巫据此决定是否解药）
        wolfTarget: viewerIsWolf || viewer.role === "Witch" ? na.wolfTarget : undefined,
        witchSave: viewer.role === "Witch" ? na.witchSave : undefined,
        witchPoison: viewer.role === "Witch" ? na.witchPoison : undefined,
        seerTarget: viewer.role === "Seer" ? na.seerTarget : undefined,
        seerResult: viewer.role === "Seer" ? na.seerResult : undefined,
        seerHistory: viewer.role === "Seer" ? na.seerHistory : undefined,
        // 待公布的目标属于「还没公开」的信息，一律不随局面下发
        pendingWolfVictim: undefined,
        pendingPoisonVictim: undefined,
      };

  // ---- 票型：投票**前**只露自己那一票（别人投了谁一律不给），自己投出后 / 引擎 tally 后全桌可见 ----
  // 站长的规则：投票后能看到谁投了谁 —— 主机和邀请来的朋友都一样。
  // 与 VotingProgress 的「你投出后统一公布」保持一致，所以这里也放行「自己已投」这一条件。
  const tallyDone = !!state.voteHistory?.[state.day];
  const badgeTallyDone = !!state.badge.history?.[state.day];
  const iVoted = typeof state.votes[viewer.playerId] === "number";
  const iBadgeVoted = typeof state.badge.votes?.[viewer.playerId] === "number";
  const votes: Record<string, number> = {};
  if (revealAll || tallyDone || iVoted) {
    Object.assign(votes, state.votes);
  }
  const badgeVotes: Record<string, number> = {};
  if (revealAll || badgeTallyDone || iBadgeVoted) {
    Object.assign(badgeVotes, state.badge.votes || {});
  }

  // ---- 历史 ----
  const nightHistory = revealAll
    ? state.nightHistory
    : Object.fromEntries(
        Object.entries(state.nightHistory || {}).map(([day, h]) => {
          if (!h) return [day, h];
          return [
            day,
            {
              ...h,
              guardTarget: viewer.role === "Guard" ? h.guardTarget : undefined,
              seerTarget: viewer.role === "Seer" ? h.seerTarget : undefined,
              seerResult: viewer.role === "Seer" ? h.seerResult : undefined,
              witchSave: viewer.role === "Witch" ? h.witchSave : undefined,
              witchPoison: viewer.role === "Witch" ? h.witchPoison : undefined,
              wolfTarget: viewerIsWolf || viewer.role === "Witch" ? h.wolfTarget : undefined,
            },
          ];
        })
      );

  const events = (state.events || []).filter(
    (ev) =>
      ev.visibility === "public" || (ev.visibleTo || []).includes(viewer.playerId)
  );

  const voteReasons = revealAll ? state.voteReasons : undefined;

  return {
    ...state,
    players,
    nightActions,
    nightHistory,
    events,
    votes,
    voteReasons,
    lastVoteReasons: revealAll ? state.lastVoteReasons : undefined,
    badge: { ...state.badge, votes: revealAll ? state.badge.votes : badgeVotes },
  };
}

/** 房主需要为每个真人座位各裁一份 */
export function buildViewsForSeats(state: GameState, seats: number[]): Record<string, GameState> {
  const out: Record<string, GameState> = {};
  for (const s of seats) out[String(s)] = buildViewForSeat(state, s);
  return out;
}
