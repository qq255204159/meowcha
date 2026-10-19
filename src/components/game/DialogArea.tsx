"use client";

import React, { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatCircleDots, PaperPlaneTilt, CheckCircle, MoonStars, Eye, Drop, Crosshair, Skull, X, ArrowClockwise, CaretRight, UserCircle, Prohibit } from "@phosphor-icons/react";
import { WerewolfIcon, VillagerIcon, VoteIcon } from "@/components/icons/FlatIcons";
import { VotingProgress } from "./VotingProgress";
import { WolfPlanningPanel } from "./WolfPlanningPanel";
import { MentionInput } from "./MentionInput";
import { TalkingAvatar } from "./TalkingAvatar";
import { VoiceRecorder, type VoiceRecorderHandle } from "./VoiceRecorder";
import { buildSimpleAvatarUrl, getModelLogoUrl } from "@/lib/avatar-config";
import { VoteResultCard } from "./VoteResultCard";
import LoadingMiniGame from "./MiniGame/LoadingMiniGame";
import { type GameState, type Player, type ChatMessage, isWolfRole } from "@/types/game";
import { cn } from "@/lib/utils";
import { audioManager, makeAudioTaskId } from "@/lib/audio-manager";
import { resolveVoiceId } from "@/lib/voice-constants";

type WitchActionType = "save" | "poison" | "pass";
import type { DialogueState } from "@/store/game-machine";

// 喵杀（第十二·五轮）：上游的「夜晚职业立绘」整块移除。
// 原因是它把中文路径 `/职业/狼人.png` 直接当 <img src>（缺 basePath `/meowcha` → 站内 404），
// 图片加载失败时浏览器就回退显示 alt 文本 —— 于是夜间行动框里出现「Werewolf / Seer / Witch …」
// 一类的英文角色名 + 一张破图。夜间行动阶段现直接回落到「当前行动者头像」（见下方 portraitNode）。

const getPlayerAvatarUrl = (player: Player, isGenshinMode: boolean) =>
  isGenshinMode && !player.isHuman
    ? getModelLogoUrl(player.agentProfile?.modelRef)
    : buildSimpleAvatarUrl(player.avatarSeed ?? player.playerId, {
        gender: player.agentProfile?.persona?.gender,
      });

function isTurnPromptSystemMessage(content: string) {
  return content.includes("轮到你发言") || content.includes("轮到你发表遗言");
}

// 将消息中的"@X号 玩家名"或"X号"渲染为小标签
function renderPlayerMentions(
  text: string,
  players: Player[],
  isNight: boolean = false,
  isGenshinMode: boolean = false
): React.ReactNode {
  // Only match @X号 or X号 pattern, don't consume any text after it
  // This prevents truncating content that follows the mention
  const regex = /@?(\d{1,2})号/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const seatNum = parseInt(match[1], 10);
    const player = players.find(p => p.seat + 1 === seatNum);
    
    // 添加匹配前的文本
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    
    // 添加标签
    if (player) {
      const isPlayerReady = player.isHuman ? !!player.displayName?.trim() : !!player.agentProfile?.persona;
      parts.push(
        <span
          key={`${match.index}-${seatNum}`}
          className={`inline-flex items-center gap-1 mx-0.5 align-baseline text-[0.85em] font-semibold ${
            isNight
              ? "text-[var(--color-accent-light)]"
              : "text-[var(--color-accent)]"
          }`}
        >
          {isPlayerReady ? (
            <img
              src={getPlayerAvatarUrl(player, isGenshinMode)}
              alt={player.displayName}
              className="w-4 h-4 rounded-full"
            />
          ) : (
            <span className="w-4 h-4 rounded-full bg-black/10" aria-hidden="true" />
          )}
          <span className={isNight ? "text-[var(--color-accent-light)]" : "text-[var(--color-accent)]"}>@{seatNum}号</span>
        </span>
      );
    } else {
      // 没找到对应玩家，保持原样但格式化
      parts.push(
        <span
          key={`${match.index}-${seatNum}`}
          className={`inline-flex items-center mx-0.5 align-baseline text-[0.85em] font-semibold ${
            isNight
              ? "text-[var(--color-accent-light)]"
              : "text-[var(--color-accent)]"
          }`}
        >
          @{seatNum}号
        </span>
      );
    }
    
    lastIndex = regex.lastIndex;
  }
  
  // 添加剩余文本
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  
  return parts.length > 0 ? parts : text;
}

interface DialogAreaProps {
  gameState: GameState;
  humanPlayer: Player | null;
  isNight?: boolean;
  isSoundEnabled?: boolean;
  isAiVoiceEnabled?: boolean;
  currentDialogue: DialogueState | null;
  displayedText: string;
  isTyping: boolean;
  showFullHistory?: boolean;
  onAdvanceDialogue?: () => void;
  isHumanTurn?: boolean; // 是否轮到人类发言
  waitingForNextRound?: boolean; // 是否等待下一轮
  /**
   * 喵杀（十七轮）：联机「各自按历史读」时，本机已经读到最新（日志上还没有更后面的内容）——
   * 此时不该再提示「点击/按 Enter 继续」（点了确实推进不了什么），由调用方置 true。
   */
  suppressManualContinue?: boolean;
  /**
   * 喵杀（十七轮 · 站长实测）：只显示「本机已经读到」的那一部分消息（原始消息数组的下标上界，含）。
   * 联机时朋友可能比你读得快、房主引擎也会跑在前面 —— 如果不截断，中间对话区会把还没轮到你读的
   * 台词一股脑全铺出来（站长反馈）。传 undefined = 不截断（单机沿用旧行为）。
   */
  revealUpToCount?: number;
  tutorialHelpLabel?: string;
  showTutorialHelp?: boolean;
  onTutorialOpen?: () => void;
  // 输入相关
  inputText?: string;
  onInputChange?: (text: string) => void;
  onSendMessage?: () => void;
  onFinishSpeaking?: () => void;
  // 操作相关 (从 BottomActionPanel 合并)
  selectedSeat?: number | null;
  isWaitingForAI?: boolean;
  onConfirmAction?: () => void;
  onCancelSelection?: () => void;
  onNightAction?: (seat: number, actionType?: WitchActionType) => void;
  onBadgeSignup?: (wants: boolean) => void;
  onRestart?: () => void;
  onShowAnalysis?: () => void;
  isAnalysisLoading?: boolean;
}

// 等待状态动画组件已移除，与当前简洁风格不符

