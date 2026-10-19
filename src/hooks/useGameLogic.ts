"use client";

/**
 * useGameLogic - 游戏逻辑协调层（重构版）
 * 
 * 职责：
 * 1. 协调各阶段 Hook 的调用
 * 2. 管理全局游戏状态
 * 3. 处理 Dev Mode 跳转
 * 4. 暴露统一的 API 给 UI 组件
 * 
 * 遵循原则：
 * - SRP: 仅负责协调，不包含具体业务逻辑
 * - DRY: 复用子模块，避免重复代码
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useAtom } from "jotai";
import { useLocalStorageState } from "ahooks";
import { toast } from "sonner";
import { getI18n } from "@/i18n/translator";

import { PLAYER_MODELS, isWolfRole, type GameState, type Player, type Phase, type Role, type DevPreset, type ModelRef, type StartGameOptions } from "@/types/game";
import { gameStateAtom, isValidTransition, isGameInProgress, clearPersistedGameState } from "@/store/game-machine";
import { mpLocalSeatAtom, mpGuestPlayingAtom } from "@/store/meowroom-atoms";
import type { MpAction } from "@/lib/meowroom/client";
import { getGeneratorModel } from "@/lib/api-keys";
import {
  createInitialGameState,
  setupPlayers,
  addSystemMessage,
  addPlayerMessage,
  transitionPhase as rawTransitionPhase,
  checkWinCondition,
  killPlayer,
  generateDailySummary,
  getEligibleVoterIds,
  getNextAliveSeat,
  generateWhiteWolfKingBoomDecision,
} from "@/lib/game-master";
import { buildGenshinModelRefs, generateCharacters, generateGenshinModeCharacters, sampleModelRefs, type GeneratedCharacter } from "@/lib/character-generator";
import { getEmptySpeechLines, getSystemMessages, getUiText } from "@/lib/game-texts";
import { getRandomScenario } from "@/lib/scenarios";
import { DELAY_CONFIG, getRoleName } from "@/lib/game-constants";
import { generateUUID } from "@/lib/utils";
import {
  AsyncFlowController,
  delay,
  randomDelay,
  computeUniqueTopSeat,
} from "@/lib/game-flow-controller";
import { playNarrator } from "@/lib/narrator-audio-player";
import { PhaseManager } from "@/game/core/PhaseManager";
import { announceNightDeaths } from "@/game/phases/DaySpeechPhase";
import { supabase } from "@/lib/supabase";
import { gameStatsTracker } from "@/hooks/useGameStats";
import { gameSessionTracker } from "@/lib/game-session-tracker";
import { isCustomKeyEnabled } from "@/lib/api-keys";
import { isQuotaExhaustedMessage } from "@/lib/llm";
import { aiLogger } from "@/lib/ai-logger";
import { effectiveRules } from "@/lib/house-rules";
import { buildCatRoster } from "@/lib/cat-roster";
import { pickUnusedVoiceId } from "@/lib/voice-constants";

// 子模块
import { useDialogueManager, type DialogueState } from "./useDialogueManager";
import { useDayPhase } from "./game-phases/useDayPhase";
import { useBadgePhase } from "./game-phases/useBadgePhase";
import { useSpecialEvents } from "./game-phases/useSpecialEvents";

function getRandomModelRef(): ModelRef {
  const fallback = sampleModelRefs(1)[0];
  if (fallback) return fallback;
  if (PLAYER_MODELS.length === 0) {
    // Fallback to GENERATOR_MODEL if no models available
    return { provider: "zenmux" as const, model: getGeneratorModel() };
  }
  const randomIndex = Math.floor(Math.random() * PLAYER_MODELS.length);
  return PLAYER_MODELS[randomIndex];
}

// Re-export for backward compatibility
export type { DialogueState };

export function useGameLogic() {
  const { t } = getI18n();
  const speakerHost = t("speakers.host");

  // ============================================
  // 基础状态
  // ============================================
  const [humanName, setHumanName] = useLocalStorageState<string>("meowcha_human_name", {
    defaultValue: "",
    // ahooks 默认直接 JSON.parse 读值；这个 key 历史上被别的代码写成过「裸字符串」
    // （例如 localStorage 里就是 站长喵），于是每次加载都报
    // SyntaxError: Unexpected token '站', "站长喵" is not valid JSON。
    // 这里做容错反序列化：是合法 JSON 就解析，否则按原文取用；写回统一用 JSON。
    serializer: (value: string) => JSON.stringify(value ?? ""),
    deserializer: (raw: string) => {
      try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "string" ? parsed : String(parsed ?? "");
      } catch {
        return raw;
      }
    },
  });
  const [gameStarted, setGameStarted] = useState(false);
  const [gameState, setGameState] = useAtom(gameStateAtom);
  const [isLoading, setIsLoading] = useState(false);
  const [inputText, setInputText] = useState("");
  const [showTable, setShowTable] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    void aiLogger.clearLogsOncePerPageLoad();
  }, []);

  // ============================================
  // 流程控制
  // ============================================
  const flowController = useRef(new AsyncFlowController());
  const phaseManagerRef = useRef(new PhaseManager());
  const phaseExtrasRef = useRef<{ phase: Phase; extras: Record<string, unknown> } | null>(null);
  const gameStateRef = useRef<GameState>(gameState);
  const prevPhaseRef = useRef<Phase>(gameState.phase);
  const phaseLifecycleRef = useRef<Phase>(gameState.phase);
  const prevDayRef = useRef<number>(gameState.day);
  const prevDevMutationIdRef = useRef<number | undefined>(gameState.devMutationId);
  const prevDevPhaseJumpTsRef = useRef<number | undefined>(undefined);
  const runAISpeechRef = useRef<((state: GameState, player: Player) => Promise<void>) | null>(null);
  const handleVoteCompleteRef = useRef<((state: GameState, result: { seat: number; count: number } | null, token: ReturnType<typeof getToken>) => Promise<void>) | null>(null);
  const endGameRef = useRef<((state: GameState, winner: "village" | "wolf") => Promise<void>) | null>(null);
  const resolveNightRef = useRef<((state: GameState, token: ReturnType<typeof getToken>, onComplete: (resolvedState: GameState) => Promise<void>) => Promise<void>) | null>(null);
  const startDayPhaseInternalRef = useRef<((state: GameState, token: ReturnType<typeof getToken>, options?: { skipAnnouncements?: boolean }) => Promise<void>) | null>(null);
  const badgeTransferRef = useRef<((state: GameState, sheriff: Player, afterTransfer: (s: GameState) => Promise<void>) => Promise<void>) | null>(null);
  const hunterDeathRef = useRef<((state: GameState, hunter: Player, diedAtNight: boolean) => Promise<void>) | null>(null);
  const proceedToNightRef = useRef<((state: GameState, token: ReturnType<typeof getToken>) => Promise<void>) | null>(null);
  const onStartVoteRef = useRef<((state: GameState, token: ReturnType<typeof getToken>) => Promise<void>) | null>(null);
  const onBadgeSpeechEndRef = useRef<((state: GameState) => Promise<void>) | null>(null);
  const onPkSpeechEndRef = useRef<((state: GameState) => Promise<void>) | null>(null);
  const wwkBoomCheckRef = useRef<((state: GameState, wwk: Player) => Promise<boolean>) | null>(null);
  const voteResolutionLockRef = useRef(false);
  // 白狼王自爆统一执行器（先「放狠话宣言」再结算）——AI 路径与人类路径共用
  const wwkBoomExecuteRef = useRef<((state: GameState, wwk: Player, targetSeat: number, token: ReturnType<typeof getToken>) => Promise<boolean>) | null>(null);

  // 游戏启动相关 refs
  const pendingStartStateRef = useRef<GameState | null>(null);
  const hasContinuedAfterRevealRef = useRef(false);
  const isAwaitingRoleRevealRef = useRef(false);
  const showTableTimeoutRef = useRef<number | null>(null);
  const restoredInProgressOnMountRef = useRef(isGameInProgress(gameState));
  const hasResumedFromCheckpointRef = useRef(false);

  // 回调 refs（用于人类操作后继续流程）
  const afterLastWordsRef = useRef<((state: GameState) => Promise<void>) | null>(null);
  const nightContinueRef = useRef<((state: GameState) => Promise<void>) | null>(null);
  const afterBadgeTransferRef = useRef<((state: GameState) => Promise<void>) | null>(null);
  const badgeSpeechEndRef = useRef<((state: GameState) => Promise<void>) | null>(null);
  // 喵杀（十三轮）：投票结算「先展示结果、等玩家确认」——把结算后的续程挂在这里，
  // 玩家按键/点击（走 advanceSpeech）时才执行；没有真人玩家（观战）则直接执行。
  const voteContinueRef = useRef<((state: GameState) => Promise<void>) | null>(null);
  // 遗言收尾防重：手动点「结束遗言」与 60 秒超时可能几乎同时触发，
  // 两次 proceedToNight 会让天数跳两格。
  const lastWordsFinishingRef = useRef(false);
  const handleNextRoundRef = useRef<(() => Promise<void>) | null>(null);

  // ============================================
  // 对话管理
  // ============================================
  const dialogue = useDialogueManager();
  const {
    currentDialogue,
    isWaitingForAI,
    waitingForNextRound,
    setIsWaitingForAI,
    setWaitingForNextRound,
    setDialogue,
    clearDialogue,
    initSpeechQueue,
    initStreamingSpeechQueue,
    appendToSpeechQueue,
    finalizeSpeechQueue,
    getSpeechQueue,
    advanceSpeechQueue,
    clearSpeechQueue,
    resetDialogueState,
    setPrefetchedSpeech,
    consumePrefetchedSpeech,
    markCurrentSegmentCommitted,
    isCurrentSegmentCommitted,
    markCurrentSegmentCompleted,
    isCurrentSegmentCompleted,
    shouldAutoAdvanceToNextAI,
  } = dialogue;

  // ============================================
  // 派生状态
  // ============================================
  // 联机：本局可能有多个 isHuman 座位；humanPlayer 必须锁定「我这台客户端操控的那一个」
  //（mpLocalSeat < 0 = 单人/未联机 → 取第一个真人座位，与旧行为一致）
  const [mpLocalSeat] = useAtom(mpLocalSeatAtom);
  // 联机客人：本地**不跑引擎**（整局由房主驱动），只把房主下发的局面渲染出来，
  // 自己的操作改为发到房间。否则客人这边会重复生成 AI 发言、重复结算投票。
  const [mpIsGuest] = useAtom(mpGuestPlayingAtom);
  const humanPlayer =
    gameState.players.find(
      (p) => p.isHuman && (mpLocalSeat < 0 || p.seat === mpLocalSeat)
    ) || null;
  const isNight = gameState.phase.includes("NIGHT");

  // 客人端本地引擎状态归零：对话框与「继续」提示完全由房主下发的局面/notice 派生。
  // 避免客人本地残留 waitingForNextRound=true，出现「轻触继续，轮到下一位」。
  useEffect(() => {
    if (!mpIsGuest) return;
    setWaitingForNextRound(false);
    setIsWaitingForAI(false);
    clearDialogue();
  }, [
    mpIsGuest,
    gameState.phase,
    gameState.currentSpeakerSeat,
    setWaitingForNextRound,
    setIsWaitingForAI,
    clearDialogue,
  ]);

  // ============================================
  // 联机（十七轮）：真人「读到哪里」的上报 + 投票前的两道门
  // ============================================
  // 站长要求：**投票环节要等所有真人把台词读完、并且都发过言，才开始**。
  //  · 读进度：本机读完后上报未读条数（0 = 读完）；房主逐座位记录，投票前检查。
  //  · 发言：引擎本来就会在真人发言位停下等他自己按「结束发言」；这里再加一道兜底，
  //    万一因为任何原因漏掉了某个真人的麦，投票前会把麦交还给他。
  // ⚠️ 必须放在 `mpLocalSeat` 声明之后（否则 TS 报「used before its declaration」）。
  const readProgressRef = useRef<Record<number, { unread: number; at: number }>>({});
  /** `${day}:${seat}` → 最近一次「把麦交给他」的时间戳（用于 60s 宽限，避免对方挂起把整局卡死） */
  const handedFloorRef = useRef<Map<string, number>>(new Map());
  /** 投票门当前在等什么 —— 显示在房主屏幕顶部，让「卡住」看得见（站长要求可见性） */
  const [gateNotice, setGateNotice] = useState<string | null>(null);

  /** 记录某座位「还差几句没读完」（房主本机 / 远程上报共用） */
  const reportReadProgress = useCallback(
    (unread: number, actorSeat?: number) => {
      const seat = typeof actorSeat === "number" && actorSeat >= 0 ? actorSeat : mpLocalSeat;
      if (seat < 0) return;
      readProgressRef.current[seat] = {
        unread: Math.max(0, Math.floor(Number(unread) || 0)),
        at: Date.now(),
      };
    },
    [mpLocalSeat]
  );

  /** 投前「阅读门」：等所有存活真人把已生成的台词读完（最多等 90s，避免有人挂起把整局卡死） */
  const waitForAllHumansReadDone = useCallback(async () => {
    if (mpLocalSeat < 0) return; // 单人/未联机：不门控
    const started = Date.now();
    const MAX_MS = 90_000;
    const STALE_MS = 15_000;
    const NEVER_MS = 12_000;
    let lastNotice = "";
    setGateNotice(null);
    while (Date.now() - started < MAX_MS) {
      const humans = gameStateRef.current.players.filter((p) => p.isHuman && p.alive);
      if (humans.length <= 1) {
        setGateNotice(null);
        return;
      }
      const waiting: string[] = [];
      for (const h of humans) {
        const rec = readProgressRef.current[h.seat];
        if (!rec) {
          // 完全没上报过（旧缓存客户端）→ 只宽限前 12s，之后不再阻塞
          if (Date.now() - started <= NEVER_MS) waiting.push(`${h.seat + 1}号`);
          continue;
        }
        if (Date.now() - rec.at > STALE_MS) continue; // 上报过期（对方挂起/切屏）→ 不再阻塞
        if (rec.unread > 0) waiting.push(`${h.seat + 1}号(还差${rec.unread}句)`);
      }
      if (waiting.length === 0) {
        setGateNotice(null);
        if (lastNotice) console.info("[meowcha] 投票门（阅读）：全员已读完，放行进入投票");
        return;
      }
      const notice = `投票前：等 ${waiting.join("、")} 读完再投票`;
      if (notice !== lastNotice) {
        lastNotice = notice;
        console.info("[meowcha] 投票门（阅读）：" + notice);
      }
      setGateNotice(notice);
      await delay(500);
    }
    console.warn("[meowcha] 投票门（阅读）：等待超时（90s），放行");
    setGateNotice(null);
  }, [mpLocalSeat]);

  /**
   * 投前「发言门」（兜底）：若还有存活真人今天没轮到发言，就把麦交给他、先别投票。
   * 每个 (天, 座位) 只交一次，避免对方一直不动导致无限循环。
   */
  const giveFloorIfSomeoneHasNotSpoken = useCallback(
    (state: GameState): boolean => {
      if (mpLocalSeat < 0) return false;
      if (state.phase !== "DAY_SPEECH") return false;
      const notSpoken = state.players
        .filter((p) => p.isHuman && p.alive)
        .find((h) => {
          // 「今天已经发过言」= 当天 DAY_SPEECH 阶段里有一条他的玩家消息（与引擎的判定同源）
          const spoken = state.messages.some(
            (m) =>
              !m.isSystem &&
              m.day === state.day &&
              m.phase === "DAY_SPEECH" &&
              m.playerId === h.playerId
          );
          if (spoken) return false;
          // 已经交过麦且超过 60s 他还没说 → 不再无限等（避免对方挂起把整局卡死）
          const last = handedFloorRef.current.get(`${state.day}:${h.seat}`) ?? 0;
          return !(last > 0 && Date.now() - last > 60_000);
        });
      if (!notSpoken) return false;
      handedFloorRef.current.set(`${state.day}:${notSpoken.seat}`, Date.now());
      console.info(
        `[meowcha] 投票门（发言）：${notSpoken.seat + 1}号 本日还没发过言 → 先把麦交给他，暂不投票`
      );
      setGateNotice(`投票前：${notSpoken.seat + 1}号 还没发言，正在等他`);
      setGameState({ ...state, currentSpeakerSeat: notSpoken.seat });
      setDialogue(t("speakers.hint"), getUiText().yourTurn, false);
      return true;
    },
    [mpLocalSeat, setDialogue, setGameState, t]
  );

  // ============================================
  // 工具函数
  // ============================================
  const transitionPhase = useCallback((state: GameState, newPhase: Phase): GameState => {
    if (!isValidTransition(state.phase, newPhase)) {
      console.warn(`[meowcha] Invalid phase transition: ${state.phase} -> ${newPhase}`);
    }
    return rawTransitionPhase(state, newPhase);
  }, []);

  const waitForUnpause = useCallback(async () => {
    while (gameStateRef.current.isPaused) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, []);

  const getToken = useCallback(() => flowController.current.getToken(), []);
  const isTokenValid = useCallback((token: { isValid: () => boolean }) => token.isValid(), []);

  const scrollToBottom = useCallback(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, []);

  const queuePhaseExtras = useCallback((phase: Phase, extras: Record<string, unknown>) => {
    phaseExtrasRef.current = { phase, extras };
  }, []);

  const buildVotePhaseExtras = useCallback((token: ReturnType<typeof getToken>, options?: { isRevote?: boolean }) => {
    return {
      token,
      isRevote: options?.isRevote === true,
      humanPlayer,
      setGameState,
      setDialogue,
      setIsWaitingForAI,
      waitForUnpause,
      isTokenValid,
      // 喵杀（2026-10-16）：把票型单独呈现给玩家看几秒，点「继续」后才揭晓处决/遗言/入夜。
      // 复用 voterContinue 机制（voteContinueRef + waitingForNextRound），由 advanceSpeech 触发。
      pauseForReview: (_state: GameState) =>
        new Promise<void>((resolve) => {
          if (!humanPlayer) {
            resolve();
            return;
          }
          voteContinueRef.current = async () => {
            resolve();
          };
          setWaitingForNextRound(true);
        }),
      onVoteComplete: async (state: GameState, result: { seat: number; count: number } | null) => {
        const nextToken = getToken();
        const fn = handleVoteCompleteRef.current;
        if (fn) {
          await fn(state, result, nextToken);
        }
      },
      onGameEnd: async (state: GameState, winner: "village" | "wolf") => {
        const fn = endGameRef.current;
        if (fn) {
          await fn(state, winner);
        }
      },
      beginVoteResolution: () => {
        voteResolutionLockRef.current = true;
      },
      endVoteResolution: () => {
        voteResolutionLockRef.current = false;
      },
      runAISpeech: async (state: GameState, player: Player) => {
        const fn = runAISpeechRef.current;
        if (fn) {
          await fn(state, player);
        }
      },
    };
  }, [getToken, humanPlayer, isTokenValid, setDialogue, setGameState, setIsWaitingForAI, waitForUnpause]);

  const buildNightPhaseExtras = useCallback((token: ReturnType<typeof getToken>) => {
    return {
      token,
      setGameState,
      setDialogue,
      setIsWaitingForAI,
      waitForUnpause,
      isTokenValid,
      // 喵杀（十七轮）：夜间的私密行动提示只发给本机真人（见 NightPhase.isLocalHuman）
      localSeat: mpLocalSeat,
      onNightComplete: async (state: GameState) => {
        const nextToken = getToken();
        const resolveFn = resolveNightRef.current;
        const startDayFn = startDayPhaseInternalRef.current;
        if (!resolveFn || !startDayFn) return;
        await resolveFn(state, nextToken, async (resolvedState) => {
          await startDayFn(resolvedState, nextToken);
        });
      },
    };
  }, [getToken, isTokenValid, mpLocalSeat, setDialogue, setGameState, setIsWaitingForAI, waitForUnpause]);

  const buildDaySpeechExtras = useCallback((token: ReturnType<typeof getToken>) => {
    return {
      token,
      setGameState,
      setDialogue,
      waitForUnpause,
      runAISpeech: async (state: GameState, player: Player) => {
        const fn = runAISpeechRef.current;
        if (fn) {
          await fn(state, player);
        }
      },
      onStartVote: async (state: GameState, nextToken: ReturnType<typeof getToken>) => {
        // 喵杀（十七轮 · 站长实测）：投票前两道门 ——
        // ① 发言门（兜底）：还有真人没轮到发言 → 把麦交给他，先别投票（他要读完+发言完才行）；
        // ② 阅读门：等所有真人把已生成的台词读完（最多 90s，避免有人挂起把整局卡死）。
        if (giveFloorIfSomeoneHasNotSpoken(state)) return;
        await waitForAllHumansReadDone();
        setGateNotice(null);
        console.info("[meowcha] 投票门：发言 + 阅读都满足 → 进入白天投票");
        const fn = onStartVoteRef.current;
        if (fn) {
          await fn(gameStateRef.current ?? state, nextToken);
        }
      },
      onBadgeSpeechEnd: async (state: GameState) => {
        await waitForAllHumansReadDone();
        const fn = onBadgeSpeechEndRef.current;
        if (fn) {
          await fn(gameStateRef.current ?? state);
        }
      },
      onPkSpeechEnd: async (state: GameState) => {
        await waitForAllHumansReadDone();
        const fn = onPkSpeechEndRef.current;
        if (fn) {
          await fn(gameStateRef.current ?? state);
        }
      },
      onBadgeTransfer: async (state: GameState, sheriff: Player, afterTransfer: (s: GameState) => Promise<void>) => {
        const fn = badgeTransferRef.current;
        if (fn) {
          await fn(state, sheriff, afterTransfer);
        }
      },
      onHunterDeath: async (state: GameState, hunter: Player, diedAtNight: boolean) => {
        const fn = hunterDeathRef.current;
        if (fn) {
          await fn(state, hunter, diedAtNight);
        }
      },
      onGameEnd: async (state: GameState, winner: "village" | "wolf") => {
        const fn = endGameRef.current;
        if (fn) {
          await fn(state, winner);
        }
      },
      onWhiteWolfKingBoomCheck: async (state: GameState, wwk: Player): Promise<boolean> => {
        const fn = wwkBoomCheckRef.current;
        if (fn) {
          return fn(state, wwk);
        }
        return false;
      },
    };
  }, [setDialogue, setGameState, waitForUnpause, giveFloorIfSomeoneHasNotSpoken, waitForAllHumansReadDone]);

  const runDaySpeechAction = useCallback(
    async (
      state: GameState,
      token: ReturnType<typeof getToken>,
      action: "START_DAY_SPEECH_AFTER_BADGE" | "ADVANCE_SPEAKER",
      options?: { skipAnnouncements?: boolean }
    ) => {
      // 喵杀修复（2026-10-18 · 站长实测）：推进发言者时先清掉上一轮的「投票门」提示条。
      // 否则「1号 还没发言，正在等他」会一直挂在屏幕上 —— 1号 早说完了、这会儿其实在等 2号。
      // 下一次尝试进入投票时 giveFloorIfSomeoneHasNotSpoken 会重新写下当前真正在等的那个人。
      if (action === "ADVANCE_SPEAKER") setGateNotice(null);
      const phaseImpl = phaseManagerRef.current.getPhase("DAY_SPEECH");
      if (!phaseImpl) return;
      await phaseImpl.handleAction(
        { state, phase: state.phase, extras: buildDaySpeechExtras(token) },
        action === "START_DAY_SPEECH_AFTER_BADGE"
          ? { type: action, options }
          : { type: action }
      );
    },
    [buildDaySpeechExtras, setGateNotice]
  );

  const runNightPhaseAction = useCallback(
    async (state: GameState, token: ReturnType<typeof getToken>, action: "START_NIGHT" | "CONTINUE_NIGHT_AFTER_GUARD" | "CONTINUE_NIGHT_AFTER_WOLF" | "CONTINUE_NIGHT_AFTER_WITCH") => {
      const phaseImpl = phaseManagerRef.current.getPhase("NIGHT_START");
      if (!phaseImpl) return;
      await phaseImpl.handleAction(
        { state, phase: state.phase, extras: buildNightPhaseExtras(token) },
        { type: action }
      );
    },
    [buildNightPhaseExtras]
  );

  // ============================================
  // Phase lifecycle hook
  // ============================================
  useEffect(() => {
    // 喵杀修复（2026-10-18 · 联机实测）：客人只渲染房主下发的局面，
    // 绝不能执行本地的 onEnter/onExit。旧实现漏了这个守卫，客人收到 DAY_VOTE/BADGE
    // 视图时会在自己浏览器里跑 VotePhase.onEnter，弹出「轻触继续，轮到下一位」，
    // 甚至重复生成 AI 票，和房主互相打架。
    if (mpIsGuest) {
      phaseLifecycleRef.current = gameState.phase;
      return;
    }
    const prevPhase = phaseLifecycleRef.current;
    const nextPhase = gameState.phase;
    if (prevPhase === nextPhase) return;

    const manager = phaseManagerRef.current;
    const prevImpl = manager.getPhase(prevPhase);
    const nextImpl = manager.getPhase(nextPhase);
    let cancelled = false;
    const queued = phaseExtrasRef.current;
    let extras = queued?.phase === nextPhase ? queued.extras : undefined;
    if (queued?.phase === nextPhase) {
      phaseExtrasRef.current = null;
    }
    if (!extras && nextPhase === "DAY_VOTE") {
      extras = buildVotePhaseExtras(getToken());
    }

    (async () => {
      if (prevImpl) {
        await prevImpl.onExit({ state: gameState, phase: prevPhase });
      }
      if (cancelled) return;
      if (nextImpl) {
        await nextImpl.onEnter({ state: gameState, phase: nextPhase, extras });
      }
    })();

    phaseLifecycleRef.current = nextPhase;
    return () => {
      cancelled = true;
    };
  }, [buildVotePhaseExtras, gameState, gameState.phase, getToken, mpIsGuest]);

  // ============================================
  // 每日总结生成
  // ============================================
  const maybeGenerateDailySummary = useCallback(
    async (state: GameState, options?: { force?: boolean }): Promise<GameState> => {
      if (state.day <= 0) return state;
      if (!options?.force && state.dailySummaries?.[state.day]?.length) return state;
      if (!state.messages || state.messages.length === 0) return state;
      try {
        const summary = await generateDailySummary(state);
        if (!summary || summary.bullets.length === 0) return state;
        return {
          ...state,
          dailySummaries: { ...state.dailySummaries, [state.day]: summary.bullets },
          dailySummaryFacts: { ...state.dailySummaryFacts, [state.day]: summary.facts },
          dailySummaryVoteData: {
            ...(state.dailySummaryVoteData ?? {}),
            ...(summary.voteData ? { [state.day]: summary.voteData } : {}),
          },
        };
      } catch {
        return state;
      }
    },
    []
  );

  const buildRawDayTranscript = useCallback((state: GameState): string => {
    const aliveIds = new Set(state.players.filter((p) => p.alive).map((p) => p.playerId));
    const dayStartIndex = (() => {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i];
        if (m.isSystem && m.content === t("gameLogicMessages.dayBreak")) return i;
      }
      return 0;
    })();

    const voteStartIndex = (() => {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i];
        if (m.isSystem && m.content === t("gameLogicMessages.voteStart")) return i;
      }
      return state.messages.length;
    })();

    const slice = state.messages.slice(
      dayStartIndex,
      voteStartIndex > dayStartIndex ? voteStartIndex : state.messages.length
    );

    return slice
      .filter((m) => !m.isSystem && aliveIds.has(m.playerId))
      .map((m) => `${m.playerName}: ${m.content}`)
      .join("\n");
  }, []);

  // ============================================
  // 特殊事件处理
  // ============================================
  // 缓存 access token 用于游戏会话保存
  const accessTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data: { session } }) => {
      accessTokenRef.current = session?.access_token ?? null;
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      accessTokenRef.current = session?.access_token ?? null;
    });
    return () => subscription.unsubscribe();
  }, []);

  const getAccessToken = useCallback((): string | null => {
    return accessTokenRef.current;
  }, []);

  // 监听页面卸载，记录中断的游戏会话
  useEffect(() => {
    const handleBeforeUnload = () => {
      const summary = gameSessionTracker.getSummary();
      const accessToken = accessTokenRef.current;
      if (!summary || !accessToken) return;

      // 使用 sendBeacon 确保页面关闭时请求能发出
      // 由于 sendBeacon 无法等待异步操作，仍使用 API 路由
      const payload = JSON.stringify({
        action: "update",
        sessionId: summary.sessionId,
        accessToken,
        winner: null,
        completed: false,
        roundsPlayed: summary.roundsPlayed,
        durationSeconds: summary.durationSeconds,
        aiCallsCount: summary.aiCallsCount,
        aiInputChars: summary.aiInputChars,
        aiOutputChars: summary.aiOutputChars,
        aiPromptTokens: summary.aiPromptTokens,
        aiCompletionTokens: summary.aiCompletionTokens,
      });
      navigator.sendBeacon?.(
        "/api/game-sessions",
        new Blob([payload], { type: "application/json" })
      );
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  const specialEvents = useSpecialEvents({
    setDialogue,
    setIsWaitingForAI,
    waitForUnpause,
    isTokenValid,
    getAccessToken,
  });

  const { endGame, resolveNight } = specialEvents;

  const endGameSafely = useCallback(
    async (state: GameState, winner: "village" | "wolf") => {
      clearSpeechQueue();
      clearDialogue();
      setIsWaitingForAI(false);
      setWaitingForNextRound(false);
      await endGame(state, winner);
    },
    [clearDialogue, clearSpeechQueue, endGame, setIsWaitingForAI, setWaitingForNextRound]
  );

  endGameRef.current = endGameSafely;
  resolveNightRef.current = resolveNight;

  // ============================================
  // 投票阶段（Phase 驱动）
  // ============================================
  const enterVotePhase = useCallback(
    async (state: GameState, token: ReturnType<typeof getToken>, options?: { isRevote?: boolean }) => {
      // 投票阶段不再触发总结 - 避免重复调用
      // 总结将在进入夜晚时统一生成，此时信息最完整（包含投票结果和遗言）
      
      queuePhaseExtras("DAY_VOTE", buildVotePhaseExtras(token, options));
      const clearedState: GameState = {
        ...state,
        votes: {},
        lastVoteReasons: state.voteReasons ? { ...state.voteReasons } : {},
        voteReasons: {},
      };
      const nextState = transitionPhase(clearedState, "DAY_VOTE");
      setGameState(nextState);
    },
    [buildVotePhaseExtras, queuePhaseExtras, setGameState, transitionPhase]
  );

  const resolveVotePhase = useCallback(
    async (state: GameState, token: ReturnType<typeof getToken>) => {
      const phaseImpl = phaseManagerRef.current.getPhase("DAY_VOTE");
      if (!phaseImpl) return;
      await phaseImpl.handleAction(
        { state, phase: "DAY_VOTE", extras: buildVotePhaseExtras(token) },
        { type: "RESOLVE_VOTES" }
      );
    },
    [buildVotePhaseExtras]
  );

  const resolveVotesSafely = useCallback(async (
    state: GameState,
    token: ReturnType<typeof getToken>
  ) => {
    if (voteResolutionLockRef.current) return;
    voteResolutionLockRef.current = true;
    try {
      await resolveVotePhase(state, token);
    } finally {
      voteResolutionLockRef.current = false;
    }
  }, [resolveVotePhase]);

  // ============================================
  // 白天阶段
  // ============================================
  const dayPhase = useDayPhase(humanPlayer, {
    setDialogue,
    setIsWaitingForAI,
    setWaitingForNextRound,
    isTokenValid,
    initSpeechQueue,
    initStreamingSpeechQueue,
    appendToSpeechQueue,
    finalizeSpeechQueue,
    setPrefetchedSpeech,
    consumePrefetchedSpeech,
    setAfterLastWords: (cb) => { afterLastWordsRef.current = cb; },
  });

  const { startLastWordsPhase, runAISpeech } = dayPhase;
  runAISpeechRef.current = runAISpeech;

  // ============================================
  // 警长竞选阶段
  // ============================================
  const badgePhase = useBadgePhase({
    setDialogue,
    clearDialogue,
    setGateNotice,
    setIsWaitingForAI,
    waitForUnpause,
    isTokenValid,
    onBadgeElectionComplete: async (state) => {
      const token = getToken();
      await runDaySpeechAction(state, token, "START_DAY_SPEECH_AFTER_BADGE");
    },
    onBadgeTransferComplete: async (state) => {
      const afterTransfer = afterBadgeTransferRef.current;
      afterBadgeTransferRef.current = null;
      if (afterTransfer) {
        await afterTransfer(state);
      }
    },
    runAISpeech: async (state, player) => {
      await runAISpeech(state, player);
    },
  });
  badgeTransferRef.current = badgePhase.handleBadgeTransfer;
  onStartVoteRef.current = enterVotePhase;
  onBadgeSpeechEndRef.current = async (state: GameState) => {
    const summarized = await maybeGenerateDailySummary(state);
    if (summarized !== state) {
      setGameState(summarized);
    }
    await badgePhase.startBadgeElectionPhase(summarized);
  };
  onPkSpeechEndRef.current = async (state: GameState) => {
    const token = getToken();
    const nextState = {
      ...state,
      pkTargets: undefined,
      pkSource: undefined,
    };

    if (state.pkSource === "badge") {
      await badgePhase.startBadgeElectionPhase(nextState, { isRevote: true });
      return;
    }

    if (state.pkSource === "vote") {
      await enterVotePhase(state, token, { isRevote: true });
      return;
    }
  };

  // ============================================
  // 内部流程函数
  // ============================================
  const startDayPhaseInternal = useCallback(async (
    state: GameState,
    token: ReturnType<typeof getToken>,
    options?: { skipAnnouncements?: boolean }
  ) => {
    // 第一天：喵杀修正（2026-10-17 · 站长实测）——
    // 站长的规则是「天亮先公布死讯，再进行警长竞选」，原来的顺序是先竞选、竞选后才公布死讯，
    // 导致竞选阶段的 AI 看到的还是「全员存活」（会说「今天没死人」），夜里出局者也能报名竞选。
    // 现在：先公布本夜死讯（含「平安无事」），再进入警徽评选；
    // 「警徽是否已选定」用 badge.history 判断，避免竞选出平票撕毁后从猎人开枪等分支重入时又跑一次竞选。
    if (state.day === 1 && state.badge.holderSeat === null && !state.badge.history?.[state.day]) {
      const announced = options?.skipAnnouncements
        ? state
        : await announceNightDeaths(state, { setGameState, setDialogue, waitForUnpause });
      await badgePhase.startBadgeSignupPhase(announced);
      return;
    }
    // 非第一天：直接进入讨论（startDaySpeechAfterBadge 内部会先公布死讯）
    await runDaySpeechAction(state, token, "START_DAY_SPEECH_AFTER_BADGE", options);
  }, [badgePhase, runDaySpeechAction, setGameState, setDialogue, waitForUnpause]);
  startDayPhaseInternalRef.current = startDayPhaseInternal;

  const proceedToNight = useCallback(async (state: GameState, token: ReturnType<typeof getToken>) => {
    if (!isTokenValid(token)) return;
    if (isAwaitingRoleRevealRef.current) return;

    // 喵杀修复（2026-10-18 · 站长实测）：进入夜晚前清掉上一段发言/遗言的队列与头像，
    // 否则最后一句遗言会一直挂在对话框里，甚至被后台泵继续推进到夜里。
    clearSpeechQueue();
    clearDialogue();
    setIsWaitingForAI(false);
    setWaitingForNextRound(false);

    // 天黑时同步游戏进度到数据库（incrementRound 内部会立即同步）
    gameSessionTracker.incrementRound().catch(() => {});

    const systemMessages = getSystemMessages();
    const lastGuardTarget = state.nightActions.guardTarget ?? state.nightActions.lastGuardTarget;
    // Preserve seerHistory across nights
    const seerHistory = state.nightActions.seerHistory;
    let nextState = {
      ...state,
      day: state.day + 1,
      nightActions: {
        ...(lastGuardTarget !== undefined ? { lastGuardTarget } : {}),
        ...(seerHistory ? { seerHistory } : {}),
      },
    };
    nextState = transitionPhase(nextState, "NIGHT_START");
    nextState = addSystemMessage(nextState, systemMessages.nightFall(nextState.day));
    setGameState(nextState);

    // Set dialogue before playing audio so message box appears immediately
    setDialogue(speakerHost, systemMessages.nightFall(nextState.day), false);

    // 播放旁白语音
    await playNarrator("nightFall");

    await delay(250);
    if (!isTokenValid(token)) return;

    setDialogue(speakerHost, systemMessages.summarizingDay, false);

    const summarized = await maybeGenerateDailySummary(state, { force: true });
    if (!isTokenValid(token)) return;

    const mergedState = {
      ...nextState,
      dailySummaries: summarized.dailySummaries,
      dailySummaryFacts: summarized.dailySummaryFacts,
      dailySummaryVoteData: summarized.dailySummaryVoteData ?? nextState.dailySummaryVoteData,
    };

    await runNightPhaseAction(mergedState, token, "START_NIGHT");
  }, [isTokenValid, clearSpeechQueue, clearDialogue, setIsWaitingForAI, setWaitingForNextRound, maybeGenerateDailySummary, runNightPhaseAction, setGameState, setDialogue, speakerHost, transitionPhase]);
  proceedToNightRef.current = proceedToNight;

  hunterDeathRef.current = async (state: GameState, hunter: Player, diedAtNight: boolean) => {
    const token = getToken();
    await specialEvents.handleHunterDeath(state, hunter, diedAtNight, token, async (afterState) => {
      const startDayFn = startDayPhaseInternalRef.current;
      const proceedFn = proceedToNightRef.current;
      if (!startDayFn || !proceedFn) return;
      if (diedAtNight) {
        await startDayFn(afterState, token, { skipAnnouncements: true });
      } else {
        await proceedFn(afterState, token);
      }
    });
  };

  // 喵杀（十三轮）：投票结束后**先让玩家看清结果**，按键/点击确认后才继续。
  // 有真人玩家 → 把续程挂进 voteContinueRef 并置 waitingForNextRound（对话区保持显示投票结果）；
  // 观战/无真人 → 直接继续，避免无人可点导致卡住。
  const pauseThenRunVoteContinuation = useCallback(async (
    cont: (s: GameState) => Promise<void>,
    s: GameState
  ) => {
    if (humanPlayer) {
      voteContinueRef.current = cont;
      setWaitingForNextRound(true);
      return;
    }
    await cont(s);
  }, [humanPlayer, setWaitingForNextRound]);

  const handleVoteComplete = useCallback(async (
    state: GameState,
    result: { seat: number; count: number } | null,
    token: ReturnType<typeof getToken>
  ) => {
    if (result) {
      const executedPlayer = state.players.find((p) => p.seat === result.seat);
      const isSheriff = state.badge.holderSeat === result.seat;

      await delay(DELAY_CONFIG.MEDIUM);
      if (!isTokenValid(token)) return;

      const afterLastWords = async (s: GameState) => {
        // 警长死亡，先移交警徽
        if (isSheriff && executedPlayer) {
          afterBadgeTransferRef.current = async (afterTransferState) => {
            if (executedPlayer?.role === "Hunter" && afterTransferState.roleAbilities.hunterCanShoot) {
              await specialEvents.handleHunterDeath(afterTransferState, executedPlayer, false, token, async (afterHunterState) => {
                await proceedToNight(afterHunterState, token);
              });
              return;
            }

            const winnerAfterTransfer = checkWinCondition(afterTransferState);
            if (winnerAfterTransfer) {
              await endGameSafely(afterTransferState, winnerAfterTransfer);
              return;
            }

            await proceedToNight(afterTransferState, token);
          };
          await badgePhase.handleBadgeTransfer(s, executedPlayer, async (afterTransferState) => {
            const cb = afterBadgeTransferRef.current;
            afterBadgeTransferRef.current = null;
            if (cb) await cb(afterTransferState);
          });
          return;
        }

        // 猎人开枪
        if (executedPlayer?.role === "Hunter" && s.roleAbilities.hunterCanShoot) {
          await specialEvents.handleHunterDeath(s, executedPlayer, false, token, async (afterHunterState) => {
            await proceedToNight(afterHunterState, token);
          });
          return;
        }

        // 检查胜负
        const winnerAfterLastWords = checkWinCondition(s);
        if (winnerAfterLastWords) {
          await endGameSafely(s, winnerAfterLastWords);
          return;
        }

        await proceedToNight(s, token);
      };

      await pauseThenRunVoteContinuation(async (s0) => {
        clearSpeechQueue();
        clearDialogue();
        await startLastWordsPhase(s0, result.seat, afterLastWords, token);
      }, state);
      return;
    }

    // 平票 / 无出局（含白痴免疫）：同样先把结果摆一会儿、等玩家确认，再进入夜晚
    await delay(DELAY_CONFIG.MEDIUM);
    if (!isTokenValid(token)) return;
    await pauseThenRunVoteContinuation(async (s0) => {
      await proceedToNight(s0, token);
    }, state);
  }, [isTokenValid, clearSpeechQueue, clearDialogue, startLastWordsPhase, badgePhase, specialEvents, endGame, proceedToNight, pauseThenRunVoteContinuation]);
  handleVoteCompleteRef.current = handleVoteComplete;

  // 喵杀（2026-10-17）：白狼王自爆统一执行器 —— 先「放狠话宣言」，再结算自爆。
  // AI 路径（发言结束后由 wwkBoomCheckRef 触发）与人类路径（对局内点选目标后触发）共用。
  wwkBoomExecuteRef.current = async (
    state: GameState,
    wwk: Player,
    targetSeat: number,
    token: ReturnType<typeof getToken>
  ): Promise<boolean> => {
    if (state.roleAbilities.whiteWolfKingBoomUsed) return false;
    if (!effectiveRules(state.houseRules).whiteWolfKingCanBoom) return false;

    const declaredTarget = state.players.find((p) => p.seat === targetSeat && p.alive);

    let base = state;
    // ① 自爆前先「宣言」：站长反馈「讨论得好好的突然就炸了」很突兀 → 先放一句可爱又狠的话。
    if (declaredTarget) {
      const declareKeys = [
        "system.whiteWolfKingDeclare1",
        "system.whiteWolfKingDeclare2",
        "system.whiteWolfKingDeclare3",
      ] as const;
      const declareKey = declareKeys[Math.floor(Math.random() * declareKeys.length)];
      const declaration = t(declareKey, {
        targetSeat: targetSeat + 1,
        targetName: declaredTarget.displayName,
      });
      base = addSystemMessage(base, `${wwk.seat + 1}号 ${wwk.displayName}：${declaration}`);
      setDialogue(wwk.displayName, declaration, false);
      setGameState(base);
      await delay(1600);
      if (!isTokenValid(token)) return false;
    }

    // 执行自爆逻辑
    let currentState = transitionPhase(base, "WHITE_WOLF_KING_BOOM");
    currentState = killPlayer(currentState, wwk.seat);
    currentState = {
      ...currentState,
      roleAbilities: { ...currentState.roleAbilities, whiteWolfKingBoomUsed: true },
    };

    const target = currentState.players.find((p) => p.seat === targetSeat);
    if (target && target.alive) {
      currentState = killPlayer(currentState, targetSeat);
      const msg = t("system.whiteWolfKingBoom", {
        seat: wwk.seat + 1,
        name: wwk.displayName,
        targetSeat: targetSeat + 1,
        targetName: target.displayName,
      });
      currentState = addSystemMessage(currentState, msg);
      setDialogue(speakerHost, msg, false);

      const prevDayRecord = (currentState.dayHistory || {})[currentState.day] || {};
      currentState = {
        ...currentState,
        dayHistory: {
          ...(currentState.dayHistory || {}),
          [currentState.day]: { ...prevDayRecord, whiteWolfKingBoom: { boomSeat: wwk.seat, targetSeat } },
        },
      };
    } else {
      const msg = t("system.whiteWolfKingBoomNoTarget", { seat: wwk.seat + 1, name: wwk.displayName });
      currentState = addSystemMessage(currentState, msg);
      setDialogue(speakerHost, msg, false);
    }

    // 白狼王自爆带走的人没有遗言，如果被带走的人或白狼王是警长，警徽直接撕毁
    const sheriffSeat = currentState.badge.holderSeat;
    if (sheriffSeat !== null && (!currentState.players.find((p: Player) => p.seat === sheriffSeat)?.alive)) {
      const sheriffPlayer = currentState.players.find((p: Player) => p.seat === sheriffSeat);
      const forceTornMsg = t("system.badgeForceTorn", { seat: sheriffSeat + 1, name: sheriffPlayer?.displayName || "" });
      currentState = addSystemMessage(currentState, forceTornMsg);
      currentState = {
        ...currentState,
        badge: { ...currentState.badge, holderSeat: null },
      };
    }

    setGameState(currentState);

    // 白狼王自爆带走猎人时，猎人可以开枪（非毒死，技能可发动）
    const boomTarget = currentState.players.find((p: Player) => p.seat === targetSeat);
    if (boomTarget?.role === "Hunter" && currentState.roleAbilities.hunterCanShoot) {
      await delay(1200);
      const hunterFn = hunterDeathRef.current;
      if (hunterFn) await hunterFn(currentState, boomTarget, false);
      return true;
    }

    const winner = checkWinCondition(currentState);
    if (winner) {
      const endFn = endGameRef.current;
      if (endFn) await endFn(currentState, winner);
      return true;
    }

    await delay(1200);
    const proceedFn = proceedToNightRef.current;
    if (proceedFn) await proceedFn(currentState, token);
    return true;
  };

  // AI白狼王自爆决策
  wwkBoomCheckRef.current = async (state: GameState, wwk: Player): Promise<boolean> => {
    if (state.roleAbilities.whiteWolfKingBoomUsed) return false;
    if (!effectiveRules(state.houseRules).whiteWolfKingCanBoom) return false;
    if (!wwk.agentProfile?.modelRef) return false;

    const targetSeat = await generateWhiteWolfKingBoomDecision(state, wwk);
    if (targetSeat === null) return false; // AI 选择不自爆

    const token = getToken();
    if (!isTokenValid(token)) return false;

    const fn = wwkBoomExecuteRef.current;
    if (!fn) return false;
    return await fn(state, wwk, targetSeat, token);
  };

  // ============================================
  // 投票完成监控（安全保障机制）
  // ============================================
  useEffect(() => {
    if (mpIsGuest) return; // 联机客人：投票结算由房主做，客人不重复结算
    if (gameState.phase !== "DAY_VOTE") return;
    if (voteResolutionLockRef.current) return;
    if (isWaitingForAI) return;

    // 与 VotePhase / game-machine 同一口径：排除 PK 目标和已翻牌白痴
    const eligibleIds = getEligibleVoterIds(gameState);
    const allVoted =
      eligibleIds.length === 0 ||
      eligibleIds.every((id) => typeof gameState.votes[id] === "number");
    
    if (allVoted) {
      console.log("[meowcha] useEffect: All votes detected, triggering resolveVotePhase as safety net");
      const token = getToken();
      void resolveVotesSafely(gameState, token);
    }
  }, [gameState.phase, gameState.votes, gameState.players, getToken, resolveVotesSafely, isWaitingForAI]);

  // ============================================
  // 从检查点恢复后的细粒度推进
  // ============================================
  useEffect(() => {
    if (mpIsGuest) return; // 联机客人：不跑阶段推进/AI 发言，只渲染房主下发的局面
    if (!restoredInProgressOnMountRef.current) return;
    if (hasResumedFromCheckpointRef.current) return;

    const s = gameStateRef.current;
    if (!isGameInProgress(s) || s.players.length === 0) return;

    hasResumedFromCheckpointRef.current = true;
    setGameStarted(true);
    setShowTable(true);
    const token = getToken();

    console.info(`[meowcha] Resuming from checkpoint at phase ${s.phase}, day ${s.day}`);

    const uiText = getUiText();
    const speakerHint = t("speakers.hint");

    const didLastSpeechComeFrom = (state: GameState, playerId: string): boolean => {
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i];
        if (m.isSystem) continue;
        if (m.day !== state.day) continue;
        if (m.phase !== state.phase) continue;
        return m.playerId === playerId;
      }
      return false;
    };

    switch (s.phase) {
      case "NIGHT_START": {
        if (s.day === 1) {
          pendingStartStateRef.current = s;
          hasContinuedAfterRevealRef.current = false;
          isAwaitingRoleRevealRef.current = true;
        } else {
          hasContinuedAfterRevealRef.current = true;
          isAwaitingRoleRevealRef.current = false;
          void runNightPhaseAction(s, token, "START_NIGHT");
        }
        break;
      }

      case "NIGHT_GUARD_ACTION": {
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        const guard = s.players.find((p: Player) => p.role === "Guard" && p.alive);
        if (!guard || s.nightActions.guardTarget !== undefined) {
          void runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_GUARD");
        } else if (!guard.isHuman) {
          void runNightPhaseAction(s, token, "START_NIGHT");
        }
        break;
      }

      case "NIGHT_WOLF_ACTION": {
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        if (s.nightActions.wolfTarget !== undefined) {
          void runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WOLF");
        } else {
          const humanWolf = s.players.find((p: Player) => isWolfRole(p.role) && p.alive && p.isHuman);
          if (!humanWolf) {
            void runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_GUARD");
          }
        }
        break;
      }

      case "NIGHT_WITCH_ACTION": {
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        const witch = s.players.find((p: Player) => p.role === "Witch" && p.alive);
        const witchDone =
          !witch ||
          (s.roleAbilities.witchHealUsed && s.roleAbilities.witchPoisonUsed) ||
          s.nightActions.witchSave !== undefined ||
          s.nightActions.witchPoison !== undefined;
        if (witchDone) {
          void runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WITCH");
        } else if (!witch?.isHuman) {
          void runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WOLF");
        }
        break;
      }

      case "NIGHT_SEER_ACTION": {
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        if (s.nightActions.seerTarget !== undefined) {
          const seerResult = s.nightActions.seerResult;
          // 喵杀修复：查验结果只能给预言家本人看。恢复存档时若人类不是预言家（或已是观众），
          // 不能把 AI 预言家的查验结果播报出来，否则等于泄露信息。
          if (seerResult && humanPlayer?.role === "Seer") {
            const targetPlayer = s.players.find((p: Player) => p.seat === seerResult.targetSeat);
            setDialogue(
              t("speakers.seerResult"),
              t("gameLogicMessages.seerResultText", {
                seat: seerResult.targetSeat + 1,
                name: targetPlayer?.displayName || "",
                result: seerResult.isWolf ? t("gameLogicMessages.werewolfResult") : t("gameLogicMessages.goodResult"),
              }),
              false
            );
          }
          // 喵杀修复（2026-10-18 · 站长实测）：恢复存档时若本夜已查验，直接自动推进。
          // 原来把推进挂到 nightContinueRef 等玩家点击，而夜间那一屏（「夜晚等待状态」彩色卡片）
          // 没有可点的对话框 → 刷新/续局后同样会卡死在「预言家请睁眼」。
          void (async () => {
            await delay(2200);
            if (!isTokenValid(token)) return;
            await waitForUnpause();
            await resolveNight(s, token, async (resolvedState: GameState) => {
              await startDayPhaseInternal(resolvedState, token);
            });
          })();
        } else {
          const seer = s.players.find((p: Player) => p.role === "Seer" && p.alive);
          if (!seer?.isHuman) {
            void runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WITCH");
          }
        }
        break;
      }

      case "DAY_START": {
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        void startDayPhaseInternal(s, token);
        break;
      }

      case "DAY_BADGE_SIGNUP": {
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        void badgePhase.startBadgeSignupPhase(s);
        break;
      }

      case "DAY_BADGE_SPEECH":
      case "DAY_PK_SPEECH":
      case "DAY_SPEECH": {
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;

        if (s.currentSpeakerSeat === null) {
          void runDaySpeechAction(s, token, "ADVANCE_SPEAKER");
          break;
        }

        const currentSpeaker = s.players.find((p: Player) => p.seat === s.currentSpeakerSeat) || null;
        if (!currentSpeaker || !currentSpeaker.alive) {
          void runDaySpeechAction(s, token, "ADVANCE_SPEAKER");
          break;
        }

        if (currentSpeaker.isHuman) {
          setDialogue(speakerHint, uiText.yourTurn, false);
          break;
        }

        const aiAlreadySpoke = didLastSpeechComeFrom(s, currentSpeaker.playerId);
        if (aiAlreadySpoke) {
          setWaitingForNextRound(true);
          break;
        }

        void runAISpeech(s, currentSpeaker);
        break;
      }

      case "DAY_LAST_WORDS": {
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;

        if (s.currentSpeakerSeat === null) {
          void proceedToNight(s, token);
          break;
        }

        const lastWordsSpeaker = s.players.find((p: Player) => p.seat === s.currentSpeakerSeat) || null;
        if (!lastWordsSpeaker || lastWordsSpeaker.alive) {
          void proceedToNight(s, token);
          break;
        }

        if (lastWordsSpeaker.isHuman) {
          setDialogue(speakerHint, uiText.yourTurn, false);
          break;
        }

        // 喵杀修正（第十二轮）：从存档恢复到「遗言阶段」时，AI 遗言必须自带收尾回调，
        // 否则发言结束后会被「推进发言者」逻辑接管（历史上表现为「又轮到下一位活着的人发言」）。
        // 这里补上 afterSpeech → 入夜，保证遗言是一次性收尾。
        void runAISpeech(s, lastWordsSpeaker, {
          afterSpeech: async (afterState) => {
            const proceedFn = proceedToNightRef.current;
            if (proceedFn) await proceedFn(afterState, token);
          },
        });
        break;
      }

      case "DAY_VOTE": {
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        // Vote safety net useEffect will handle this
        break;
      }

      default: {
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        console.warn(`[meowcha] Unhandled checkpoint resume for phase: ${s.phase}`);
        break;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============================================
  // 同步 gameStateRef
  // ============================================
  useEffect(() => {
    gameStateRef.current = gameState;

    // Dev Mode 容错
    const prevDevMutationId = prevDevMutationIdRef.current;
    const devMutationId = gameState.devMutationId;
    const devMutated =
      typeof devMutationId === "number" &&
      (typeof prevDevMutationId !== "number" || devMutationId !== prevDevMutationId);

    const phaseChanged = prevPhaseRef.current !== gameState.phase;
    const dayChanged = prevDayRef.current !== gameState.day;
    const hardReset = phaseChanged || dayChanged || !!gameState.devPhaseJump;

    if (devMutated) {
      flowController.current.interrupt();
      pendingStartStateRef.current = null;
      hasContinuedAfterRevealRef.current = false;

      if (waitingForNextRound) setWaitingForNextRound(false);
      if (isWaitingForAI) setIsWaitingForAI(false);

      if (hardReset) {
        afterLastWordsRef.current = null;
        nightContinueRef.current = null;
        voteContinueRef.current = null;
        clearSpeechQueue();
        if (currentDialogue) clearDialogue();
        if (inputText) setInputText("");
      } else {
        // Dev 动作编辑：可能中断了 runNightPhase 的后台推进。若关键数据已被用户补齐，则自动继续夜晚流程。
        // 注意：只在"软编辑"时尝试恢复，避免和显式跳转冲突。
        const s = gameState;
        (async () => {
          const token = flowController.current.getToken();

          // Night phases: if the required action is already set (possibly via Dev actions tab), continue.
          if (s.phase === "NIGHT_GUARD_ACTION") {
            const guard = s.players.find((p) => p.role === "Guard" && p.alive);
            if (!guard || s.nightActions.guardTarget !== undefined) {
              await runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_GUARD");
            }
            return;
          }

          if (s.phase === "NIGHT_WOLF_ACTION") {
            if (s.nightActions.wolfTarget !== undefined) {
              await runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WOLF");
            }
            return;
          }

          if (s.phase === "NIGHT_WITCH_ACTION") {
            const witch = s.players.find((p) => p.role === "Witch" && p.alive);
            const usedAll = s.roleAbilities.witchHealUsed && s.roleAbilities.witchPoisonUsed;
            const decided = s.nightActions.witchSave !== undefined || s.nightActions.witchPoison !== undefined;
            if (!witch || usedAll || decided) {
              await runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WITCH");
            }
            return;
          }

          if (s.phase === "NIGHT_SEER_ACTION") {
            if (s.nightActions.seerTarget !== undefined) {
              // 预言家已查验，设置 nightContinueRef 以便用户确认后继续
              nightContinueRef.current = async (state) => {
                await resolveNight(state, token, async (resolvedState) => {
                  await startDayPhaseInternal(resolvedState, token);
                });
              };
            }
            return;
          }

          if (s.phase === "DAY_VOTE") {
            const aliveIds = s.players.filter((p) => p.alive).map((p) => p.playerId);
            const allVoted = aliveIds.every((id) => typeof s.votes[id] === "number");
            if (allVoted) {
              await resolveVotePhase(s, token);
            }
          }
        })();
      }
    }

    prevPhaseRef.current = gameState.phase;
    prevDayRef.current = gameState.day;
    prevDevMutationIdRef.current = devMutationId;
  }, [gameState, currentDialogue, inputText, isWaitingForAI, waitingForNextRound, clearDialogue, clearSpeechQueue, setIsWaitingForAI, setWaitingForNextRound, runNightPhaseAction, resolveNight, startDayPhaseInternal, resolveVotePhase]);

  // ============================================
  // Dev Phase Jump 处理
  // ============================================
  useEffect(() => {
    if (mpIsGuest) return; // 联机客人：dev 跳阶段不适用
    const payload = gameState.devPhaseJump;
    if (!payload) return;
    if (prevDevPhaseJumpTsRef.current === payload.ts) return;
    prevDevPhaseJumpTsRef.current = payload.ts;

    flowController.current.interrupt();
    const token = getToken();
    const to = payload.to;
    const s = gameStateRef.current;

    const clearMark = () => {
      setGameState((prev) => {
        if (!prev.devPhaseJump || prev.devPhaseJump.ts !== payload.ts) return prev;
        return { ...prev, devPhaseJump: undefined };
      });
    };

    (async () => {
      try {
        if (to === "NIGHT_START" || to === "NIGHT_GUARD_ACTION") {
          if (isAwaitingRoleRevealRef.current) return;
          await runNightPhaseAction(s, token, "START_NIGHT");
          return;
        }
        if (to === "NIGHT_WOLF_ACTION") {
          await runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_GUARD");
          return;
        }
        if (to === "NIGHT_WITCH_ACTION") {
          await runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WOLF");
          return;
        }
        if (to === "NIGHT_SEER_ACTION") {
          await runNightPhaseAction(s, token, "CONTINUE_NIGHT_AFTER_WITCH");
          return;
        }
        if (to === "NIGHT_RESOLVE") {
          await resolveNight(s, token, async (resolvedState) => {
            await startDayPhaseInternal(resolvedState, token);
          });
          return;
        }
        if (to === "DAY_START" || to === "DAY_SPEECH") {
          await startDayPhaseInternal(s, token);
          return;
        }
        if (to === "DAY_VOTE") {
          await enterVotePhase(s, token);
          return;
        }
        if (to === "DAY_LAST_WORDS") {
          const seat = s.currentSpeakerSeat ?? s.players.find((p) => !p.alive)?.seat ?? 0;
          await startLastWordsPhase(s, seat, async (after) => {
            await proceedToNight(after, token);
          }, token);
          return;
        }
        if (to === "DAY_RESOLVE") {
          await resolveVotePhase(s, token);
          return;
        }
      } finally {
        clearMark();
      }
    })();
  }, [gameState.devPhaseJump, getToken, runNightPhaseAction, resolveNight, startDayPhaseInternal, enterVotePhase, startLastWordsPhase, resolveVotePhase, proceedToNight, setGameState]);

  /** 开始游戏 */
  const startGame = useCallback(async (options?: Partial<StartGameOptions>) => {
    const {
      fixedRoles,
      devPreset,
      difficulty = "normal",
      playerCount = 12,
      isGenshinMode = false,
      isSpectatorMode = false,
      customCharacters = [],
      preferredRole,
      houseRules,
    } = options ?? {};

    const totalPlayers = playerCount;

    resetDialogueState();
    setInputText("");
    setShowTable(false);
    pendingStartStateRef.current = null;
    hasContinuedAfterRevealRef.current = false;
    isAwaitingRoleRevealRef.current = false;
    badgeSpeechEndRef.current = null;
    voteContinueRef.current = null;
    if (showTableTimeoutRef.current !== null) {
      window.clearTimeout(showTableTimeoutRef.current);
      showTableTimeoutRef.current = null;
    }

    setIsLoading(true);
    try {
      // 初始化游戏统计追踪器
      const statsConfig = {
        playerCount,
        difficulty,
        usedCustomKey: isCustomKeyEnabled(),
      };
      gameStatsTracker.start(statsConfig);

      // 创建游戏会话记录（前端直接调用 Supabase）
      gameSessionTracker.start({
        playerCount,
        difficulty,
        usedCustomKey: isCustomKeyEnabled(),
        modelUsed: getGeneratorModel(),
      }).then((sessionId) => {
        if (sessionId) {
          gameStatsTracker.setSessionId(sessionId);
        }
      }).catch((err) => {
        console.error("[game-session] Failed to create:", err);
      });

      const systemMessages = getSystemMessages();
      const scenario = isGenshinMode ? undefined : getRandomScenario();
      const makeId = () => generateUUID();

      // 联机模式：真人座位由房主下发（humanSeats / humanNames）；单人/观众沿用旧行为
      const hostHumanSeats: number[] = isSpectatorMode
        ? []
        : options?.humanSeats && options.humanSeats.length > 0
          ? options.humanSeats.map((s) => s).sort((a, b) => a - b)
          : [0];
      const humanSeat = hostHumanSeats.length > 0 ? hostHumanSeats[0] : -1;

      const aiSeats = Array.from({ length: totalPlayers }, (_, seat) => seat).filter(
        (seat) => !hostHumanSeats.includes(seat)
      );
      const aiSeatOrder = (() => {
        const shuffled = [...aiSeats];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
      })();

      const aiModelRefs = sampleModelRefs(
        isSpectatorMode ? totalPlayers : Math.max(1, totalPlayers - hostHumanSeats.length)
      );
      // 喵杀：先生成各座位的 playerId，再由它派生本局唯一的萌猫花名册
      //（座位索引互不相同 → 同局内猫种绝不重复；offset 随本局 id 变化 → 每局阵容不同）
      const seedPlayerIds = Array.from({ length: totalPlayers }, () => makeId());
      const seatCatRoster = buildCatRoster(seedPlayerIds, totalPlayers);
      const initialPlayers: Player[] = Array.from({ length: totalPlayers }).map((_, seat) => {
        const isHuman = hostHumanSeats.includes(seat);
        return {
          playerId: seedPlayerIds[seat],
          seat,
          displayName: isHuman
            ? options?.humanNames?.[hostHumanSeats.indexOf(seat)] || humanName || "你"
            : "",
          avatarSeed: seatCatRoster[seat].token,
          alive: true,
          role: "Villager" as Role,
          alignment: "village",
          isHuman,
        };
      });

      setGameState({
        ...createInitialGameState(),
        scenario,
        players: initialPlayers,
        phase: "LOBBY",
        day: 0,
        difficulty,
        isGenshinMode,
        isSpectatorMode,
      });

      setGameStarted(true);
      setShowTable(true);

      let characters: GeneratedCharacter[] = [];
      let genshinModelRefs: ModelRef[] | undefined = undefined;
      const numAiPlayers = isSpectatorMode ? totalPlayers : totalPlayers - hostHumanSeats.length;

      // Convert custom characters to GeneratedCharacter format
      const customCharsToUse = customCharacters.slice(0, numAiPlayers);
      const customGeneratedCharacters: GeneratedCharacter[] = customCharsToUse.map((cc) => ({
        displayName: cc.display_name,
        persona: {
          styleLabel: "",
          voiceRules: cc.style_label?.trim() ? [cc.style_label.trim()] : [],
          mbti: cc.mbti || "",
          gender: cc.gender,
          age: cc.age,
          basicInfo: cc.basic_info?.trim() || undefined,
          voiceId: undefined,
        },
        avatarSeed: cc.avatar_seed || undefined,
      }));

      const applyCustomCharactersToState = (customList: GeneratedCharacter[]) => {
        if (customList.length === 0) return;
        const seatMap = new Map<number, { character: GeneratedCharacter; index: number }>();
        customList.forEach((character, index) => {
          const seat = aiSeatOrder[index] ?? index + 1;
          if (Number.isFinite(seat)) {
            seatMap.set(seat, { character, index });
          }
        });
        if (seatMap.size === 0) return;
        setGameState((prev) => {
          const nextPlayers = prev.players.map((pl) => {
            const match = seatMap.get(pl.seat);
            if (!match || pl.isHuman) return pl;
            return {
              ...pl,
              displayName: catNameForSeat(pl.seat, match.character.displayName),
              avatarSeed: catSeedForSeat(pl.seat, match.character.avatarSeed ?? pl.avatarSeed ?? pl.playerId),
              agentProfile: {
                modelRef: aiModelRefs[match.index] ?? getRandomModelRef(),
                persona: match.character.persona,
              },
            };
          });
          return { ...prev, players: nextPlayers };
        });
      };

      // Use custom characters if provided, otherwise generate
      const hasCustomCharacters = customGeneratedCharacters.length > 0;

      // 喵杀：自定义角色所在的座位保留玩家自填的名字，其余座位一律用「品种 小名」；
      //       头像 token 也统一走花名册，保证与最终 state 完全一致（这几处 setTimeout 可能在
      //       setupPlayers 之后才触发，所以必须在这里就写成猫名，避免把猫名又改回 AI 名）。
      const customSeatCount = customGeneratedCharacters.length;
      const customSeats = new Set(aiSeatOrder.slice(0, customSeatCount));
      const catNameForSeat = (seat: number, fallback: string) =>
        customSeats.has(seat) ? fallback : (seatCatRoster[seat]?.displayName ?? fallback);
      const catSeedForSeat = (seat: number, fallback: string) =>
        seatCatRoster[seat]?.token ?? fallback;
      // 喵杀：「逐个现身」的定时器可能在「重开一局」之后才触发 —— 只按 seat 比对会串场，
      //      会拿旧局的花名册去改新局玩家的名字/头像（导致同局猫种重复）。用 playerId 兜底。
      const isSameGameSeat = (players: Player[], seat: number) =>
        players.find((p) => p.seat === seat)?.playerId === seedPlayerIds[seat];

      if (hasCustomCharacters) {
        applyCustomCharactersToState(customGeneratedCharacters);
        // Fill remaining slots with generated characters if needed
        const remainingCount = numAiPlayers - customGeneratedCharacters.length;
        if (remainingCount > 0) {
          const extraCharacters = await generateCharacters(remainingCount, scenario, {});
          characters = [...customGeneratedCharacters, ...extraCharacters];
        } else {
          characters = customGeneratedCharacters;
        }
        
        // Custom characters appear immediately (no delay), generated ones animate in
        const customCount = customGeneratedCharacters.length;
        characters.forEach((character, index) => {
          const seat = aiSeatOrder[index] ?? index + 1;
          const isCustom = index < customCount;
          const delay = isCustom ? 0 : 200 + (index - customCount) * 180;
          
          window.setTimeout(() => {
            setGameState((prev) => {
              if (!isSameGameSeat(prev.players, seat)) return prev;
              const nextPlayers = prev.players.map((pl) => {
                if (pl.seat !== seat) return pl;
                if (pl.isHuman) return pl;
                return {
                  ...pl,
                  displayName: catNameForSeat(seat, character.displayName),
                  avatarSeed: catSeedForSeat(seat, character.avatarSeed ?? pl.avatarSeed ?? pl.playerId),
                  agentProfile: {
                    modelRef: aiModelRefs[index] ?? getRandomModelRef(),
                    persona: character.persona,
                  },
                };
              });
              return { ...prev, players: nextPlayers };
            });
          }, delay);
        });
      } else if (isGenshinMode) {
        genshinModelRefs = buildGenshinModelRefs(numAiPlayers);
        characters = await generateGenshinModeCharacters(numAiPlayers, genshinModelRefs);
        
        // 为 Genshin 模式添加逐个出现的动画效果
        characters.forEach((character, index) => {
          const seat = aiSeatOrder[index] ?? index + 1;
          window.setTimeout(() => {
            setGameState((prev) => {
              if (!isSameGameSeat(prev.players, seat)) return prev;
              const nextPlayers = prev.players.map((pl) => {
                if (pl.seat !== seat) return pl;
                if (pl.isHuman) return pl;
                return {
                  ...pl,
                  displayName: catNameForSeat(seat, character.displayName),
                  avatarSeed: catSeedForSeat(seat, pl.avatarSeed ?? pl.playerId),
                  agentProfile: {
                    modelRef: genshinModelRefs![index] ?? getRandomModelRef(),
                    persona: character.persona,
                  },
                };
              });
              return { ...prev, players: nextPlayers };
            });
          }, 200 + index * 180); // 逐个出现，每个间隔 180ms
        });
      } else {
        characters = await generateCharacters(numAiPlayers, scenario, {
          onBaseProfiles: (profiles) => {
            profiles.forEach((p, i) => {
              const seat = aiSeatOrder[i] ?? i + 1;
              window.setTimeout(() => {
                setGameState((prev) => {
                  if (!isSameGameSeat(prev.players, seat)) return prev;
                  const nextPlayers = prev.players.map((pl) => {
                    if (pl.seat === seat) return { ...pl, displayName: catNameForSeat(seat, p.displayName) };
                    return pl;
                  });
                  return { ...prev, players: nextPlayers };
                });
              }, 420 + i * 260);
            });
          },
          onCharacter: (index, character) => {
            const seat = aiSeatOrder[index] ?? index + 1;
            window.setTimeout(() => {
              setGameState((prev) => {
                if (!isSameGameSeat(prev.players, seat)) return prev;
                const nextPlayers = prev.players.map((pl) => {
                  if (pl.seat !== seat) return pl;
                  if (pl.isHuman) return pl;
                  return {
                    ...pl,
                    displayName: catNameForSeat(seat, character.displayName),
                  avatarSeed: catSeedForSeat(seat, pl.avatarSeed ?? pl.playerId),
                    agentProfile: {
                      modelRef: aiModelRefs[index] ?? getRandomModelRef(),
                      persona: character.persona,
                    },
                  };
                });
                return { ...prev, players: nextPlayers };
              });
            }, 120);
          },
        });
      }

      const playersRaw = setupPlayers(
        characters,
        humanSeat,
        humanName || "你",
        totalPlayers,
        fixedRoles,
        seedPlayerIds,
        isGenshinMode ? genshinModelRefs : aiModelRefs,
        aiSeatOrder,
        preferredRole
      );

      // 喵杀：最终落位「萌猫身份」——头像 token 一律走花名册；AI 座位用「品种 小名」，
      //       人类玩家与自定义角色保留自己的名字。此处是权威收尾（上面的定时器中间态也已是猫名）。
      // 喵杀：顺便给每个 AI 角色分配「不重复」的语音音色 ——
      // 原 resolveVoiceId 兜底取「第一个匹配项」，同性别+同年龄段会撞音，一局里就会出现一样的嗓音。
      const usedVoiceIds = new Set<string>();
      const players = playersRaw.map((pl) => {
        const cat = seatCatRoster[pl.seat];
        if (!cat) return pl;
        const keepOwnName = pl.isHuman || customSeats.has(pl.seat);
        let agentProfile = pl.agentProfile;
        if (!pl.isHuman && agentProfile?.persona) {
          const voiceId = pickUnusedVoiceId(usedVoiceIds, agentProfile.persona.gender, agentProfile.persona.age);
          usedVoiceIds.add(voiceId);
          agentProfile = { ...agentProfile, persona: { ...agentProfile.persona, voiceId } };
        }
        return {
          ...pl,
          displayName: keepOwnName ? pl.displayName : cat.displayName,
          avatarSeed: catSeedForSeat(pl.seat, pl.avatarSeed ?? pl.playerId),
          agentProfile,
        };
      })
        // 联机追加：房主之外的真人座位（setupPlayers 只认单人，故此处补标 isHuman + 用他们的昵称）
        .map((pl) => {
          const idx = hostHumanSeats.indexOf(pl.seat);
          if (idx <= 0) return pl;
          return {
            ...pl,
            isHuman: true,
            displayName: options?.humanNames?.[idx] || pl.displayName,
            agentProfile: undefined,
          };
        });

      let newState: GameState = {
        ...createInitialGameState(),
        scenario,
        players,
        phase: "NIGHT_START",
        day: 1,
        difficulty,
        isGenshinMode,
        isSpectatorMode,
        houseRules,
      };

      newState = addSystemMessage(newState, systemMessages.gameStart);
      newState = addSystemMessage(newState, systemMessages.nightFall(1));

      // Dev 预设处理
      if (devPreset === "MILK_POISON_TEST") {
        const newPlayers = newState.players.map((p, i) => {
          if (i === 0) return { ...p, role: "Guard" as Role, alignment: "village" as const, alive: true };
          if (i === 1) return { ...p, role: "Witch" as Role, alignment: "village" as const, alive: true };
          if (i === 2) return { ...p, role: "Werewolf" as Role, alignment: "wolf" as const, alive: true };
          if (i === 3) return { ...p, role: "Villager" as Role, alignment: "village" as const, alive: true };
          return { ...p, alive: true };
        });
        newState = {
          ...newState,
          players: newPlayers,
          phase: "NIGHT_WITCH_ACTION",
          day: 1,
          devMutationId: (newState.devMutationId ?? 0) + 1,
          devPhaseJump: { to: "NIGHT_WITCH_ACTION", ts: Date.now() },
          nightActions: {
            ...newState.nightActions,
            guardTarget: 3,
            wolfTarget: 3,
          },
          roleAbilities: {
            ...newState.roleAbilities,
            witchHealUsed: false,
            witchPoisonUsed: false,
            hunterCanShoot: true,
          },
        };
      } else if (devPreset === "LAST_WORDS_TEST") {
        const alivePlayers = newState.players.filter((p) => p.alive);
        const votes: Record<string, number> = {};
        alivePlayers.forEach((p) => {
          votes[p.playerId] = 0;
        });
        newState = {
          ...newState,
          phase: "DAY_VOTE",
          day: 1,
          devMutationId: (newState.devMutationId ?? 0) + 1,
          devPhaseJump: { to: "DAY_VOTE", ts: Date.now() },
          votes,
        };
      }

      setGameState(newState);

      // In spectator mode, skip role reveal and start the game immediately
      if (isSpectatorMode) {
        pendingStartStateRef.current = null;
        hasContinuedAfterRevealRef.current = true;
        isAwaitingRoleRevealRef.current = false;
        
        // Start the night phase directly
        const token = getToken();
        if (isTokenValid(token)) {
          const systemMessages = getSystemMessages();
          setDialogue(speakerHost, systemMessages.nightFall(newState.day), false);
          await playNarrator("nightFall");
          await runNightPhaseAction(newState, token, "START_NIGHT");
        }
      } else {
        pendingStartStateRef.current = devPreset ? null : newState;
        hasContinuedAfterRevealRef.current = false;
        isAwaitingRoleRevealRef.current = true;
      }
    } catch (error) {
      const msg = String(error);
      if (isQuotaExhaustedMessage(msg)) {
        toast.error(t("gameLogicMessages.quotaExhausted.title"), {
          description: t("gameLogicMessages.quotaExhausted.description"),
          duration: 10000,
        });
      } else if (msg.includes("ZenMux API error: 401") || msg.includes(" 401")) {
        toast.error(t("gameLogicMessages.zenmux401"));
      } else {
        toast.error(t("gameLogicMessages.requestFailed"), { description: msg });
      }
      setDialogue(t("speakers.system"), t("gameLogicMessages.errorOccurred", { error: String(error) }), false);
      setGameStarted(false);
      setShowTable(false);
    } finally {
      setIsLoading(false);
    }
  }, [humanName, resetDialogueState, setDialogue, setGameStarted, setGameState, setInputText, setIsLoading, setShowTable, t]);

  /** 角色揭示后继续 */
  const continueAfterRoleReveal = useCallback(async () => {
    const token = getToken();
    const pending = pendingStartStateRef.current;
    if (!pending) return;
    if (hasContinuedAfterRevealRef.current) return;

    hasContinuedAfterRevealRef.current = true;
    pendingStartStateRef.current = null;
    isAwaitingRoleRevealRef.current = false;

    if (!isTokenValid(token)) return;

    const systemMessages = getSystemMessages();

    // Set dialogue before playing audio so message box appears immediately
    setDialogue(speakerHost, systemMessages.nightFall(pending.day), false);
    
    // 播放第一晚的"天黑请闭眼"旁白
    await playNarrator("nightFall");
    
    await runNightPhaseAction(pending, token, "START_NIGHT");
  }, [getToken, isTokenValid, runNightPhaseAction, setDialogue, speakerHost]);

  /** 重新开始 */
  const restartGame = useCallback(() => {
    flowController.current.interrupt();
    clearPersistedGameState();
    setGameState(createInitialGameState());
    resetDialogueState();
    setInputText("");
    setShowTable(false);
    setGameStarted(false);

    pendingStartStateRef.current = null;
    hasContinuedAfterRevealRef.current = false;
    isAwaitingRoleRevealRef.current = false;
    badgeSpeechEndRef.current = null;
    voteContinueRef.current = null;
    if (showTableTimeoutRef.current !== null) {
      window.clearTimeout(showTableTimeoutRef.current);
      showTableTimeoutRef.current = null;
    }
  }, [setGameState, resetDialogueState]);

  /**
   * 联机：取「本次操作的执行者」。
   * 传 actorSeat（远程真人所在座位）→ 用那个座位；不传 → 用本机真人。
   */
  const resolveActor = useCallback(
    (actorSeat?: number): Player | null => {
      const s = gameStateRef.current;
      if (typeof actorSeat === "number" && actorSeat >= 0) {
        return s.players.find((p) => p.seat === actorSeat) || null;
      }
      return (
        s.players.find((p) => p.isHuman && (mpLocalSeat < 0 || p.seat === mpLocalSeat)) || null
      );
    },
    [mpLocalSeat]
  );

  /** 人类发言（actorSeat/text 供联机远程座位调用） */
  const handleHumanSpeech = useCallback(async (actorSeat?: number, textOverride?: string) => {
    const actor = resolveActor(actorSeat);
    const speech = (textOverride ?? inputText).trim();
    if (!speech || !actor) return;

    const s = gameStateRef.current;
    // 喵杀修复（2026-10-18 · 站长实测）：死人只能在遗言阶段说话，
    // 防止出局后仍被当成白天发言者、把「遗言」误推进成投票。
    if (!actor.alive && s.phase !== "DAY_LAST_WORDS") return;
    const isMyTurn = (s.phase === "DAY_SPEECH" || s.phase === "DAY_LAST_WORDS" || s.phase === "DAY_BADGE_SPEECH" || s.phase === "DAY_PK_SPEECH") && s.currentSpeakerSeat === actor.seat;
    if (!isMyTurn) return;

    // 本机输入才清空输入框；远程发言不能动本地草稿
    if (textOverride === undefined) setInputText("");

    const currentState = addPlayerMessage(gameStateRef.current, actor.playerId, speech);
    gameStateRef.current = currentState;
    setGameState(currentState);
  }, [inputText, resolveActor, setGameState]);

  /** 人类结束发言 */
  const handleFinishSpeaking = useCallback(async (actorSeat?: number) => {
    const actor = resolveActor(actorSeat);
    if (!actor) return;

    const phase = gameStateRef.current.phase;
    if (!actor.alive && phase !== "DAY_LAST_WORDS") return;

    const speechPhases = ["DAY_SPEECH", "DAY_BADGE_SPEECH", "DAY_PK_SPEECH", "DAY_LAST_WORDS"];
    if (!speechPhases.includes(phase)) return;
    if (gameStateRef.current.currentSpeakerSeat !== actor.seat) return;

    // 喵杀优化（2026-10-18 · 站长实测）：真人直接点「结束发言」、一句话都没说时，
    // 自动补一句随机的「空发言」并写入当天记录。否则发言顺序表会认为他没说过，
    // 下一位（警长）说完后又把他排回来，形成 1/2 → 警长 → 1/2 的循环。
    const currentState = gameStateRef.current;
    const hasSpokenThisTurn = currentState.messages.some(
      (m) =>
        !m.isSystem &&
        m.day === currentState.day &&
        m.phase === currentState.phase &&
        m.playerId === actor.playerId
    );
    if (!hasSpokenThisTurn) {
      const lines = getEmptySpeechLines();
      const pool = phase === "DAY_LAST_WORDS" ? lines.lastWords : lines.speech;
      const fallback = pool[Math.floor(Math.random() * pool.length)] || "";
      if (fallback) {
        const nextState = addPlayerMessage(currentState, actor.playerId, fallback);
        gameStateRef.current = nextState;
        setGameState(nextState);
      }
    }

    if (phase === "DAY_LAST_WORDS") {
      if (lastWordsFinishingRef.current) return;
      lastWordsFinishingRef.current = true;
      try {
        const next = afterLastWordsRef.current;
        afterLastWordsRef.current = null;
        await delay(500);
        if (next) {
          await next(gameStateRef.current);
        } else {
          // 喵杀修正（第十二轮）：从存档恢复到遗言阶段时 afterLastWordsRef 为空，
          // 之前会直接 return 导致流程卡死；这里兜底直接入夜，保证遗言是一次性收尾。
          const proceedFn = proceedToNightRef.current;
          if (proceedFn) await proceedFn(gameStateRef.current, getToken());
        }
      } finally {
        lastWordsFinishingRef.current = false;
      }
      return;
    }

    const startState = gameStateRef.current;
    const startGameId = startState.gameId;
    const startPhase = startState.phase;

    await delay(300);

    const liveState = gameStateRef.current;
    if (liveState.gameId !== startGameId) return;
    if (liveState.phase !== startPhase) return;

    const token = getToken();
    await runDaySpeechAction(liveState, token, "ADVANCE_SPEAKER");
  }, [resolveActor, getToken, runDaySpeechAction, setGameState]);

  /**
   * 喵杀修复（2026-10-18 · 站长实测）：人类遗言超时自动收尾。
   * 联机时有人出局后不点「结束发言」，整局会一直卡在遗言阶段；
   * 60 秒后由房主自动推进到夜晚，并在对话框/状态条明确提示。
   */
  useEffect(() => {
    if (mpIsGuest) return;
    if (gameState.phase !== "DAY_LAST_WORDS") return;
    const speaker = gameState.players.find((p) => p.seat === gameState.currentSpeakerSeat);
    if (!speaker?.isHuman) return;

    const gameId = gameState.gameId;
    const seat = speaker.seat;
    const timer = window.setTimeout(() => {
      const live = gameStateRef.current;
      if (
        live.gameId !== gameId ||
        live.phase !== "DAY_LAST_WORDS" ||
        live.currentSpeakerSeat !== seat
      ) {
        return;
      }
      console.info(`[meowcha] 遗言超时（60s）：自动结束 ${seat + 1}号 的遗言并进入夜晚`);
      void handleFinishSpeaking(seat);
    }, 60_000);

    return () => window.clearTimeout(timer);
  }, [gameState.phase, gameState.currentSpeakerSeat, gameState.gameId, gameState.players, mpIsGuest, handleFinishSpeaking]);

  /**
   * 发言阶段看门狗：房主/单人这边如果当前是 AI，却既没有在生成（isWaitingForAI=false）、
   * 也没有活动语音队列，超过 8 秒就强制推进到下一位。
   * 用于兜底流式请求静默失败、旧操作把 currentSpeakerSeat 卡在某人身上的情况。
   */
  const speechWatchdogRef = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (mpIsGuest) {
      speechWatchdogRef.current = null;
      return;
    }
    const speechPhases = ["DAY_SPEECH", "DAY_BADGE_SPEECH", "DAY_PK_SPEECH"];
    if (!speechPhases.includes(gameState.phase)) {
      speechWatchdogRef.current = null;
      return;
    }
    const speaker = gameState.players.find((p) => p.seat === gameState.currentSpeakerSeat);
    if (!speaker || speaker.isHuman || !speaker.alive) {
      speechWatchdogRef.current = null;
      return;
    }
    if (isWaitingForAI || getSpeechQueue()) {
      speechWatchdogRef.current = null;
      return;
    }

    const key = `${gameState.gameId}:${gameState.day}:${gameState.phase}:${gameState.currentSpeakerSeat}`;
    if (!speechWatchdogRef.current || speechWatchdogRef.current.key !== key) {
      speechWatchdogRef.current = { key, at: Date.now() };
      return;
    }
    if (Date.now() - speechWatchdogRef.current.at < 8000) return;

    speechWatchdogRef.current = null;
    console.warn(
      `[meowcha] 发言看门狗：${speaker.seat + 1}号 AI 无活动语音队列，自动推进避免卡死`
    );
    void handleNextRoundRef.current?.();
  }, [
    mpIsGuest,
    gameState.phase,
    gameState.day,
    gameState.gameId,
    gameState.currentSpeakerSeat,
    gameState.players,
    isWaitingForAI,
    getSpeechQueue,
  ]);

  /** 下一轮按钮 */
  const handleNextRound = useCallback(async () => {
    const startState = gameStateRef.current;
    const startGameId = startState.gameId;
    const startPhase = startState.phase;

    // 喵杀修正（第十二轮）：遗言阶段不参与「下一轮/推进发言者」流程——它是一次性收尾，
    // 只会通过 afterLastWords（→入夜）结束。历史上把它当成可推进阶段，导致「遗言说完后
    // 又轮到下一位活着的人发言」。这里直接把它从可推进集合里移除。
    if (startPhase !== "DAY_SPEECH" && startPhase !== "DAY_BADGE_SPEECH" && startPhase !== "DAY_PK_SPEECH") {
      return;
    }

    setWaitingForNextRound(false);
    await delay(300);

    const liveState = gameStateRef.current;
    if (liveState.gameId !== startGameId) return;
    if (liveState.phase !== startPhase) return;

    const token = getToken();
    await runDaySpeechAction(liveState, token, "ADVANCE_SPEAKER");
  }, [getToken, runDaySpeechAction, setWaitingForNextRound]);
  handleNextRoundRef.current = handleNextRound;

  /** 人类投票（actorSeat 供联机远程座位调用） */
  const handleHumanVote = useCallback(async (targetSeat: number, actorSeat?: number) => {
    const actor = resolveActor(actorSeat);
    if (!actor) return;
    if (!actor.alive) return;

    const baseState = gameStateRef.current;
    if (baseState.phase !== "DAY_VOTE" && baseState.phase !== "DAY_BADGE_ELECTION") return;
    const targetPlayer = baseState.players.find((p) => p.seat === targetSeat);
    if (!targetPlayer || !targetPlayer.alive) return;
    if (typeof baseState.votes[actor.playerId] === "number") return;

    if (baseState.phase === "DAY_BADGE_ELECTION") {
      const candidates = baseState.badge.candidates || [];
      if (candidates.includes(actor.seat)) {
        console.warn("[meowcha] Candidate cannot vote in badge election");
        return;
      }

      const nextState: GameState = {
        ...baseState,
        badge: {
          ...baseState.badge,
          votes: { ...baseState.badge.votes, [actor.playerId]: targetSeat },
        },
      };
      setGameState(nextState);
      gameStateRef.current = nextState;

      await delay(200);
      await badgePhase.maybeResolveBadgeElection(nextState);
      return;
    }

    if (baseState.pkSource === "vote" && Array.isArray(baseState.pkTargets) && baseState.pkTargets.length > 0) {
      if (!baseState.pkTargets.includes(targetSeat)) {
        console.warn("[meowcha] Vote target not in PK list");
        return;
      }
    }

    // 使用函数式更新确保获取最新状态（解决AI投票后状态同步问题）
    let updatedState: GameState | null = null;
    setGameState((prevState) => {
      updatedState = {
        ...prevState,
        votes: { ...prevState.votes, [actor.playerId]: targetSeat },
      };
      return updatedState;
    });

    // 等待状态更新完成
    await delay(200);
    
    // 从 ref 获取最新状态（setGameState 的函数式更新会确保 prevState 是最新的）
    const latestState = updatedState || gameStateRef.current;
    gameStateRef.current = latestState;

    // 检查是否所有人都投票了（PK目标 / 已翻牌白痴不参与投票）
    const eligibleIds = getEligibleVoterIds(latestState);
    const allVoted =
      eligibleIds.length === 0 ||
      eligibleIds.every((id) => typeof latestState.votes[id] === "number");
    
    console.log("[meowcha] handleHumanVote: allVoted =", allVoted, "votes count =", Object.keys(latestState.votes).length, "eligible count =", eligibleIds.length);
    
    if (allVoted && !isWaitingForAI) {
      const token = getToken();
      await resolveVotesSafely(latestState, token);
    }
  }, [resolveActor, setGameState, badgePhase, getToken, resolveVotesSafely, isWaitingForAI]);

  /** 夜晚行动（actorSeat 供联机远程座位调用） */
  const handleNightAction = useCallback(async (targetSeat: number, witchAction?: "save" | "poison" | "pass", actorSeat?: number) => {
    const actor = resolveActor(actorSeat);
    if (!actor) return;
    if (!actor.alive && gameState.phase !== "HUNTER_SHOOT") return;

    // 喵杀（十七轮 · 站长联机实测）：下面对白（守护了谁 / 刀了谁 / 用了什么药 / 查验结果）都是
    // **当事人私密信息**。远程真人（朋友的狼、女巫、预言家）提交动作时，房主这边原本也会把
    // 这些文案打出来 —— 房主是村民就会看到「狼队已决定击杀X号」，等于直接剧透。
    // 现在：只有「本机操控的那一位」才看到私密确认；别人提交时静默（局面照常推进）。
    const isLocalActor =
      !(typeof actorSeat === "number" && actorSeat >= 0 && mpLocalSeat >= 0 && actorSeat !== mpLocalSeat);

    const token = getToken();
    const systemMessages = getSystemMessages();
    let currentState = gameState;

    // 守卫保护
    if (gameState.phase === "NIGHT_GUARD_ACTION" && actor.role === "Guard") {
      if (currentState.nightActions.lastGuardTarget === targetSeat) {
        // 远程真人（别人的守卫）提交时不要在本机弹这个提示，否则等于暴露「他才是守卫」
        if (isLocalActor) toast.error(t("gameLogicMessages.guardNoRepeat"));
        return;
      }
      const targetPlayer = currentState.players.find((p) => p.seat === targetSeat);
      currentState = {
        ...currentState,
        nightActions: { ...currentState.nightActions, guardTarget: targetSeat },
      };
      if (isLocalActor) {
        setDialogue(t("speakers.system"), t("gameLogicMessages.youProtected", { seat: targetSeat + 1, name: targetPlayer?.displayName || "" }), false);
      }
      setGameState(currentState);

      await delay(1000);
      await waitForUnpause();
      await runNightPhaseAction(currentState, token, "CONTINUE_NIGHT_AFTER_GUARD");
    }
    // 狼人击杀
    else if (gameState.phase === "NIGHT_WOLF_ACTION" && isWolfRole(actor.role)) {
      const targetPlayer = currentState.players.find((p) => p.seat === targetSeat);
      const wolves = currentState.players.filter((p) => isWolfRole(p.role) && p.alive);
      
      // 简化逻辑：人类狼人决定目标，其他AI狼人自动达成共识
      const wolfVotes: Record<string, number> = {};
      for (const wolf of wolves) {
        wolfVotes[wolf.playerId] = targetSeat;
      }

      currentState = {
        ...currentState,
        nightActions: { ...currentState.nightActions, wolfVotes, wolfTarget: targetSeat },
      };
      
      // 显示狼队达成一致的确认消息（仅本机狼可见；远程狼提交时静默，避免房主看到刀口）
      if (isLocalActor) {
        setDialogue(t("speakers.system"), t("gameLogicMessages.wolfDecided", { seat: targetSeat + 1, name: targetPlayer?.displayName || "" }), false);
      }
      setGameState(currentState);

      await delay(800);
      await waitForUnpause();
      await runNightPhaseAction(currentState, token, "CONTINUE_NIGHT_AFTER_WOLF");
    }
    // 女巫用药
    else if (gameState.phase === "NIGHT_WITCH_ACTION" && actor.role === "Witch") {
      if (witchAction === "save" && !currentState.roleAbilities.witchHealUsed) {
        const rules = effectiveRules(currentState.houseRules);
        const isSelfTarget = currentState.nightActions.wolfTarget === actor.seat;
        const selfSaveAllowed =
          rules.witchSelfSave === "always" ||
          (rules.witchSelfSave === "firstNightOnly" && currentState.day === 1);
        if (isSelfTarget && !selfSaveAllowed) {
          if (isLocalActor) toast.error("本局规则不允许女巫自救");
        } else {
          currentState = {
            ...currentState,
            nightActions: { ...currentState.nightActions, witchSave: true },
            roleAbilities: { ...currentState.roleAbilities, witchHealUsed: true },
          };
          if (isLocalActor) setDialogue(t("speakers.system"), t("gameLogicMessages.usedAntidote"), false);
        }
      } else if (witchAction === "poison" && !currentState.roleAbilities.witchPoisonUsed) {
        const targetPlayer = currentState.players.find((p) => p.seat === targetSeat);
        // 喵杀修复：人类女巫的毒药目标需要校验（与 AI 侧一致）——
        // 原实现直接照收目标，而 canSelectPlayer 也不排除自己，导致人类可以毒自己。
        if (!targetPlayer || targetPlayer.seat === actor.seat) {
          if (isLocalActor) setDialogue(t("speakers.system"), t("gameLogicMessages.noPotion"), false);
          setGameState(currentState);
          await delay(800);
          await waitForUnpause();
          await runNightPhaseAction(currentState, token, "CONTINUE_NIGHT_AFTER_WITCH");
          return;
        }
        currentState = {
          ...currentState,
          nightActions: { ...currentState.nightActions, witchPoison: targetSeat },
          roleAbilities: { ...currentState.roleAbilities, witchPoisonUsed: true },
        };
        if (isLocalActor) setDialogue(t("speakers.system"), t("gameLogicMessages.usedPoison", { seat: targetSeat + 1, name: targetPlayer?.displayName || "" }), false);
      } else {
        if (isLocalActor) setDialogue(t("speakers.system"), t("gameLogicMessages.noPotion"), false);
      }
      setGameState(currentState);

      await delay(800);
      await waitForUnpause();
      await runNightPhaseAction(currentState, token, "CONTINUE_NIGHT_AFTER_WITCH");
    }
    // 预言家查验
    else if (gameState.phase === "NIGHT_SEER_ACTION" && actor.role === "Seer") {
      // Check if seer has already checked this night
      if (currentState.nightActions.seerTarget !== undefined) {
        return;
      }
      const targetPlayer = currentState.players.find((p) => p.seat === targetSeat);
      const isWolf = isWolfRole(targetPlayer?.role);
      const seerHistory = currentState.nightActions.seerHistory || [];

      currentState = {
        ...currentState,
        nightActions: {
          ...currentState.nightActions,
          seerTarget: targetSeat,
          seerResult: { targetSeat, isWolf: isWolf || false },
          seerHistory: [...seerHistory, { targetSeat, isWolf: isWolf || false, day: currentState.day }],
        },
      };
      // 查验结果只有预言家本人可见（远程预言家提交时房主不该看到）
      if (isLocalActor) {
        setDialogue(t("speakers.seerResult"), t("gameLogicMessages.seerResultText", { seat: targetSeat + 1, name: targetPlayer?.displayName || "", result: isWolf ? t("gameLogicMessages.werewolfResult") : t("gameLogicMessages.goodResult") }), false);
      }
      setGameState(currentState);

      // 喵杀修复（2026-10-18 · 站长实测）：人类预言家「快速查验后卡死」。
      // 原实现把「继续」交给 nightContinueRef 等玩家点击，但夜间没人说话时对话框会被
      // 「夜晚等待状态」彩色卡片取代（那一屏没有可点的对话框），于是卡在「预言家请睁眼」。
      // 守卫 / 狼人 / 女巫都是「延时若干毫秒 → 自动 CONTINUE_NIGHT_AFTER_*」，只有预言家例外。
      // 现在与其它神职保持一致：展示查验结果（同时长期挂在玩家卡片上）→ 稍等片刻 → 自动进入天亮结算。
      nightContinueRef.current = null; // 防止别处残留的回调把这一夜结算两次
      await delay(2200);
      if (!isTokenValid(token)) return;
      await waitForUnpause();
      await resolveNight(currentState, token, async (resolvedState) => {
        await startDayPhaseInternal(resolvedState, token);
      });
      return;
    }
    // 猎人开枪
    else if (gameState.phase === "HUNTER_SHOOT" && actor.role === "Hunter") {
      const diedAtNight = currentState.hunterDiedAtNight ?? true;
      if (targetSeat >= 0) {
        currentState = killPlayer(currentState, targetSeat);
        const target = currentState.players.find((p) => p.seat === targetSeat);
        if (target) {
          currentState = addSystemMessage(currentState, systemMessages.hunterShoot(actor.seat + 1, targetSeat + 1, target.displayName));
          setDialogue(speakerHost, systemMessages.hunterShoot(actor.seat + 1, targetSeat + 1, target.displayName), false);
        }

        const shot = { hunterSeat: actor.seat, targetSeat };
        if (diedAtNight) {
          const prevNightRecord = (currentState.nightHistory || {})[currentState.day] || {};
          currentState = {
            ...currentState,
            nightHistory: {
              ...(currentState.nightHistory || {}),
              [currentState.day]: { ...prevNightRecord, hunterShot: shot },
            },
          };
        } else {
          const prevDayRecord = (currentState.dayHistory || {})[currentState.day] || {};
          currentState = {
            ...currentState,
            dayHistory: {
              ...(currentState.dayHistory || {}),
              [currentState.day]: { ...prevDayRecord, hunterShot: shot },
            },
          };
        }
        setGameState(currentState);
      }

      const winner = checkWinCondition(currentState);
      if (winner) {
        await endGameSafely(currentState, winner);
        return;
      }

      await delay(1200);
      if (diedAtNight) {
        currentState = transitionPhase(currentState, "DAY_START");
        currentState = addSystemMessage(currentState, systemMessages.dayBreak);
        setGameState(currentState);
        await delay(800);
        await startDayPhaseInternal(currentState, token, { skipAnnouncements: true });
      } else {
        await proceedToNight(currentState, token);
      }
    }
  }, [gameState, mpLocalSeat, resolveActor, setGameState, setDialogue, setIsWaitingForAI, waitForUnpause, getToken, runNightPhaseAction, resolveNight, startDayPhaseInternal, proceedToNight, endGame, transitionPhase, speakerHost, t]);

  /** 人类警长移交（actorSeat 供联机远程座位调用） */
  const handleHumanBadgeTransfer = useCallback(async (targetSeat: number, actorSeat?: number) => {
    await badgePhase.handleHumanBadgeTransfer(targetSeat, actorSeat);
  }, [badgePhase]);

  /**
   * 人类白狼王自爆（actorSeat 供联机远程座位调用）。
   * 喵杀（2026-10-17）：站长要求「人类玩白狼王也要有对应能力」——
   * 此前自爆只在 AI 路径（wwkBoomCheckRef）里有，人类抽到白狼王无法发动。
   * 现在：白天发言阶段可点选一名存活玩家作为带走目标 → 触发宣言 + 自爆（与 AI 共用执行器）。
   */
  const handleHumanWhiteWolfKingBoom = useCallback(async (targetSeat: number, actorSeat?: number) => {
    const actor = resolveActor(actorSeat);
    if (!actor || !actor.alive) return;
    if (actor.role !== "WhiteWolfKing") return;
    const baseState = gameStateRef.current;
    if (baseState.phase !== "DAY_SPEECH" && baseState.phase !== "DAY_PK_SPEECH") return;
    if (baseState.roleAbilities.whiteWolfKingBoomUsed) return;
    if (!effectiveRules(baseState.houseRules).whiteWolfKingCanBoom) return;
    if (targetSeat < 0 || targetSeat === actor.seat) return;
    const target = baseState.players.find((p) => p.seat === targetSeat && p.alive);
    if (!target) return;
    const token = getToken();
    const fn = wwkBoomExecuteRef.current;
    if (!fn) return;
    await fn(baseState, actor, targetSeat, token);
  }, [resolveActor, getToken]);

  /** 推进发言 */
  const advanceSpeech = useCallback(async (): Promise<{ finished: boolean; shouldAdvanceToNextSpeaker: boolean; shouldAutoAdvanceToNextAI: boolean }> => {
    // 喵杀（十三轮）：若正挂着「投票结算后续程」在等玩家确认，这一次推进先把它跑掉。
    // （玩家看到的仍是投票结果，按键/点击即等于「确认」，与对话推进同一套手感。）
    if (voteContinueRef.current && !gameStateRef.current.winner) {
      const cont = voteContinueRef.current;
      voteContinueRef.current = null;
      clearDialogue();
      setIsWaitingForAI(false);
      setWaitingForNextRound(false);
      await cont(gameStateRef.current);
      return { finished: true, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };
    }

    if (gameStateRef.current.phase === "GAME_END" || gameStateRef.current.winner) {
      clearSpeechQueue();
      clearDialogue();
      setIsWaitingForAI(false);
      setWaitingForNextRound(false);
      return { finished: true, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };
    }
    if (gameStateRef.current.phase.includes("NIGHT")) {
      const cont = nightContinueRef.current;
      if (cont) {
        nightContinueRef.current = null;
        clearDialogue();
        setIsWaitingForAI(false);
        setWaitingForNextRound(false);
        await cont(gameStateRef.current);
        return { finished: true, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };
      }
      return { finished: false, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };
    }

    const queue = getSpeechQueue();
    if (!queue) {
      return { finished: false, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };
    }

    if (queue.isStreaming && !isCurrentSegmentCompleted()) {
      return { finished: false, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };
    }

    const { segments, currentIndex, player, afterSpeech } = queue;

    let nextState = gameStateRef.current;

    // 将当前句子添加到消息列表（如果尚未提交）
    const currentSegment = segments[currentIndex];
    if (currentSegment && currentSegment.trim().length > 0 && !isCurrentSegmentCommitted()) {
      nextState = addPlayerMessage(nextState, player.playerId, currentSegment);
      setGameState(nextState);
      markCurrentSegmentCommitted();

      const rawTranscript = buildRawDayTranscript(nextState);
      const shouldSummarizeEarly =
        nextState.day > 0 &&
        !nextState.dailySummaries?.[nextState.day]?.length &&
        // 喵杀（十七轮 · 站长确认）：白天发言的「当天记录」上限已提到 4000 字，
        // 这里把「什么时候做当天小结」的阈值从 10000 一起降到 **5000** ——
        // 保证「一旦开始截断（>4000），必定配一段摘要 + 最近发言」，不会静默丢掉开头的关键信息。
        rawTranscript.length > 5000;
      if (shouldSummarizeEarly) {
        void maybeGenerateDailySummary(nextState)
          .then((summarized) => {
            setGameState((prev) => {
              if (prev.gameId !== summarized.gameId || prev.day !== summarized.day) return prev;
              return {
                ...prev,
                dailySummaries: summarized.dailySummaries,
                dailySummaryFacts: summarized.dailySummaryFacts,
                dailySummaryVoteData: summarized.dailySummaryVoteData ?? prev.dailySummaryVoteData,
              };
            });
          })
          .catch(() => {});
      }
    }

    const result = advanceSpeechQueue();
    if (!result) return { finished: false, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };

    if (!result.finished) {
      return { finished: false, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: false };
    }

    setIsWaitingForAI(false);

    if (result.afterSpeech) {
      await result.afterSpeech(nextState);
      // 如果下一个发言者是AI，返回标志让调用方知道可以自动推进
      return { finished: true, shouldAdvanceToNextSpeaker: false, shouldAutoAdvanceToNextAI: result.shouldAutoAdvanceToNextAI ?? false };
    }

    // 不设置 waitingForNextRound，直接返回 shouldAdvanceToNextSpeaker: true
    // 让调用方立即调用 handleNextRound，避免单条消息时需要按两次回车的问题
    return { finished: true, shouldAdvanceToNextSpeaker: true, shouldAutoAdvanceToNextAI: false };
  }, [clearDialogue, clearSpeechQueue, setIsWaitingForAI, setWaitingForNextRound, getSpeechQueue, advanceSpeechQueue, setGameState, isCurrentSegmentCommitted, markCurrentSegmentCommitted, isCurrentSegmentCompleted]);

  /** 切换暂停 */
  const togglePause = useCallback(() => {
    setGameState((prev) => ({
      ...prev,
      isPaused: !prev.isPaused,
    }));
  }, [setGameState]);

  // ============================================
  // 返回 API
  // ============================================
  /**
   * 联机：房主把远程真人座位提交的操作喂进同一批 handler。
   * 只有当该座位确实是「当前该操作的人」时，下游 handler 才会真正生效（自带校验）。
   */
  const applyRemoteAction = useCallback(async (action: MpAction) => {
    const seat = action.seat;
    if (typeof seat !== "number" || seat < 0) return;
    switch (action.type) {
      case "speech":
        await handleHumanSpeech(seat, action.payload?.content || "");
        break;
      case "finish_speech":
        await handleFinishSpeaking(seat);
        break;
      case "vote":
        if (typeof action.payload?.targetSeat === "number") {
          await handleHumanVote(action.payload.targetSeat, seat);
        }
        break;
      case "night_action":
        await handleNightAction(action.payload?.targetSeat ?? -1, action.payload?.witchAction, seat);
        break;
      case "wwk_boom":
        await handleHumanWhiteWolfKingBoom(action.payload?.targetSeat ?? -1, seat);
        break;
      case "badge_signup":
        await badgePhase.handleBadgeSignup(action.payload?.content === "yes", seat);
        break;
      case "badge_transfer":
        await handleHumanBadgeTransfer(action.payload?.targetSeat ?? -1, seat);
        break;
      case "reading":
        // 客人上报「还差几句没读完」（0 = 已读完）→ 记在他的座位上，投票前「阅读门」用来放行
        reportReadProgress(Number(action.payload?.content) || 0, seat);
        break;
      case "advance":
        // 喵杀修复（2026-10-18 · 站长实测）：远程「继续」不再驱动房主引擎。
        // 旧实现里任何客人按继续都会跑房主的 voteContinueRef / handleNextRound，
        // 容易把房主的遗言或票型确认抢掉；保留分支只为兼容旧客户端。
        console.info("[meowcha] 忽略远程 advance：阶段推进由房主或当前行动者负责");
        break;
      default:
        break;
    }
  }, [handleHumanSpeech, handleFinishSpeaking, handleHumanVote, handleNightAction, handleHumanBadgeTransfer, handleHumanWhiteWolfKingBoom, badgePhase, advanceSpeech, waitingForNextRound, handleNextRound, reportReadProgress]);

  return {
    // State
    humanName: humanName || "",
    setHumanName,
    gameStarted,
    gameState,
    isLoading,
    isWaitingForAI,
    waitingForNextRound,
    currentDialogue,
    inputText,
    setInputText,
    showTable,
    setShowTable,
    setGameStarted,
    logRef,
    humanPlayer,
    isNight,

    // Actions
    startGame,
    continueAfterRoleReveal,
    restartGame,
    handleHumanSpeech,
    handleFinishSpeaking,
    handleBadgeSignup: badgePhase.handleBadgeSignup,
    handleHumanVote,
    handleNightAction,
    handleHumanBadgeTransfer,
    handleHumanWhiteWolfKingBoom,
    handleNextRound,
    scrollToBottom,
    advanceSpeech,
    togglePause,
    markCurrentSegmentCompleted,
    isCurrentSegmentCompleted,
    shouldAutoAdvanceToNextAI,
    // 联机
    applyRemoteAction,
    reportReadProgress,
    gateNotice,
  };
}
