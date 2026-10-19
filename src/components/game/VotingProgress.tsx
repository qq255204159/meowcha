"use client";

import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle, HourglassSimple } from "@phosphor-icons/react";
import type { GameState, Player } from "@/types/game";

interface VotingProgressProps {
  gameState: GameState;
  humanPlayer: Player | null;
}

export function VotingProgress({ gameState, humanPlayer }: VotingProgressProps) {
  const alivePlayers = gameState.players.filter(p => p.alive);
  const aliveById = new Set(alivePlayers.map((p) => p.playerId));
  const aliveBySeat = new Set(alivePlayers.map((p) => p.seat));
  const isBadgeElection = gameState.phase === "DAY_BADGE_ELECTION";
  const votes = isBadgeElection ? gameState.badge.votes : gameState.votes;
  
  // 警长投票阶段，候选人不参与投票
  const candidates = gameState.badge.candidates || [];
  // PK投票阶段，参与PK的人不能投票
  const pkTargets = gameState.pkSource === "vote" && Array.isArray(gameState.pkTargets) ? gameState.pkTargets : [];
  const eligibleVoters = isBadgeElection 
    ? alivePlayers.filter(p => !candidates.includes(p.seat))
    : alivePlayers.filter(p => !pkTargets.includes(p.seat));
  const totalVoters = eligibleVoters.length;
  const votedCount = eligibleVoters.reduce((count, voter) => {
    return votes[voter.playerId] !== undefined ? count + 1 : count;
  }, 0);
  
  // 获取警长信息（用于计算1.5票）
  const sheriffSeat = gameState.badge.holderSeat;
  const sheriffPlayer = sheriffSeat !== null 
    ? gameState.players.find(p => p.seat === sheriffSeat && p.alive)
    : null;

  // 统计每个目标的票数（考虑警长1.5票权重，仅在非警长选举阶段）
  const voteTargets: Record<number, { voters: Player[], target: Player | undefined, voteCount: number }> = {};
  
  Object.entries(votes).forEach(([voterId, targetSeat]) => {
    if (!aliveById.has(voterId)) return;
    if (!aliveBySeat.has(targetSeat)) return;
    const voter = gameState.players.find(p => p.playerId === voterId);
    const target = gameState.players.find(p => p.seat === targetSeat);
    if (!voter || !target) return;
    
    // 警长的票在非警长选举阶段计算为1.5票
    const voteWeight = (!isBadgeElection && sheriffPlayer && voterId === sheriffPlayer.playerId) ? 1.5 : 1;
    
    if (!voteTargets[targetSeat]) {
      voteTargets[targetSeat] = { voters: [], target, voteCount: 0 };
    }
    if (voter) {
      voteTargets[targetSeat].voters.push(voter);
      voteTargets[targetSeat].voteCount += voteWeight;
    }
  });

  // 按票数排序
  const sortedTargets = Object.entries(voteTargets)
    .sort(([, a], [, b]) => b.voteCount - a.voteCount);

  // 喵杀修复：投票要「盲投 + 同时揭幕」。
  // 原实现会实时渲染每个目标的总票数、以及具体是谁投的 → 而 AI 是先投完的，
  // 等于让玩家看着答案再投（上帝视角）。现在：人类自己投出之前，只显示进度，不显示任何去向。
  const humanId = humanPlayer?.playerId;
  const humanIsEligibleVoter = !!humanId && eligibleVoters.some((p) => p.playerId === humanId);
  const humanHasVoted = !humanId || votes[humanId] !== undefined;
  const showBreakdown = humanHasVoted || !humanIsEligibleVoter;
  // 联机修复（十七轮）：标「(你)」必须按 playerId 比对，不能用 isHuman —— 否则另一位真人在
  // 双方（房主/客人）界面上都会被误标成「你」。
  const isSelf = (p: Player) => !!humanId && p.playerId === humanId;

  return (
    <div className="wc-voting-progress space-y-3">
      {/* 进度条 */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-[var(--color-accent)]"
            initial={{ width: 0 }}
            animate={{ width: `${(votedCount / totalVoters) * 100}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
        <span className="text-xs text-[var(--text-muted)] whitespace-nowrap">
          {votedCount}/{totalVoters} 已投票
        </span>
      </div>

      {/* 投票详情 */}
      <div className="wc-voting-progress-list space-y-2 relative">
        <AnimatePresence mode="popLayout" initial={false}>
          {!showBreakdown ? (
            <motion.div
              key="hidden-until-voted"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center justify-center gap-2 py-3 text-sm text-[var(--text-muted)]"
            >
              <HourglassSimple size={16} className="animate-pulse" />
              你投出后统一公布
            </motion.div>
          ) : sortedTargets.length > 0 ? (
            sortedTargets.map(([targetSeat, { voters, target, voteCount }]) => (
              <motion.div
                layout
                key={targetSeat}
                initial={{ opacity: 0, y: -10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                className="wc-voting-progress-row flex flex-col gap-2 p-2 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border-color)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-[80px]">
                    <span className="text-sm font-bold text-[var(--color-danger)]">
                      {Number(targetSeat) + 1}号
                    </span>
                    <span className="text-xs text-[var(--text-secondary)] truncate max-w-[80px]">
                      {target?.displayName}
                    </span>
                  </div>
                  <motion.span
                    layout
                    className="text-xs font-semibold text-[var(--color-accent)] whitespace-nowrap"
                  >
                    总票数 {voteCount % 1 === 0 ? voteCount : voteCount.toFixed(1)}
                  </motion.span>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <AnimatePresence mode="popLayout">
                    {voters.map((voter) => (
                      <motion.span
                        layout
                        key={voter.playerId}
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded ${
                          isSelf(voter)
                            ? "bg-[var(--color-accent)] text-white font-bold"
                            : "bg-white border border-[var(--border-color)] text-[var(--text-secondary)]"
                        }`}
                      >
                        <CheckCircle size={10} weight="fill" />
                        {voter.seat + 1}号
                      </motion.span>
                    ))}
                  </AnimatePresence>
                </div>
              </motion.div>
            ))
          ) : (
            <motion.div
              key="waiting"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center justify-center gap-2 py-3 text-sm text-[var(--text-muted)]"
            >
              <HourglassSimple size={16} className="animate-pulse" />
              等待投票中...
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 未投票玩家 */}
      {votedCount < totalVoters && votedCount > 0 && (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <span>等待中:</span>
          <div className="flex gap-1 flex-wrap">
            {eligibleVoters
              .filter(p => votes[p.playerId] === undefined)
              .map(p => (
                <span 
                  key={p.playerId} 
                  className={`px-1.5 py-0.5 rounded ${
                    isSelf(p)
                      ? "bg-[var(--color-accent-bg)] text-[var(--color-accent)] font-bold" 
                      : "bg-[var(--bg-hover)]"
                  }`}
                >
                  {p.seat + 1}号{isSelf(p) ? "(你)" : ""}
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
