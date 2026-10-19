"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Microphone, Sparkle } from "@phosphor-icons/react";
import { type Player, type Role, isWolfRole } from "@/types/game";
import { cn } from "@/lib/utils";
import { buildSimpleAvatarUrl, getModelLogoUrl } from "@/lib/avatar-config";

interface PlayerCardCompactProps {
  player: Player;
  isSpeaking: boolean;
  canClick: boolean;
  isSelected: boolean;
  isNight?: boolean;
  isGenshinMode?: boolean;
  onClick: () => void;
  onDetailClick?: () => void;
  animationDelay?: number;
  showWolfBadge?: boolean;
  showRoleBadge?: boolean;
  showModel?: boolean;
  selectionTone?: "wolf" | "seer" | "guard" | "witch" | "hunter" | "badge" | "vote";
  seerCheckResult?: "wolf" | "good" | null;
  humanPlayer?: Player | null;
  isBadgeHolder?: boolean;
  isBadgeCandidate?: boolean;
  variant?: "default" | "mobile";
}

const getRoleLabel = (role: Role) => {
  switch (role) {
    case "Werewolf": return "狼人";
    case "Seer": return "预言家";
    case "Witch": return "女巫";
    case "Hunter": return "猎人";
    case "Guard": return "守卫";
    // 喵杀修复：补上白狼王 / 白痴（原先 default 兜底成「村民」，导致被投出的白狼王显示为村民）
    case "WhiteWolfKing": return "白狼王";
    case "Idiot": return "白痴";
    default: return "村民";
  }
};

const revealedAvatarIds = new Set<string>();