// 夜晚行动状态组件 - 带有神秘氛围
// Note: Guard phase does not use this component - it uses the regular dialogue block instead
function NightActionStatus({ phase, humanRole }: { phase: string; humanRole?: string }) {
  // Guard phase: don't show any status animation, let dialogue block handle it
  if (phase === "NIGHT_GUARD_ACTION") {
    return null;
  }

  const getStatusInfo = () => {
    // 如果是人类玩家的回合，显示"请睁眼"；否则显示"正在行动"
    const isMyPhase = 
      (phase === "NIGHT_WOLF_ACTION" && isWolfRole(humanRole)) ||
      (phase === "NIGHT_WITCH_ACTION" && humanRole === "Witch") ||
      (phase === "NIGHT_SEER_ACTION" && humanRole === "Seer") ||
      (phase === "HUNTER_SHOOT" && humanRole === "Hunter");
    
    switch (phase) {
      case "NIGHT_WOLF_ACTION":
        return { icon: WerewolfIcon, text: isMyPhase ? "狼人请睁眼" : "狼人正在选择目标", color: "text-red-500" };
      case "NIGHT_WITCH_ACTION":
        return { icon: Drop, text: isMyPhase ? "女巫请睁眼" : "女巫正在行动", color: "text-purple-500" };
      case "NIGHT_SEER_ACTION":
        return { icon: Eye, text: isMyPhase ? "预言家请睁眼" : "预言家正在查验", color: "text-blue-500" };
      case "HUNTER_SHOOT":
        return { icon: Crosshair, text: isMyPhase ? "猎人发动技能" : "猎人正在开枪", color: "text-orange-500" };
      default:
        return { icon: null, text: "", color: "" };
    }
  };

  const { icon: Icon, text, color } = getStatusInfo();

  if (!text) {
    return null;
  }

  return (
    <div className="flex flex-col items-center justify-center py-6">
      {/* 神秘光球效果 */}
      {Icon && (
        <div className="relative mb-4">
          <motion.div
            className={`absolute inset-0 rounded-full blur-xl opacity-30 ${color.replace('text-', 'bg-')}`}
            animate={{ scale: [1, 1.3, 1], opacity: [0.2, 0.4, 0.2] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            className={`relative w-16 h-16 rounded-full flex items-center justify-center ${color.replace('text-', 'bg-')}/10 border-2 ${color.replace('text-', 'border-')}/30`}
            animate={{ rotate: [0, 5, -5, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          >
            <Icon size={28} className={color} weight="fill" />
          </motion.div>
        </div>
      )}
      
      {/* 状态文字 */}
      <div className={`flex items-center text-base font-medium ${color}`}>
        <span>{text}</span>
      </div>
      
      {/* 装饰性星星 */}
      <div className="flex gap-3 mt-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <motion.div
            key={i}
            className="w-1 h-1 rounded-full bg-current opacity-30"
            animate={{ opacity: [0.1, 0.5, 0.1], scale: [0.8, 1.2, 0.8] }}
            transition={{ duration: 2, repeat: Infinity, delay: i * 0.3 }}
          />
        ))}
      </div>
    </div>
  );
}

export function DialogArea({
  gameState,
  humanPlayer,
  isNight = false,
  isSoundEnabled = true,
  isAiVoiceEnabled = true,
  currentDialogue,
  displayedText,
  isTyping,
  onAdvanceDialogue,
  isHumanTurn = false,
  waitingForNextRound = false,
  suppressManualContinue = false,
  revealUpToCount,
  tutorialHelpLabel,
  showTutorialHelp = false,
  onTutorialOpen,
  inputText = "",
  onInputChange,
  onSendMessage,
  onFinishSpeaking,
  // 操作相关
  selectedSeat = null,
  isWaitingForAI = false,
  onConfirmAction,
  onCancelSelection,
  onNightAction,
  onBadgeSignup,
  onRestart,
  onShowAnalysis,
  isAnalysisLoading,
}: DialogAreaProps) {
  const isGenshinMode = !!gameState.isGenshinMode;
  const phase = gameState.phase;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const lastPortraitPlayerRef = useRef<Player | null>(null);
  const voiceRecorderRef = useRef<VoiceRecorderHandle | null>(null);

  const [talkingPlayerId, setTalkingPlayerId] = useState<string | null>(null);

  // 初始化音频管理器
  useEffect(() => {
    audioManager.setCallbacks(
      (playerId) => setTalkingPlayerId(playerId),
      () => setTalkingPlayerId(null)
    );
    return () => audioManager.clearQueue();
  }, []);

  // 语音播放跟随消息框（currentDialogue），而不是消息记录（messages）
  const lastQueuedAudioIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentDialogue) {
      lastQueuedAudioIdRef.current = null;
      return;
    }
    if (!currentDialogue.isStreaming) return;
    if (!isSoundEnabled || !isAiVoiceEnabled) return;

    const player = gameState.players.find((p) => p.displayName === currentDialogue.speaker);
    if (!player) return;
    if (player.playerId === humanPlayer?.playerId) return;

    const text = currentDialogue.text;
    if (!text || !text.trim()) return;
    // “思考中”阶段不播
    if (text.includes("正在组织语言") || text.includes("生成语音")) return;

    const voiceId = resolveVoiceId(
      player.agentProfile?.persona?.voiceId,
      player.agentProfile?.persona?.gender,
      player.agentProfile?.persona?.age
    );

    // 喵杀（十七轮）：本 effect 的依赖里有 gameState.players（每轮下发都是新对象）→ 同一句会被
    // 反复触发；audioManager 只对「队列中/正在播」去重，播完后重复入队就会**重播上一句**。
    // 这里再兜一层：同一句只入队一次，直到 dialogue 换成别的句子为止。
    const taskId = makeAudioTaskId(voiceId, text);
    if (lastQueuedAudioIdRef.current === taskId) return;
    lastQueuedAudioIdRef.current = taskId;

    audioManager.addToQueue({
      id: taskId,
      text,
      playerId: player.playerId,
      voiceId,
    });
  }, [currentDialogue, gameState.players, humanPlayer?.playerId, isSoundEnabled, isAiVoiceEnabled]);

  // 处理跳过/继续：截断语音并进入下一句
  const handleAdvance = useCallback(() => {
    audioManager.stopCurrent();
    onAdvanceDialogue?.();
  }, [onAdvanceDialogue]);

  const handleFinishSpeaking = useCallback(() => {
    if (inputText?.trim()) {
      onSendMessage?.();
    }
    onFinishSpeaking?.();
  }, [inputText, onSendMessage, onFinishSpeaking]);

  // 跳过/继续逻辑由 page.tsx 的全局按键处理负责（同时截断语音）

  // 判断是否需要用户手动点击/按键继续（而非自动过场）
  const needsManualContinue = useMemo(() => {
    // 正在组织语言时不需要手动继续
    const dialogueText = currentDialogue?.text || "";
    if (dialogueText.includes("正在组织语言") || dialogueText.includes("生成语音")) {
      return false;
    }
    // 联机时本机已读到最新（没有更后面的内容可推）→ 不提示「继续」
    if (suppressManualContinue) {
      return false;
    }
    // 发言阶段需要手动继续
    if (["DAY_SPEECH", "DAY_LAST_WORDS", "DAY_BADGE_SPEECH", "DAY_PK_SPEECH"].includes(phase)) {
      return true;
    }
    // 等待下一轮时需要手动继续
    if (waitingForNextRound) {
      return true;
    }
    // 预言家查验完成后需要手动确认（人类是预言家）
    if (phase === "NIGHT_SEER_ACTION" && humanPlayer?.role === "Seer" && gameState.nightActions.seerTarget !== undefined) {
      return true;
    }
    return false;
  }, [phase, waitingForNextRound, humanPlayer?.role, gameState.nightActions.seerTarget, currentDialogue?.text, suppressManualContinue]);

  const visibleMessages = useMemo(() => {
    // 联机：只露出「本机读到的位置」之前的消息（读一句才显示一句，未读的留在后台）
    const source =
      typeof revealUpToCount === "number"
        ? gameState.messages.slice(0, Math.max(0, revealUpToCount))
        : gameState.messages;
    return source.filter(
      (m) => {
        if (!m.isSystem) return true;
        if (isTurnPromptSystemMessage(m.content)) return false;
        // 喵杀修复：原先这里把 [VOTE_RESULT] 一起过滤掉了 → DialogArea 里那个
        // VoteResultCard 的渲染分支（见本文件 "投票结果消息" 处）成了死代码，
        // 玩家投票后根本看不到「谁投了谁」。现在只过滤 [ROLE_REVEAL]（它由专门的翻牌浮层展示），
        // 让 [VOTE_RESULT] 正常渲染成票型卡片。
        if (typeof m.content === "string" && m.content.startsWith("[ROLE_REVEAL]")) return false;
        return true;
      }
    );
  }, [gameState.messages, revealUpToCount]);

  // 获取当前发言者信息
  const currentSpeaker = useMemo(() => {
    if (isHumanTurn && humanPlayer) {
      return {
        player: humanPlayer,
        text: "",
        isStreaming: false,
      };
    }
    if (currentDialogue) {
      const player = gameState.players.find(p => p.displayName === currentDialogue.speaker);
      return {
        player,
        text: currentDialogue.isStreaming ? displayedText : currentDialogue.text,
        isStreaming: true,
      };
    }
    // 找最后一条非系统消息
    const lastMsg = [...visibleMessages].reverse().find(m => !m.isSystem);
    if (lastMsg) {
      const player = gameState.players.find(p => p.playerId === lastMsg.playerId);
      return {
        player,
        text: lastMsg.content,
        isStreaming: false,
      };
    }
    return null;
  }, [isHumanTurn, humanPlayer, currentDialogue, displayedText, visibleMessages, gameState.players]);

  const portraitPlayer = useMemo(() => {
    // 喵杀修复（2026-10-18 · 站长实测）：夜晚不再沿用上一位（通常是遗言者）的立绘。
    // 夜晚有独立的行动面板；这里返回 null，同时下面会清掉 lastPortraitPlayerRef。
    if (phase.startsWith("NIGHT") || phase === "DAY_VOTE" || phase === "DAY_RESOLVE") {
      return null;
    }
    if (isHumanTurn && humanPlayer) return humanPlayer;
    // 喵杀（十七轮）：优先跟随「当前这条台词」的说话人 —— 联机客人是按自己的阅读指针逐句读的，
    // 其 gameState.currentSpeakerSeat 是房主的进度（可能领先），照它渲染会出现头像与台词对不上。
    if (currentSpeaker?.player) return currentSpeaker.player;
    if (typeof gameState.currentSpeakerSeat === "number") {
      return gameState.players.find((p) => p.seat === gameState.currentSpeakerSeat) || null;
    }
    return null;
  }, [isHumanTurn, humanPlayer, phase, gameState.currentSpeakerSeat, gameState.players, currentSpeaker?.player?.playerId]);

  useEffect(() => {
    if (portraitPlayer) lastPortraitPlayerRef.current = portraitPlayer;
  }, [portraitPlayer?.playerId]);

  useEffect(() => {
    if (
      phase.startsWith("NIGHT") ||
      phase === "DAY_VOTE" ||
      phase === "DAY_RESOLVE" ||
      phase === "GAME_END"
    ) {
      lastPortraitPlayerRef.current = null;
    }
  }, [phase]);

  // 喵杀修复（2026-10-17 · 站长实测）：入夜后**清掉残留头像**。
  // 原来 `portraitPlayer || lastPortraitPlayerRef.current` 会把「上一位发言者（含遗言）」的头像
  // 一直钉在对话框上，直到第二天白天有人开口才换掉 —— 夜晚本无发言人，却挂着遗言头像，不合理。
  // 2026-10-18 补充：只有「发言类」阶段才保留上一位头像；
  // 投票/结算/天亮/入夜都不该继续挂着上一位（通常是死者）的头像。
  const canKeepLastPortrait = [
    "DAY_SPEECH",
    "DAY_BADGE_SPEECH",
    "DAY_PK_SPEECH",
    "DAY_LAST_WORDS",
  ].includes(phase);
  const stablePortraitPlayer =
    portraitPlayer || (canKeepLastPortrait ? lastPortraitPlayerRef.current : null);

  const portraitNode = (
    <AnimatePresence mode="wait" initial={false}>
      {(() => {
        // 非夜晚行动阶段或白天：显示玩家头像
        if (stablePortraitPlayer) {
          return (
            <motion.div
              key={stablePortraitPlayer.playerId}
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, filter: "blur(4px)" }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="relative flex flex-col items-center"
            >
              {/* 光晕效果 */}
              <div className="absolute bottom-[20%] left-1/2 -translate-x-1/2 w-40 h-40 bg-gradient-radial from-[var(--color-accent)]/20 via-transparent to-transparent rounded-full blur-2xl" />
              
              {/* 立绘图片 - 只在字幕播放中时有嘴型动画 */}
              <TalkingAvatar
                seed={stablePortraitPlayer.avatarSeed ?? stablePortraitPlayer.playerId}
                gender={stablePortraitPlayer.agentProfile?.persona?.gender}
                modelRef={stablePortraitPlayer.agentProfile?.modelRef}
                useModelLogo={isGenshinMode && !stablePortraitPlayer.isHuman}
                isTalking={talkingPlayerId === stablePortraitPlayer.playerId || (isTyping && !talkingPlayerId)}
                alt={stablePortraitPlayer.displayName}
                className="relative z-10 w-[220px] lg:w-[260px] xl:w-[300px] h-auto object-contain"
                scale={120}
                translateY={-5}
              />
            </motion.div>
          );
        }
        
        return (
          <motion.div
            key="empty-portrait"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.3 }}
            className="flex items-end justify-center h-full pb-6"
          >
            {isNight ? (
              <MoonStars size={64} className="opacity-20 text-[var(--text-primary)]" />
            ) : (
              <ChatCircleDots size={64} className="opacity-15" />
            )}
          </motion.div>
        );
      })()}
    </AnimatePresence>
  );

  // 智能滚动逻辑
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const prevMessageCountRef = useRef(visibleMessages.length);
  const scrollThreshold = 100; // 距离底部多少像素算"在底部"
  const isAutoScrollingRef = useRef(false);
  const userScrollTimeoutRef = useRef<number | null>(null);
  const isUserScrollingRef = useRef(false);

  // 检测用户是否在底部
  const checkIfAtBottom = useCallback(() => {
    if (historyRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = historyRef.current;
      const nearBottom = scrollHeight - scrollTop - clientHeight < scrollThreshold;
      setIsAtBottom(nearBottom);
      if (nearBottom) {
        setUnreadCount(0);
      }
    }
  }, []);

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    if (historyRef.current) {
      const container = historyRef.current;
      
      isAutoScrollingRef.current = true;
      // 先立即滚动到底部
      container.scrollTo({
        top: container.scrollHeight,
        behavior: "smooth",
      });
      
      setUnreadCount(0);
      
      // 等待滚动动画完成后再次确认位置并设置状态
      setTimeout(() => {
        if (container) {
          container.scrollTop = container.scrollHeight;
          setIsAtBottom(true);
        }
        isAutoScrollingRef.current = false;
      }, 300); // 等待平滑滚动动画完成
    }
  }, []);

  // 监听滚动事件
  useEffect(() => {
    const container = historyRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (isAutoScrollingRef.current) {
        checkIfAtBottom();
        return;
      }

      isUserScrollingRef.current = true;
      if (userScrollTimeoutRef.current) {
        window.clearTimeout(userScrollTimeoutRef.current);
      }
      userScrollTimeoutRef.current = window.setTimeout(() => {
        isUserScrollingRef.current = false;
      }, 140);
      checkIfAtBottom();
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [checkIfAtBottom]);

  // 处理新消息到来
  useEffect(() => {
    const newCount = visibleMessages.length;
    const prevCount = prevMessageCountRef.current;
    
    if (newCount > prevCount) {
      const addedCount = newCount - prevCount;
      
      if (isAtBottom && !isUserScrollingRef.current) {
        // 用户在底部，自动滚动
        requestAnimationFrame(() => {
          if (historyRef.current) {
            isAutoScrollingRef.current = true;
            historyRef.current.scrollTop = historyRef.current.scrollHeight;
            window.setTimeout(() => {
              isAutoScrollingRef.current = false;
            }, 120);
          }
        });
      } else {
        // 用户在查看历史，累加未读数
        setUnreadCount((prev) => prev + addedCount);
      }
    }
    
    prevMessageCountRef.current = newCount;
  }, [visibleMessages.length, isAtBottom]);

  // 对话内容更新时也检查是否需要滚动
  useEffect(() => {
    if (isAtBottom && historyRef.current && !isUserScrollingRef.current) {
      isAutoScrollingRef.current = true;
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
      window.setTimeout(() => {
        isAutoScrollingRef.current = false;
      }, 120);
    }
  }, [displayedText, isAtBottom]);

  // 喵杀（2026-10-17 · 站长实测）：人类白狼王自爆入口提示（白天发言阶段、技能未用、未选目标时）
  // ⚠️ 这段必须放在下面「空状态」早退**之前** —— 否则开局（消息出现、早退不再命中）时
  // Hook 数量会突增，触发 React #310「Rendered more hooks than during the previous render」（房主开局崩溃的根因）。
  const showWWKBoomHint =
    (phase === "DAY_SPEECH" || phase === "DAY_PK_SPEECH") &&
    humanPlayer?.role === "WhiteWolfKing" &&
    humanPlayer?.alive &&
    !gameState.roleAbilities.whiteWolfKingBoomUsed &&
    selectedSeat === null;
  // 白狼王提示不再常驻对话框：出现 6 秒后自动消失，且本局不再出现。
  const [wwkHintDismissed, setWwkHintDismissed] = useState(false);
  useEffect(() => {
    if (!showWWKBoomHint || wwkHintDismissed) return;
    const t = setTimeout(() => setWwkHintDismissed(true), 6000);
    return () => clearTimeout(t);
  }, [showWWKBoomHint, wwkHintDismissed]);

  // 空状态
  if (gameState.messages.length === 0 && !currentDialogue) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center text-[var(--text-muted)]">
        <div className="relative flex flex-col items-center">
          <div className="relative mb-6">
            <motion.div
              className="absolute inset-0 rounded-full border border-[var(--color-gold)]/20"
              style={{ width: 180, height: 180 }}
              animate={{ rotate: 360 }}
              transition={{ duration: 18, repeat: Infinity, ease: "linear" }}
            />
            <motion.div
              className="absolute inset-5 rounded-full border border-dashed border-[var(--color-blood)]/30"
              animate={{ rotate: -360, opacity: [0.4, 0.8, 0.4] }}
              transition={{ duration: 14, repeat: Infinity, ease: "linear" }}
            />
            <motion.div
              className="absolute inset-10 rounded-full border border-[var(--color-gold)]/20"
              animate={{ scale: [0.96, 1.04, 0.96], opacity: [0.35, 0.7, 0.35] }}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
              className="relative flex items-center justify-center rounded-full"
              style={{ width: 180, height: 180 }}
              animate={{ y: [0, -6, 0] }}
              transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
            >
              <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_center,rgba(197,160,89,0.12),rgba(0,0,0,0)_70%)]" />
              <WerewolfIcon size={56} className="text-[var(--color-gold)]/60 drop-shadow-[0_0_18px_rgba(197,160,89,0.3)]" />
            </motion.div>
          </div>
          <motion.div
            className="flex flex-col items-center gap-2"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            <div className="text-sm font-serif tracking-[0.2em] text-[var(--color-gold)]/80 uppercase">
              Summoning
            </div>
            <div className="text-base font-semibold text-[var(--text-primary)]/85">
              玩家们正在入场...
            </div>
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <motion.span
                className="inline-block w-2 h-2 rounded-full bg-[var(--color-gold)]/60"
                animate={{ scale: [1, 1.4, 1], opacity: [0.4, 0.9, 0.4] }}
                transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
              />
              <span>正在召集同伴</span>
            </div>
            <div className="mt-4">
              <LoadingMiniGame />
            </div>
          </motion.div>
        </div>
      </div>
    );
  }

  // 获取角色中文名
  const getRoleName = (role?: string) => {
    switch (role) {
      case "Werewolf": return "狼人";
      case "Seer": return "预言家";
      case "Witch": return "女巫";
      case "Hunter": return "猎人";
      case "Guard": return "守卫";
      // 喵杀修复：补上白狼王 / 白痴；并把 default 从「村民」改成原样返回，避免未知角色被误标成村民
      case "WhiteWolfKing": return "白狼王";
      case "Idiot": return "白痴";
      default: return role ?? "";
    }
  };

  const dialogueText = (displayedText || currentSpeaker?.text || "").trim();
  const shouldShowDialogue = waitingForNextRound || dialogueText.length > 0;
  const isNightActionPhase = [
    "NIGHT_GUARD_ACTION",
    "NIGHT_WOLF_ACTION",
    "NIGHT_WITCH_ACTION",
    "NIGHT_SEER_ACTION",
  ].includes(phase);

  const showGameEnd = phase === "GAME_END";
  const showBadgeSignup = phase === "DAY_BADGE_SIGNUP"
    && humanPlayer?.alive
    && typeof gameState.badge.signup?.[humanPlayer.playerId] !== "boolean";
  const showBadgeTransferOption = phase === "BADGE_TRANSFER"
    && humanPlayer
    && gameState.badge.holderSeat === humanPlayer.seat
    && selectedSeat === null;
  const showActionConfirm = (() => {
    const badgeCandidates = gameState.badge.candidates || [];
    const humanIsCandidate = humanPlayer && badgeCandidates.includes(humanPlayer.seat);

    const isCorrectRoleForPhase =
      (phase === "DAY_VOTE" && humanPlayer?.alive) ||
      (phase === "DAY_BADGE_ELECTION" && humanPlayer?.alive && !humanIsCandidate) ||
      (phase === "NIGHT_SEER_ACTION" && humanPlayer?.role === "Seer" && humanPlayer?.alive && gameState.nightActions.seerTarget === undefined) ||
      (phase === "NIGHT_WOLF_ACTION" && isWolfRole(humanPlayer?.role) && humanPlayer?.alive) ||
      (phase === "NIGHT_GUARD_ACTION" && humanPlayer?.role === "Guard" && humanPlayer?.alive) ||
      (phase === "HUNTER_SHOOT" && humanPlayer?.role === "Hunter") ||
      // 喵杀（2026-10-17）：人类白狼王在白天发言阶段可点选「自爆带走」的目标
      ((phase === "DAY_SPEECH" || phase === "DAY_PK_SPEECH") &&
        humanPlayer?.role === "WhiteWolfKing" &&
        humanPlayer?.alive &&
        !gameState.roleAbilities.whiteWolfKingBoomUsed) ||
      (phase === "BADGE_TRANSFER" && humanPlayer && gameState.badge.holderSeat === humanPlayer.seat);

    const isWWKDayPhase =
      (phase === "DAY_SPEECH" || phase === "DAY_PK_SPEECH") && humanPlayer?.role === "WhiteWolfKing";

    return Boolean(
      isCorrectRoleForPhase
        && selectedSeat !== null
        && (phase === "DAY_VOTE" || phase === "DAY_BADGE_ELECTION" || phase === "BADGE_TRANSFER" || isWWKDayPhase || !isWaitingForAI)
    );
  })();
  const showWitchPanel = phase === "NIGHT_WITCH_ACTION" && humanPlayer?.role === "Witch" && !isWaitingForAI;
  // （白狼王提示与其状态已上移至「空状态」早退之前，修复 React #310 条件式 Hook 崩溃）
  // 喵杀（2026-10-17）：人类猎人「不开枪」选项（与「确认开枪」并列，不选目标也能直接放弃）
  const showHunterNoShoot = phase === "HUNTER_SHOOT" && humanPlayer?.role === "Hunter";
  const showHumanInput = isHumanTurn && phase !== "GAME_END" && phase !== "DAY_BADGE_SIGNUP";
  const showDialogueBlock = !isHumanTurn
    && (currentSpeaker || waitingForNextRound)
    && shouldShowDialogue
    && phase !== "GAME_END"
    && !phase.startsWith("NIGHT")
    && selectedSeat === null
    && !(phase === "NIGHT_WITCH_ACTION" && humanPlayer?.role === "Witch" && !isWaitingForAI);
  const showNightWaiting = !isHumanTurn
    && !currentSpeaker
    && !waitingForNextRound
    && isNightActionPhase
    && phase !== "GAME_END"
    && selectedSeat === null
    && !(phase === "NIGHT_WITCH_ACTION" && humanPlayer?.role === "Witch" && !isWaitingForAI);

  // 夜色阶段提示（2026-10-19）：日→夜过渡 / 非行动夜间阶段（NIGHT_START、白狼王自爆过渡等）也给一条
  // 可读反馈，避免（尤其联机客人端）在「自爆 → 直接入夜」这类跳转后，对话区一片空白、看起来像卡住。
  const isNightishPhase = phase.startsWith("NIGHT") || phase === "WHITE_WOLF_KING_BOOM";
  const nightStageText = isNightishPhase
    ? (() => {
        const last = [...gameState.messages]
          .reverse()
          .find((m) => m.isSystem && String(m.content || "").trim() && !String(m.content || "").startsWith("["));
        return last ? String(last.content) : "";
      })()
    : "";
  const showNightStageHint =
    isNightishPhase
    && !isHumanTurn
    && !showGameEnd
    && selectedSeat === null
    && !showNightWaiting
    && !showWitchPanel
    && !currentSpeaker;

  const shouldShowDialogPanel = showGameEnd
    || showBadgeSignup
    || showBadgeTransferOption
    || showActionConfirm
    || showWitchPanel
    || showWWKBoomHint
    || showHunterNoShoot
    || showHumanInput
    || showDialogueBlock
    || showNightWaiting
    || showNightStageHint;

  const seerChecks = humanPlayer?.role === "Seer"
    ? (gameState.nightActions.seerHistory || [])
    : [];
  const seerCheckText = seerChecks
    .slice(-2)
    .map((check) => {
      const target = gameState.players.find((p) => p.seat === check.targetSeat);
      return `第${check.day}夜 ${check.targetSeat + 1}号 ${target?.displayName || ""} = ${check.isWolf ? "狼人" : "好人"}`;
    })
    .join("；");
  const showSeerCheck =
    humanPlayer?.role === "Seer" &&
    !!humanPlayer.alive &&
    phase.startsWith("DAY") &&
    seerCheckText.length > 0;

  return (
    <div className="wc-dialog-area h-full w-full flex flex-col min-h-0 justify-start">
      {showSeerCheck && (
        <div className="mx-4 mt-2 shrink-0 rounded-lg border border-[var(--color-gold)]/25 bg-[var(--color-gold)]/5 px-3 py-2 text-xs leading-relaxed text-[var(--text-secondary)]">
          <span className="font-semibold text-[var(--color-gold)]">你的查验：</span>
          {seerCheckText}
        </div>
      )}
      {/* 上方区域：左侧立绘 + 右侧历史记录 */}
      <div className="flex-1 min-h-0 w-full -mb-1">
        <div className="wc-dialog-main flex gap-4 lg:gap-6 px-4 lg:px-6 pt-0 pb-0 min-h-0 h-full items-stretch">
          {/* 左侧立绘区域 */}
          <div className="wc-dialog-portrait hidden md:flex w-[220px] lg:w-[260px] xl:w-[300px] shrink-0 flex-col items-center justify-end">
            {portraitNode}
          </div>

          {/* 右侧：聊天历史记录 */}
          <div className="wc-dialog-history flex-1 min-w-0 min-h-0 relative">
            <div 
              ref={historyRef}
              className="absolute inset-0 overflow-y-auto pb-4"
            >
              {visibleMessages.map((msg, index) => {
                const prevMsg = visibleMessages[index - 1];
                const showDivider = index > 0 && !msg.isSystem && !prevMsg?.isSystem && prevMsg?.playerId !== msg.playerId;
                return (
                  <ChatMessageItem 
                    key={msg.id || `${msg.playerId}:${msg.timestamp}:${index}`} 
                    msg={msg} 
                    players={gameState.players}
                    humanPlayerId={humanPlayer?.playerId}
                    showDivider={showDivider}
                    isNight={isNight}
                    isGenshinMode={isGenshinMode}
                  />
                );
              })}
            </div>
            
            {/* 新消息提示：底部分割线 + 文案 */}
            <AnimatePresence>
              {unreadCount > 0 && !isAtBottom && (
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.9 }}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  className="absolute bottom-3 left-0 right-0 z-10 px-4"
                >
                  <button
                    onClick={scrollToBottom}
                    className="w-full flex items-center gap-3 text-xs font-medium transition-colors"
                    type="button"
                  >
                    <span className={cn(
                      "h-px flex-1",
                      isNight ? "bg-white/15" : "bg-black/10"
                    )} />
                    <span
                      className={cn(
                        "px-2 py-0.5 rounded-full border backdrop-blur-sm",
                        isNight
                          ? "text-white/80 border-white/15 bg-black/30"
                          : "text-[var(--text-secondary)] border-[var(--border-color)] bg-white/70"
                      )}
                    >
                      {unreadCount} 条新消息
                    </span>
                    <span className={cn(
                      "h-px flex-1",
                      isNight ? "bg-white/15" : "bg-black/10"
                    )} />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* 下方：对话框 - 固定在底部 */}
      <div className="wc-dialog-bottom mt-auto shrink-0 px-4 lg:px-6 pb-4 lg:pb-6 pt-0">
        {/* 移动端立绘放在消息框上方 */}
        <div className="wc-dialog-portrait-mobile md:hidden">
          {portraitNode}
        </div>
        {/* 投票进度 */}
        {(gameState.phase === "DAY_VOTE" || gameState.phase === "DAY_BADGE_ELECTION") && (
          <div className="mb-3 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-3">
            <div className="text-sm font-semibold text-[var(--text-primary)] mb-2 flex items-center gap-2">
              <span className="w-2 h-2 bg-[var(--color-accent)] rounded-full animate-pulse" />
              {gameState.phase === "DAY_BADGE_ELECTION" ? "警徽评选进行中" : "投票进行中"}
            </div>
            <VotingProgress gameState={gameState} humanPlayer={humanPlayer} />

            {/* 临时现场信息条（定位「卡在投票」用，问题确认后可删） */}
            <div className="mt-2 text-[10px] leading-relaxed text-[var(--text-muted)] font-mono break-all">
              {(() => {
                const isBadgeVote = gameState.phase === "DAY_BADGE_ELECTION";
                const candidates = gameState.badge.candidates || [];
                const pk =
                  gameState.pkSource === "vote" && Array.isArray(gameState.pkTargets)
                    ? gameState.pkTargets
                    : [];
                const votesMap = isBadgeVote ? gameState.badge.votes : gameState.votes;
                const exclude = isBadgeVote ? candidates : pk;
                const eligible = gameState.players.filter((p) => p.alive && !exclude.includes(p.seat));
                const voted = eligible.filter((p) => typeof votesMap[p.playerId] === "number").length;
                const myVote = humanPlayer ? votesMap[humanPlayer.playerId] : undefined;
                const me = humanPlayer ? `${humanPlayer.seat + 1}号` : "无";
                return [
                  "[现场]",
                  `阶段=${gameState.phase}`,
                  `你=${me}${humanPlayer?.alive ? "" : "(已出局)"}`,
                  `你的票=${typeof myVote === "number" ? `${Number(myVote) + 1}号` : "未投"}`,
                  `已投=${voted}/${eligible.length}`,
                  `候选=[${candidates.map((s) => s + 1).join(",")}]`,
                  `PK=[${pk.map((s) => s + 1).join(",")}]`,
                  `pkSource=${gameState.pkSource ?? "-"}`,
                  `选中=${typeof selectedSeat === "number" ? `${selectedSeat + 1}号` : "无"}`,
                  `等AI=${isWaitingForAI ? "是" : "否"}`,
                ].join(" ");
              })()}
            </div>
          </div>
        )}

        {/* 狼人协作面板 */}
        {gameState.phase === "NIGHT_WOLF_ACTION" && isWolfRole(humanPlayer?.role) && (
          <div className="mb-3">
            <WolfPlanningPanel gameState={gameState} humanPlayer={humanPlayer} />
          </div>
        )}

        {/* 对话气泡 - 简化结构，移除嵌套 */}
        <div
          className={cn(
            "wc-panel wc-panel--strong rounded-xl p-5 relative min-h-[160px] transition-opacity",
            shouldShowDialogPanel
              ? "opacity-100"
              : "opacity-0 pointer-events-none bg-transparent border-transparent shadow-none"
          )}
        >
          {showTutorialHelp && tutorialHelpLabel && (
            <div className="flex justify-end mb-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTutorialOpen?.();
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 p-1 px-2 rounded-full text-xs font-semibold border transition-all",
                  isNight
                    ? "bg-white/10 border-white/15 text-white/80 hover:bg-white/20"
                    : "bg-white border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                )}
              >
                {tutorialHelpLabel}
              </button>
            </div>
          )}
          {shouldShowDialogPanel && (
          <AnimatePresence mode="wait">
              {/* 游戏结束 - 文字形式 */}
              {showGameEnd && (
                <motion.div
                  key="game-end"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <div className="text-xl leading-relaxed text-[var(--text-primary)]">
                    {gameState.winner === "village" ? (
                      <>GG！<span className="text-[var(--color-success)] font-semibold">好人阵营</span>胜利！</>
                    ) : (
                      <>GG！<span className="text-[var(--color-wolf)] font-semibold">狼人阵营</span>胜利！</>
                    )}
                  </div>
                  <div className={`flex flex-col gap-3 mt-4 pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                    {onShowAnalysis && (
                      <button
                        onClick={onShowAnalysis}
                        className="wc-action-btn wc-action-btn--primary text-sm h-9 w-full"
                        type="button"
                        disabled={isAnalysisLoading}
                      >
                        {isAnalysisLoading ? "正在生成复盘..." : "查看复盘"}
                      </button>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[var(--text-muted)]">下次还来玩啊</span>
                      <button
                        onClick={onRestart}
                        className="wc-action-btn wc-action-btn--secondary text-sm h-9 px-4"
                        type="button"
                      >
                        <ArrowClockwise size={14} weight="bold" />
                        再来一局
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* 警徽竞选报名 */}
              {showBadgeSignup && (
                <motion.div
                  key="badge-signup"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <div className="text-lg leading-relaxed text-[var(--text-primary)]">
                    你要竞选警长吗？
                  </div>
                  <div className={`flex items-center justify-end gap-3 mt-4 pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                    <button
                      onClick={() => onBadgeSignup?.(false)}
                      className="wc-action-btn text-sm h-9 px-4"
                      type="button"
                    >
                      不竞选
                    </button>
                    <button
                      onClick={() => onBadgeSignup?.(true)}
                      className="wc-action-btn wc-action-btn--primary text-sm h-9 px-4"
                      type="button"
                    >
                      我要竞选
                      <CaretRight size={14} weight="bold" />
                    </button>
                  </div>
                </motion.div>
              )}
              
              {/* 警长移交警徽 - 撕毁选项 */}
              {showBadgeTransferOption && (
                <motion.div
                  key="badge-tear-option"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-4"
                >
                  <div className={`text-center p-4 rounded-lg ${isNight ? "bg-yellow-500/10 border border-yellow-500/20" : "bg-yellow-50 border border-yellow-200"}`}>
                    <div className={`text-lg font-medium mb-2 ${isNight ? "text-yellow-300" : "text-yellow-700"}`}>
                      警徽移交
                    </div>
                    <div className={`text-sm ${isNight ? "text-yellow-200/80" : "text-yellow-600"}`}>
                      你已出局，请选择将警徽移交给一名存活玩家
                    </div>
                  </div>
                  
                  <div className={`text-center text-sm ${isNight ? "text-white/60" : "text-gray-500"}`}>
                    点击头像选择移交对象
                  </div>
                  
                  <div className={`flex items-center justify-center pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                    <button
                      onClick={() => onConfirmAction?.()}
                      className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${
                        isNight 
                          ? "bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30" 
                          : "bg-red-50 text-red-600 border border-red-200 hover:bg-red-100"
                      }`}
                      type="button"
                    >
                      <Prohibit size={18} weight="bold" />
                      撕毁警徽（不移交）
                    </button>
                  </div>
                </motion.div>
              )}

              {/* 行动提示 */}
              {(() => {
                // 警长投票阶段，候选人不参与投票
                const badgeCandidates = gameState.badge.candidates || [];
                const humanIsCandidate = humanPlayer && badgeCandidates.includes(humanPlayer.seat);

                const isCorrectRoleForPhase =
                  (phase === "DAY_VOTE" && humanPlayer?.alive) ||
                  (phase === "DAY_BADGE_ELECTION" && humanPlayer?.alive && !humanIsCandidate) ||
                  (phase === "NIGHT_SEER_ACTION" && humanPlayer?.role === "Seer" && humanPlayer?.alive) ||
                  (phase === "NIGHT_WOLF_ACTION" && isWolfRole(humanPlayer?.role) && humanPlayer?.alive) ||
                  (phase === "NIGHT_GUARD_ACTION" && humanPlayer?.role === "Guard" && humanPlayer?.alive) ||
                  (phase === "NIGHT_WITCH_ACTION" && humanPlayer?.role === "Witch" && humanPlayer?.alive) ||
                  (phase === "HUNTER_SHOOT" && humanPlayer?.role === "Hunter") ||
                  (phase === "BADGE_TRANSFER" && humanPlayer && gameState.badge.holderSeat === humanPlayer.seat);

                const shouldShowHint =
                  isCorrectRoleForPhase &&
                  selectedSeat === null &&
                  phase !== "BADGE_TRANSFER" &&
                  (phase === "DAY_VOTE" || phase === "DAY_BADGE_ELECTION" || !isWaitingForAI);

                if (!shouldShowHint) return null;

                // 行动指引（喵杀 2026-10-19）：轮到自己的神职/投票时，给一句「该怎么做」的友好提示，
                // 降低「不知道要点谁、不知道按钮在哪」的迷茫感。夜间的神职提示含关键规则（如守卫不可连守）。
                const guardLastSeat = gameState.nightActions.lastGuardTarget;
                const guardLastPlayer =
                  typeof guardLastSeat === "number"
                    ? gameState.players.find((p) => p.seat === guardLastSeat)
                    : undefined;

                let hintTitle = "";
                let hintBody = "";
                if (phase === "NIGHT_GUARD_ACTION") {
                  hintTitle = "守卫 · 请睁眼喵";
                  hintBody = guardLastPlayer
                    ? `点击一名存活玩家的头像，为他撑起今夜的护盾。昨晚你守的是 ${guardLastSeat! + 1}号 ${guardLastPlayer.displayName}，今夜不能再守他喵（不能连着守同一个人）；也可以守自己。`
                    : "点击一名存活玩家的头像，为他撑起今夜的护盾。记住：不能连续两晚守护同一个人，也可以守自己喵。";
                } else if (phase === "NIGHT_SEER_ACTION") {
                  hintTitle = "预言家 · 请睁眼喵";
                  hintBody = "点击一名玩家的头像查验他的身份（狼人 / 好人）。结果只有你自己看得到，白天想说就说、想藏就藏喵。";
                } else if (phase === "NIGHT_WOLF_ACTION") {
                  hintTitle = "狼人 · 请睁眼喵";
                  hintBody = "和狼队友一起，点击一名目标作为今晚的刀口。别总挑座位最靠前的那个，也别盯着看着就像守卫的人喵。";
                } else if (phase === "NIGHT_WITCH_ACTION") {
                  hintTitle = "女巫 · 请睁眼喵";
                  hintBody = "上面已经告诉你今夜被刀的是谁：可以用解药救人，也可以用毒药毒一名玩家（每晚最多一瓶药）。解药毒药各只有一瓶，想清楚再用喵。";
                } else if (phase === "DAY_VOTE") {
                  hintTitle = "该投票了喵";
                  hintBody = "点击一名玩家投出放逐票，再点「确认」。票型要集中——散票等于帮了狼喵。";
                } else if (phase === "DAY_BADGE_ELECTION") {
                  hintTitle = "警徽投票喵";
                  hintBody = "点击一名候选人，把警徽投给他喵。";
                }

                if (!hintTitle) return null;

                return (
                  <motion.div
                    key="action-hint"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <div className={`rounded-lg border p-4 ${isNight ? "border-white/15 bg-white/5" : "border-black/10 bg-black/[0.03]"}`}>
                      <div className={`mb-1.5 text-base font-semibold ${isNight ? "text-[var(--color-gold)]" : "text-[var(--color-blood)]"}`}>
                        {hintTitle}
                      </div>
                      <div className={`text-sm leading-relaxed ${isNight ? "text-white/80" : "text-[var(--text-secondary)]"}`}>
                        {hintBody}
                      </div>
                    </div>
                  </motion.div>
                );
              })()}

              {/* 选择确认面板 - 文字形式 */}
              {(() => {
                if (!showActionConfirm || selectedSeat === null) return null;

                const targetPlayer = gameState.players.find(p => p.seat === selectedSeat);
                const targetName = targetPlayer ? `${selectedSeat + 1}号 ${targetPlayer.displayName}` : `${selectedSeat + 1}号`;

                const actionTextMap: Record<string, string> = {
                  DAY_VOTE: "投票给",
                  DAY_BADGE_ELECTION: "把警徽投给",
                  NIGHT_SEER_ACTION: "查验",
                  NIGHT_WOLF_ACTION: "击杀",
                  NIGHT_GUARD_ACTION: "守护",
                  HUNTER_SHOOT: "射击",
                  DAY_SPEECH: "自爆并带走",
                  DAY_PK_SPEECH: "自爆并带走",
                  BADGE_TRANSFER: "将警徽移交给",
                };

                const actionColorMap: Record<string, string> = {
                  DAY_VOTE: isNight ? "text-[var(--color-accent-light)]" : "text-[var(--color-accent)]",
                  DAY_BADGE_ELECTION: isNight ? "text-[var(--color-accent-light)]" : "text-[var(--color-accent)]",
                  NIGHT_SEER_ACTION: "text-[var(--color-seer)]",
                  NIGHT_WOLF_ACTION: "text-[var(--color-danger)]",
                  NIGHT_GUARD_ACTION: "text-[var(--color-success)]",
                  HUNTER_SHOOT: "text-[var(--color-warning)]",
                  DAY_SPEECH: "text-[var(--color-danger)]",
                  DAY_PK_SPEECH: "text-[var(--color-danger)]",
                  BADGE_TRANSFER: "text-[var(--color-warning)]",
                };

                const actionText = actionTextMap[phase] || "选择";
                const actionColor = actionColorMap[phase] || "text-[var(--color-accent)]";

                return (
                  <motion.div
                    key="action-confirm"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    <div className="text-lg leading-relaxed text-[var(--text-primary)]">
                      你选择{actionText} <span className={`font-semibold ${actionColor}`}>{targetName}</span>，确定吗？
                    </div>
                    <div className={`flex items-center justify-end gap-3 mt-4 pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                      <button
                        onClick={onCancelSelection}
                        className="wc-action-btn text-sm h-9 px-4"
                        type="button"
                      >
                        <X size={14} weight="bold" />
                        取消
                      </button>
                      <button
                        onClick={onConfirmAction}
                        className={`wc-action-btn text-sm h-9 px-4 ${phase.includes("WOLF") || phase === "HUNTER_SHOOT" ? "wc-action-btn--danger" : "wc-action-btn--primary"}`}
                        type="button"
                      >
                        确认{actionText}
                        <CaretRight size={14} weight="bold" />
                      </button>
                    </div>
                  </motion.div>
                );
              })()}

              {/* 白狼王自爆入口提示（2026-10-17） */}
              {showWWKBoomHint && !wwkHintDismissed && (
                <motion.div
                  key="wwk-boom-hint"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  <div className={`text-center p-4 rounded-lg ${isNight ? "bg-red-500/10 border border-red-500/20" : "bg-red-50 border border-red-200"}`}>
                    <div className={`text-lg font-medium mb-2 ${isNight ? "text-red-300" : "text-red-700"}`}>
                      白狼王 · 自爆喵
                    </div>
                    <div className={`text-sm ${isNight ? "text-red-200/80" : "text-red-600"}`}>
                      点击一名存活玩家的头像，即可「自爆并带走他」——先放句狠话，再一起飞走喵。
                    </div>
                  </div>
                </motion.div>
              )}

              {/* 猎人 · 不开枪（2026-10-17） */}
              {showHunterNoShoot && (
                <motion.div
                  key="hunter-no-shoot"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className={`flex items-center justify-between gap-3 p-4 rounded-lg ${isNight ? "bg-white/5 border border-white/10" : "bg-[var(--bg-secondary)] border border-[var(--border-color)]"}`}
                >
                  <div className={`text-sm ${isNight ? "text-white/70" : "text-[var(--text-secondary)]"}`}>
                    点击头像选择开枪目标；没有把握时也可以<b>不开枪</b>。
                  </div>
                  <button
                    onClick={() => onNightAction?.(-1, "pass")}
                    className={cn("wc-action-btn text-sm h-9 px-4 shrink-0", isNight ? "text-white/80" : "")}
                    type="button"
                  >
                    <Prohibit size={14} weight="bold" />
                    不开枪
                  </button>
                </motion.div>
              )}

              {/* 女巫行动面板 - 文字形式 */}
              {showWitchPanel && (
                selectedSeat !== null ? (
                  <motion.div
                    key="witch-poison-confirm"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    {(() => {
                      if (gameState.roleAbilities.witchPoisonUsed) {
                        return (
                          <>
                            <div className="text-lg leading-relaxed text-[var(--text-primary)]">
                              毒药已用尽。
                            </div>
                            <div className={`flex items-center justify-end gap-3 mt-4 pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                              <button
                                onClick={onCancelSelection}
                                className="wc-action-btn text-sm h-9 px-4"
                                type="button"
                              >
                                返回
                              </button>
                            </div>
                          </>
                        );
                      }
                      const targetPlayer = gameState.players.find(p => p.seat === selectedSeat);
                      const targetName = targetPlayer ? `${selectedSeat + 1}号 ${targetPlayer.displayName}` : `${selectedSeat + 1}号`;
                      return (
                        <>
                          <div className="text-lg leading-relaxed text-[var(--text-primary)]">
                            你选择对 <span className="text-[var(--color-danger)] font-semibold">{targetName}</span> 使用毒药，确定吗？
                          </div>
                          <div className={`flex items-center justify-end gap-3 mt-4 pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                            <button
                              onClick={onCancelSelection}
                              className="wc-action-btn text-sm h-9 px-4"
                              type="button"
                            >
                              <X size={14} weight="bold" />
                              取消
                            </button>
                            <button
                              onClick={() => onNightAction?.(selectedSeat, "poison")}
                              className="wc-action-btn wc-action-btn--danger text-sm h-9 px-4"
                              type="button"
                            >
                              确认毒杀
                              <CaretRight size={14} weight="bold" />
                            </button>
                          </div>
                        </>
                      );
                    })()}
                  </motion.div>
                ) : (
                  <motion.div
                    key="witch-actions"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    {(() => {
                      const wolfTarget = gameState.nightActions.wolfTarget;
                      const targetPlayer = wolfTarget !== undefined ? gameState.players.find(p => p.seat === wolfTarget) : null;
                      const targetName = targetPlayer ? `${wolfTarget! + 1}号 ${targetPlayer.displayName}` : wolfTarget !== undefined ? `${wolfTarget + 1}号` : null;
                      const healUsed = gameState.roleAbilities.witchHealUsed;
                      const poisonUsed = gameState.roleAbilities.witchPoisonUsed;

                      return (
                        <>
                          <div className="text-lg leading-relaxed text-[var(--text-primary)]">
                            {targetName ? (
                              <>
                                今晚 <span className="text-[var(--color-danger)] font-semibold">{targetName}</span> 被狼人袭击。
                                {healUsed ? (
                                  <span className="text-[var(--text-muted)]">（解药已用尽）</span>
                                ) : (
                                  <>
                                    <span className="mr-2">你可以</span>
                                    <button
                                      onClick={() => onNightAction?.(wolfTarget!, "save")}
                                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded border border-[var(--color-success)] bg-[var(--color-success)]/10 text-[var(--color-success)] font-semibold cursor-pointer hover:bg-[var(--color-success)]/20 active:scale-[0.98] transition-all text-sm"
                                      type="button"
                                    >
                                      救他
                                    </button>
                                    <span className="ml-2">。</span>
                                  </>
                                )}
                              </>
                            ) : (
                              <>今晚无人被袭击。</>
                            )}
                            {!poisonUsed && <> 或者点击玩家头像使用<span className="text-[var(--color-danger)] font-semibold">毒药</span>。</>}
                            {poisonUsed && <span className="text-[var(--text-muted)]">（毒药已用尽）</span>}
                          </div>
                          <div className={`flex items-center justify-end mt-4 pt-3 border-t ${isNight ? "border-white/10" : "border-black/5"}`}>
                            <button
                              onClick={() => onNightAction?.(0, "pass")}
                              className="wc-action-btn text-sm h-9 px-4"
                              type="button"
                            >
                              什么都不做
                              <CaretRight size={14} weight="bold" />
                            </button>
                          </div>
                        </>
                      );
                    })()}
                  </motion.div>
                )
              )}

              {/* 模式1: 人类发言输入 */}
              {showHumanInput && (
                <motion.div
                  key="human-input"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-3"
                >
                  {phase === "DAY_LAST_WORDS" && (
                    <div className="rounded-lg border border-[var(--color-gold)]/25 bg-[var(--color-gold)]/5 px-3 py-2 text-xs leading-relaxed text-[var(--text-secondary)]">
                      你已出局。留下遗言后点「结束遗言，进入夜晚」；60 秒未操作会自动继续。
                    </div>
                  )}
                  {phase !== "DAY_LAST_WORDS" && (
                    <div className="px-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
                      没想好也可以直接点「结束发言」——会自动补一句简短的过麦发言，不会卡住下一位。
                    </div>
                  )}
                  <div className="wc-input-box relative" style={{ minHeight: "112px", alignItems: "flex-start", padding: "14px 16px 56px" }}>
                    <MentionInput
                      key={`mention-input-${gameState.phase}-${gameState.currentSpeakerSeat}`}
                      value={inputText}
                      onChange={(t) => onInputChange?.(t)}
                      onSend={() => onSendMessage?.()}
                      onFinishSpeaking={onFinishSpeaking}
                      onVoiceHoldPrepare={() => {
                        voiceRecorderRef.current?.prepare();
                      }}
                      onVoiceHoldStart={() => {
                        voiceRecorderRef.current?.start();
                      }}
                      onVoiceHoldEnd={() => {
                        voiceRecorderRef.current?.stop();
                      }}
                      placeholder={gameState.phase === "DAY_LAST_WORDS" ? "有什么想说的？" : "你怎么看？"}
                      isNight={isNight}
                      isGenshinMode={isGenshinMode}
                      players={gameState.players.filter((p) => p.alive)}
                    />
                    
                    {/* 底部按钮栏 - 在输入框内部右下角 */}
                    <div className="absolute bottom-3 right-3 flex items-center gap-2">
                      <VoiceRecorder
                        ref={voiceRecorderRef}
                        disabled={!isHumanTurn}
                        isNight={isNight}
                        onTranscript={(text) => {
                          const prev = String(inputText || "");
                          const next = prev.trim().length > 0 ? `${prev.trim()} ${text}` : text;
                          onInputChange?.(next);
                        }}
                      />

                      <button
                        onClick={onSendMessage}
                        disabled={!inputText?.trim()}
                        className="h-8 px-3 rounded text-xs font-medium bg-[var(--color-gold)] text-[#1a1614] hover:bg-[#d4b06a] disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5 cursor-pointer"
                        title="发送"
                      >
                        <PaperPlaneTilt size={14} weight="fill" />
                        发送
                      </button>

                      <button
                        onClick={handleFinishSpeaking}
                        className="h-8 px-3 rounded text-xs font-medium border border-[var(--color-gold)]/50 text-[var(--color-gold)] bg-transparent hover:bg-[var(--color-gold)]/10 transition-all flex items-center gap-1.5 cursor-pointer"
                        title={phase === "DAY_LAST_WORDS" ? "结束遗言，进入夜晚" : "结束发言"}
                      >
                        <CheckCircle size={14} weight="fill" />
                        {phase === "DAY_LAST_WORDS" ? "结束遗言，进入夜晚" : "结束发言"}
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* 模式2: AI/系统对话显示 */}
              {showDialogueBlock && (
                <motion.div
                  // 只跟随「本机正在读的台词」重建；不要跟房主后台的 currentSpeakerSeat，
                  // 否则后台换到下一位时，当前对话会被无端重挂载（闪一下/重置打字机）。
                  key={`dialogue-${currentSpeaker?.player?.playerId || "waiting"}-${currentDialogue?.text?.slice(0, 32) || "waiting"}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="cursor-pointer"
                  onClick={handleAdvance}
                >
                    {currentSpeaker?.player && (
                      <div className="text-base font-bold text-[var(--color-gold)] mb-2 font-serif tracking-wide">
                        {currentSpeaker.player.seat + 1}号 {currentSpeaker.player.displayName}
                      </div>
                    )}
                    
                    {/* 对话内容 - 带玩家标签，逐字输入效果，文字调大 */}
                    <div className="text-xl leading-relaxed text-[var(--text-primary)]">
                      {renderPlayerMentions(
                        waitingForNextRound ? "轻触继续，轮到下一位" : dialogueText,
                        gameState.players,
                        isNight,
                        isGenshinMode
                      )}
                      {isTyping && <span className="wc-typing-cursor"></span>}
                    </div>
                  
                  {/* 底部信息栏 */}
                  <div className={`flex items-center justify-between mt-4 pt-3 border-t min-h-7 ${isNight ? "border-white/10" : "border-black/5"}`}> 
                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                      {isTyping ? (
                        <>
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                          <span>正在陈述…</span>
                        </>
                      ) : null}
                    </div>
                    <div className="h-7 flex items-center justify-end">
                      <AnimatePresence initial={false}>
                        {!isTyping && needsManualContinue ? (
                          <motion.div
                            key="enter-hint"
                            initial={{ opacity: 0, x: 10 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 10 }}
                            transition={{ duration: 0.25, ease: "easeOut" }}
                            className={`flex items-center gap-1.5 text-xs ${isNight ? "text-white/70" : "text-[var(--text-secondary)]"}`}
                          >
                            <span>点击或按</span>
                            <kbd className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[11px] ${
                              isNight
                                ? "bg-white/10 border-white/20 text-white/80"
                                : "bg-[var(--bg-secondary)] border-[var(--border-color)] text-[var(--text-primary)]"
                            }`}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="9 10 4 15 9 20" />
                                <path d="M20 4v7a4 4 0 0 1-4 4H4" />
                              </svg>
                              Enter
                            </kbd>
                            <span>继续</span>
                          </motion.div>
                        ) : (
                          <div key="placeholder" className="h-7" />
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* 模式3: 夜晚等待状态 - 有趣动画 */}
              {showNightWaiting && (
                <motion.div
                  key="night-waiting"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <NightActionStatus phase={gameState.phase} humanRole={humanPlayer?.role} />
                </motion.div>
              )}

              {/* 模式3.5: 夜色阶段提示（日→夜过渡 / 非行动夜间阶段）—— 保证对话区始终有可读反馈 */}
              {showNightStageHint && (
                <motion.div
                  key="night-stage-hint"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <div className="rounded-lg border border-white/10 bg-white/5 p-4 text-center">
                    <div className="mb-1 text-sm font-medium text-[var(--color-gold)]">
                      {nightStageText || "夜色正浓喵…"}
                    </div>
                    <div className="text-xs text-white/60">夜色流转中，稍候喵</div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </div>
    </div>
  );
}

// 聊天消息组件
function ChatMessageItem({ 
  msg, 
  players, 
  humanPlayerId,
  showDivider = false,
  isNight = false,
  isGenshinMode = false,
}: { 
  msg: ChatMessage; 
  players: Player[];
  humanPlayerId?: string;
  showDivider?: boolean;
  isNight?: boolean;
  isGenshinMode?: boolean;
}) {
  const player = players.find(p => p.playerId === msg.playerId);
  const isHuman = msg.playerId === humanPlayerId;
  const isPlayerReady = player ? (player.isHuman ? !!player.displayName?.trim() : !!player.agentProfile?.persona) : false;
  const isSystem = msg.isSystem;

  if (isSystem) {
    // 检查是否是投票结果消息
    if (msg.content.startsWith('[VOTE_RESULT]')) {
      try {
        const jsonData = msg.content.substring('[VOTE_RESULT]'.length);
        const voteData = JSON.parse(jsonData);
        return (
          <VoteResultCard
            title={voteData.title}
            results={voteData.results}
            players={players}
            isNight={isNight}
            isGenshinMode={isGenshinMode}
          />
        );
      } catch (e) {
        console.error('Failed to parse vote result:', e);
      }
    }
    
    return (
      <div className="flex justify-center my-3">
        <div className="text-xs text-center py-2 px-4 rounded-lg border text-[var(--text-secondary)] bg-[var(--glass-bg-weak)] border-[var(--glass-border)]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* 不同用户之间的分割线 */}
      {showDivider && (
        <div className={cn(
          "my-4 border-t",
          isNight ? "border-white/10" : "border-black/8"
        )} />
      )}
      <div className={cn(
        "wc-history-item flex items-start gap-3",
        isHuman ? "wc-history-item--highlight flex-row-reverse" : "",
        showDivider ? "mt-3" : "mt-2"
      )}>
        <div className={cn(
          "w-8 h-8 rounded-full overflow-hidden shrink-0 border shadow-sm",
          isNight ? "border-white/20" : "border-[var(--border-color)]"
        )}>
          {player && isPlayerReady ? (
            <img
              src={getPlayerAvatarUrl(player, isGenshinMode)}
              alt={msg.playerName}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-black/10" aria-hidden="true" />
          )}
        </div>
        
        <div className={cn(
          "min-w-0 max-w-[80%] w-fit text-left",
          isHuman ? "mr-0" : "ml-0"
        )}>
          <div className={cn("flex items-center gap-2 mb-1 text-xs opacity-70")}>
            {player && (
              <span className="wc-seat-badge">
                {player.seat + 1}号
              </span>
            )}
            <span className="font-serif font-bold text-[var(--text-primary)]">{msg.playerName}</span>
          </div>
          
          <div className="text-base leading-relaxed text-[var(--text-primary)] break-words text-left">
            {renderPlayerMentions(msg.content, players, isNight, isGenshinMode)}
          </div>
        </div>
      </div>
    </>
  );
}