export function PlayerCardCompact({
  player,
  isSpeaking,
  canClick,
  isSelected,
  isNight = false,
  isGenshinMode = false,
  onClick,
  onDetailClick,
  animationDelay = 0,
  showWolfBadge = false,
  showRoleBadge = true,
  showModel = false,
  selectionTone,
  seerCheckResult = null,
  humanPlayer,
  isBadgeHolder = false,
  isBadgeCandidate = false,
  variant = "default",
}: PlayerCardCompactProps) {
  const isDead = !player.alive;
  // 喵杀修复（2026-10-17 · 站长实测）：原实现用 `player.isHuman` 判断「是不是我」——
  // 联机时**每个真人座位都是 isHuman**，于是双方都能看到对方身份（身份徽标 + YOU 标记）。
  // 改为「按座位号判断自己」；没有 humanPlayer 时（观战/无真人）回退到 isHuman。
  const isMe = humanPlayer ? player.seat === humanPlayer.seat : player.isHuman;
  // 喵杀修复（2026-10-17 · 站长实测）：就绪判断原本写的是
  //   `isMe ? !!displayName : !!agentProfile?.persona`
  // 但联机时**朋友那一格 isMe=false**，而真人座位天生没有 agentProfile（那是 AI 专属字段，
  // 见 useGameLogic 里 `agentProfile: undefined`）→ 于是双方互看对方都永远「正在入场」。
  // 正确判据与 DialogArea 一致：真人看昵称，AI 看 persona。
  const isReady = player.isHuman ? !!player.displayName?.trim() : !!player.agentProfile?.persona;
  const hasRevealedAvatar = revealedAvatarIds.has(player.playerId);

  const prevAliveRef = useRef<boolean>(player.alive);
  const [deathPulse, setDeathPulse] = useState(false);
  const [hasRevealed, setHasRevealed] = useState(false);

  useEffect(() => {
    if (isReady && !hasRevealed) {
      setHasRevealed(true);
    }
  }, [isReady, hasRevealed]);

  useEffect(() => {
    if (isReady && !revealedAvatarIds.has(player.playerId)) {
      revealedAvatarIds.add(player.playerId);
    }
  }, [isReady, player.playerId]);

  useEffect(() => {
    const prevAlive = prevAliveRef.current;
    if (prevAlive && !player.alive) {
      queueMicrotask(() => setDeathPulse(true));
      const t = window.setTimeout(() => setDeathPulse(false), 900);
      return () => window.clearTimeout(t);
    }
    prevAliveRef.current = player.alive;
  }, [player.alive]);
  
  // 喵杀修复：白狼王也是狼 —— 原为 role === "Werewolf"，导致白狼王看不到狼队友。
  // 联机修复（十七轮）：排除自己要用 isMe（座位比对），不能用 isHuman ——
  // 否则另一位「人类狼队友」在联机时不会被标成狼队。
  const isWolfTeammate = isWolfRole(humanPlayer?.role) &&
    isWolfRole(player.role) && 
    !isMe;
  const showWolfTeamBadge = isWolfRole(humanPlayer?.role) && isWolfRole(player.role);
  const selectionClass = (() => {
    if (!isSelected) return "";
    switch (selectionTone) {
      case "wolf":
        return "border-[var(--color-blood)] shadow-[0_0_0_2px_var(--color-blood)]";
      case "seer":
        return "border-[var(--color-seer)] shadow-[0_0_0_2px_var(--color-seer)]";
      case "guard":
        return "border-[var(--color-success)] shadow-[0_0_0_2px_var(--color-success)]";
      case "witch":
        return "border-[var(--color-witch)] shadow-[0_0_0_2px_var(--color-witch)]";
      case "hunter":
        return "border-[var(--color-warning)] shadow-[0_0_0_2px_var(--color-warning)]";
      case "badge":
        return "border-[var(--color-gold)] shadow-[0_0_0_2px_rgba(197,160,89,0.25)]";
      case "vote":
        return "border-[var(--color-accent)] shadow-[0_0_0_2px_rgba(120,160,255,0.25)]";
      default:
        return "border-[var(--color-gold)] shadow-[0_0_0_2px_rgba(197,160,89,0.25)]";
    }
  })();

  const persona = player.agentProfile?.persona;
  const styleLabel = isGenshinMode ? (isMe ? "你" : "") : persona?.styleLabel || (isMe ? "你" : "");
  const modelLabel = player.agentProfile?.modelRef?.model;

  const isModelAvatar = isGenshinMode && !player.isHuman;
  const avatarSrc = isModelAvatar
    ? getModelLogoUrl(player.agentProfile?.modelRef)
    : buildSimpleAvatarUrl(player.avatarSeed ?? player.playerId, {
        gender: player.agentProfile?.persona?.gender,
      });
  const avatarClassName = cn(
    "w-full h-full transition-transform duration-500",
    isModelAvatar ? "object-contain p-2 bg-[var(--bg-secondary)]" : "object-cover group-hover:scale-110",
    isSpeaking && "border-[var(--color-gold)]"
  );

  const handleClick = (e: React.MouseEvent) => {
    if (!isReady) return; // Prevent clicking when not ready
    if (canClick) {
      onClick();
    } else if (onDetailClick) {
      onDetailClick();
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={
        deathPulse
          ? {
              opacity: 1,
              y: [0, -2, 0],
              scale: [1, 1.015, 1],
            }
          : { opacity: 1, y: 0 }
      }
      transition={{ delay: animationDelay, duration: 0.3 }}
      whileHover={variant === "mobile" ? {} : {}}
      whileTap={isReady ? { scale: 0.98 } : {}}
      onClick={handleClick}
      className={cn(
        "wc-player-card relative group transition-all duration-300",
        variant === "mobile" && "wc-player-card--mobile",
        !isReady && "wc-player-card--loading opacity-80",
        isReady && "bg-[var(--bg-card)]/80 backdrop-blur-sm",
        isDead && "wc-player-card--dead grayscale-[0.8]",
        isSpeaking && "wc-player-card--speaking ring-1 ring-[var(--color-gold)] shadow-[0_0_15px_rgba(184,134,11,0.15)]",
        isMe && "wc-player-card--me",
        isWolfTeammate && "border-[var(--color-blood)]/70 bg-[var(--color-wolf-bg)]",
        canClick && isReady && "wc-player-card--selectable border-[var(--color-gold)]/50 hover:border-[var(--color-gold)] cursor-pointer",
        // 警徽评选里「可以投」的候选人再加一圈金边，避免玩家点错非候选人还以为卡住了
        isBadgeCandidate && canClick && isReady && "ring-2 ring-[var(--color-gold)]/60",
        isSelected && "scale-[1.02]",
        isSelected && selectionClass
      )}
    >
      {/* Loading Shimmer Effect */}
      {!isReady && (
        <div className="absolute inset-0 overflow-hidden rounded-lg z-0">
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full animate-[shimmer_2s_infinite]" />
          <div className="absolute inset-0 bg-[var(--bg-card)] opacity-50" />
        </div>
      )}
      {!isReady && (
        <motion.div
          className="absolute inset-0 rounded-lg pointer-events-none z-10"
          animate={{ boxShadow: ["inset 0 0 0 rgba(197,160,89,0)", "inset 0 0 18px rgba(197,160,89,0.18)", "inset 0 0 0 rgba(197,160,89,0)"] }}
          transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
        />
      )}

      {/* 头像区域 */}
      <div className="wc-player-card__avatar relative overflow-hidden">
        <AnimatePresence mode="wait">
          {isReady ? (
            <motion.div
              key="avatar-image"
              initial={hasRevealedAvatar ? false : { opacity: 0, scale: 0.8, filter: "blur(8px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              transition={{ duration: 0.5, ease: "easeOut" }}
              className="w-full h-full"
            >
              <img 
                src={avatarSrc} 
                alt={player.displayName} 
                className={avatarClassName} 
              />
            </motion.div>
          ) : (
            <motion.div
              key="avatar-placeholder"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="w-full h-full flex items-center justify-center bg-black/10"
            >
              <div className="relative flex items-center justify-center">
                <motion.div
                  className="absolute inset-0 rounded-full border border-[var(--color-gold)]/25"
                  style={{ width: 46, height: 46 }}
                  animate={{ rotate: 360 }}
                  transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
                />
                <motion.div
                  className="absolute inset-2 rounded-full border border-dashed border-[var(--color-blood)]/30"
                  animate={{ rotate: -360, opacity: [0.4, 0.9, 0.4] }}
                  transition={{ duration: 4.8, repeat: Infinity, ease: "linear" }}
                />
                <div className="absolute inset-0 bg-[var(--color-gold)]/20 blur-xl rounded-full animate-pulse" />
                <Sparkle
                  size={22}
                  weight="fill"
                  className="text-[var(--text-secondary)]/45 animate-[spin_5s_linear_infinite]"
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {isDead && isReady && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[1px] flex items-center justify-center z-10">
            <span className="text-[10px] font-bold text-white tracking-widest border border-white/30 px-2 py-0.5 rounded-sm">RIP</span>
          </div>
        )}
      </div>

      {/* 狼人队友标记 */}
      {showWolfTeamBadge && !isDead && isReady && (
        <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-sm flex items-center justify-center z-10 bg-[var(--color-blood)] text-white border border-black/20 shadow-sm text-[10px] font-semibold tracking-wide">
          狼队
        </div>
      )}

      {/* 预言家查验结果 */}
      {seerCheckResult && !isDead && isReady && (
        <div className={cn(
          "absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-sm flex items-center justify-center z-10 border border-black/20 shadow-sm text-[10px] font-semibold tracking-wide text-white",
          seerCheckResult === 'wolf' ? 'bg-[var(--color-blood)]' : 'bg-[var(--color-success)]'
        )}>
          {seerCheckResult === 'wolf' ? '狼人' : '好人'}
        </div>
      )}

      {/* 警徽标记 */}
      {isBadgeHolder && !isDead && isReady && (
        <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-sm flex items-center justify-center z-10 bg-[var(--color-gold)] border border-black/20 shadow-[0_0_8px_rgba(184,134,11,0.35)] text-[10px] font-semibold tracking-wide text-[var(--bg-dark)]">
          警长
        </div>
      )}
      
      {/* 警长候选人标记（评选/平票重投期间都必须醒目，否则玩家不知道能点谁） */}
      {isBadgeCandidate && !isDead && isReady && (
        <div className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-sm flex items-center justify-center z-10 bg-[var(--color-gold)] border border-black/20 shadow-sm text-[10px] font-semibold tracking-wide text-[var(--bg-dark)]">
          警徽候选
        </div>
      )}

      {/* 自己的身份图标 */}
      {isMe && !isDead && isReady && showRoleBadge && (
        <div className="absolute bottom-0 right-0 px-1.5 py-0.5 rounded-sm flex items-center justify-center z-10 bg-[var(--color-gold)] shadow-sm translate-x-1 translate-y-1 text-[10px] font-bold text-[var(--bg-dark)]">
          {getRoleLabel(player.role)}
        </div>
      )}
      
      {/* 信息区 */}
      <div className="wc-player-card__info relative z-10">
        {variant === "mobile" ? (
          <div className="wc-player-card__name relative flex items-center gap-1 min-w-0" title={player.displayName}>
            <span className={cn(
              "wc-seat-badge transition-colors duration-300",
              isSpeaking ? "bg-[var(--color-gold)] text-[#1a1614]" : "bg-black/10 text-[var(--text-secondary)]",
              !isReady && "opacity-50"
            )}>{player.seat + 1}</span>
            <AnimatePresence mode="wait">
              {isReady ? (
                <motion.span
                  key="name-text"
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="truncate font-medium text-[var(--text-primary)] flex-1 min-w-0"
                >
                  {player.displayName}
                </motion.span>
              ) : (
                <motion.div
                  key="name-loading"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex-1 h-3 flex items-center"
                >
                  <div className="h-2 w-16 bg-[var(--text-secondary)]/10 rounded-full animate-pulse" />
                </motion.div>
              )}
            </AnimatePresence>
            {isMe && isReady && (
              <span className="text-[10px] bg-[var(--color-gold)]/90 text-[#1a1614] px-1.5 rounded-sm font-bold leading-none py-0.5 shadow-sm">YOU</span>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className={cn(
                "wc-seat-badge transition-colors duration-300",
                isSpeaking ? "bg-[var(--color-gold)] text-[#1a1614]" : "bg-black/10 text-[var(--text-secondary)]",
                !isReady && "opacity-50"
              )}>{player.seat + 1}</span>
              {isMe && isReady && (
                <span className="text-[10px] bg-[var(--color-gold)]/90 text-[#1a1614] px-1.5 rounded-sm font-bold leading-none py-0.5 shadow-sm">YOU</span>
              )}
            </div>

            <div className="wc-player-card__name relative h-5" title={player.displayName}>
              <AnimatePresence mode="wait">
                {isReady ? (
                  <motion.span
                    key="name-text"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="block truncate font-medium text-[var(--text-primary)]"
                  >
                    {player.displayName}
                  </motion.span>
                ) : (
                  <motion.div
                    key="name-loading"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="h-full flex items-center"
                  >
                    <div className="h-2 w-16 bg-[var(--text-secondary)]/10 rounded-full animate-pulse" />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </>
        )}

        <div className="wc-player-card__meta min-h-[1.25rem] space-y-0.5">
          {isReady && styleLabel && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              <span className={cn(
                "text-xs",
                isSpeaking ? "text-[var(--color-gold)]" : "text-[var(--text-secondary)]"
              )}>{styleLabel}</span>
            </motion.div>
          )}
          {isReady && showModel && modelLabel && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.25 }}
              className="text-[10px] text-[var(--text-muted)] truncate"
              title={modelLabel}
            >
              {modelLabel}
            </motion.div>
          )}
          {!isReady && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: [0.4, 0.9, 0.4] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
              className="text-[var(--text-muted)] text-xs flex items-center gap-1"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-gold)]/60" />
              正在入场
            </motion.div>
          )}
        </div>
      </div>
      
      
      {/* 边框高亮流光 (Highlight border on ready) */}
      <AnimatePresence>
        {isReady && !hasRevealed && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 1 } }}
            className="absolute inset-0 rounded-lg pointer-events-none z-30"
            style={{
              boxShadow: "inset 0 0 20px rgba(184,134,11,0.3), 0 0 10px rgba(184,134,11,0.2)"
            }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
