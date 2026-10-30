"use client";

import { useCallback, useRef } from "react";
import { getI18n } from "@/i18n/translator";
import { useAtom } from "jotai";
import type { GameState, Player, Phase } from "@/types/game";
import type { PrefetchCriteria, PrefetchedSpeech } from "../useDialogueManager";
import { gameStateAtom } from "@/store/game-machine";
import {
  transitionPhase,
  addSystemMessage,
  addPlayerMessage,
  killPlayer,
  generateAISpeechSegmentsStream,
  getNextBadgeCandidateSeat,
  getNextDaySpeechSeat,
  getNextAliveSeat,
} from "@/lib/game-master";
import { PHASE_CATEGORIES } from "@/lib/game-constants";
import { type FlowToken } from "@/lib/game-flow-controller";
import { audioManager, makeAudioTaskId } from "@/lib/audio-manager";
import { resolveVoiceId, type AppLocale } from "@/lib/voice-constants";
import { getLocale } from "@/i18n/locale-store";

export interface DayPhaseCallbacks {
  setDialogue: (speaker: string, text: string, isStreaming?: boolean) => void;
  setIsWaitingForAI: (waiting: boolean) => void;
  setWaitingForNextRound: (waiting: boolean) => void;
  isTokenValid: (token: FlowToken) => boolean;
  initSpeechQueue: (segments: string[], player: Player, afterSpeech?: (s: unknown) => Promise<void>) => void;
  initStreamingSpeechQueue: (player: Player, afterSpeech?: (s: unknown) => Promise<void>) => void;
  appendToSpeechQueue: (segment: string) => void;
  finalizeSpeechQueue: (options?: { nextSpeakerIsAI?: boolean }) => void;
  setPrefetchedSpeech: (prefetch: PrefetchedSpeech | null) => void;
  consumePrefetchedSpeech: (criteria: PrefetchCriteria) => string[] | null;
  setAfterLastWords: (callback: ((s: GameState) => Promise<void>) | null) => void;
}

export interface DayPhaseActions {
  startLastWordsPhase: (state: GameState, seat: number, afterLastWords: (s: GameState) => Promise<void>, token: FlowToken) => Promise<void>;
  runAISpeech: (state: GameState, player: Player, options?: { afterSpeech?: (s: GameState) => Promise<void> }) => Promise<void>;
}

/**
 * 白天阶段 Hook
 * 负责管理白天流程：发言、遗言等
 */
export function useDayPhase(
  humanPlayer: Player | null,
  callbacks: DayPhaseCallbacks
): DayPhaseActions {
  const { t } = getI18n();
  const speakerHost = t("speakers.host");
  const [gameState, setGameState] = useAtom(gameStateAtom);

  const {
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
    setAfterLastWords,
  } = callbacks;

  /** 判断是否为发言类阶段 */
  const isSpeechLikePhase = (phase: Phase): boolean => {
    return PHASE_CATEGORIES.SPEECH_PHASES.includes(phase as typeof PHASE_CATEGORIES.SPEECH_PHASES[number]);
  };

  const buildPostSpeechState = useCallback((
    baseState: GameState,
    speaker: Player,
    segments: string[]
  ): GameState => {
    const normalized = segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
    return normalized.reduce((nextState, segment) => {
      return addPlayerMessage(nextState, speaker.playerId, segment);
    }, baseState);
  }, []);


  // 使用 ref 来获取最新的 gameState，避免闭包问题
  const gameStateRef = useRef(gameState);
  gameStateRef.current = gameState;

  // 防止 AI 发言重复触发
  const currentSpeakingPlayerRef = useRef<string | null>(null);

  // 用于存储流式生成的段落以便预取音频
  const streamingSegmentsRef = useRef<string[]>([]);

  const resolveNextSpeaker = useCallback((state: GameState) => {
    let nextSpeakerIsAI = false;
    const isDaySpeech = state.phase === "DAY_SPEECH";
    const direction = state.speechDirection ?? "clockwise";

    let nextSeat: number | null = null;
    if (state.phase === "DAY_PK_SPEECH") {
      const pkTargets = (state.pkTargets || []).filter((seat) =>
        state.players.some((p) => p.seat === seat && p.alive)
      );
      const currentSeat = state.currentSpeakerSeat ?? -1;
      const currentIndex = pkTargets.indexOf(currentSeat);
      const nextIndex = currentIndex + 1;
      if (nextIndex < pkTargets.length) {
        nextSeat = pkTargets[nextIndex];
      }
    } else if (state.phase === "DAY_BADGE_SPEECH") {
      // 与 DaySpeechPhase 共用：按候选人顺序走完，最后一位之后结束竞选发言。
      nextSeat = getNextBadgeCandidateSeat(state);
    } else if (isDaySpeech) {
      // 与 DaySpeechPhase 共用同一套「警长最后 + 跳过已发言/已出局」顺序
      nextSeat = getNextDaySpeechSeat(state);
    } else {
      nextSeat = getNextAliveSeat(state, state.currentSpeakerSeat ?? -1, false, direction);
    }

    if (nextSeat !== null) {
      const nextPlayer = state.players.find((p) => p.seat === nextSeat);
      nextSpeakerIsAI = nextPlayer ? !nextPlayer.isHuman && nextPlayer.alive : false;
    }

    return { nextSeat, nextSpeakerIsAI };
  }, []);

  const prefetchNextAISpeech = useCallback(async (
    state: GameState,
    player: Player
  ) => {
    if (!player.alive) return;
    if (!["DAY_SPEECH", "DAY_PK_SPEECH", "DAY_BADGE_SPEECH"].includes(state.phase)) return;
    if (!player.agentProfile) return;

    const basePrefetch: PrefetchedSpeech = {
      playerId: player.playerId,
      phase: state.phase,
      day: state.day,
      messageCount: state.messages.length,
      segments: [],
      isComplete: false,
      createdAt: Date.now(),
    };

    setPrefetchedSpeech(basePrefetch);

    const collected: string[] = [];

    try {
      const segments = await generateAISpeechSegmentsStream(state, player, {
        onSegmentReceived: (segment) => {
          collected.push(segment);
          setPrefetchedSpeech({
            ...basePrefetch,
            segments: [...collected],
            isComplete: false,
          });
        },
        onComplete: (finalSegments) => {
          setPrefetchedSpeech({
            ...basePrefetch,
            segments: finalSegments,
            isComplete: true,
          });
        },
        onError: () => {
          setPrefetchedSpeech(null);
        },
      });

      if (segments.length === 0) {
        setPrefetchedSpeech(null);
      }
    } catch {
      setPrefetchedSpeech(null);
    }
  }, [setPrefetchedSpeech]);

  /** AI 发言（流式分段输出） */
  const runAISpeech = useCallback(async (
    state: GameState,
    player: Player,
    options?: { afterSpeech?: (s: GameState) => Promise<void> }
  ) => {
    // 喵杀修复（2026-10-18）：非遗言阶段，死人的流式发言绝不能播。
    // 但 DAY_LAST_WORDS 本来就是死者说话，必须放行；否则会卡在「等待 11号 发表遗言」。
    const isLastWordsSpeech = state.phase === "DAY_LAST_WORDS";
    if (!player.alive && !isLastWordsSpeech) return;
    if (state.phase.includes("NIGHT")) {
      console.warn("[meowcha] runAISpeech called during NIGHT phase:", state.phase);
      return;
    }

    if (currentSpeakingPlayerRef.current === player.playerId) {
      console.warn("[meowcha] runAISpeech: already speaking for", player.displayName);
      return;
    }

    // 重置流式段落收集器
    streamingSegmentsRef.current = [];
    let hasReceivedFirstSegment = false;
    let isTimedOut = false;
    /** 最近一次收到流式段落的时间（用于「流式静默超时」自愈，避免卡在最后一句） */
    let lastSegmentAt = Date.now();
    const startGameId = state.gameId;
    const startDay = state.day;
    const startPhase = state.phase;
    /** 这轮发言是否已经过期（换局/换天/换阶段/该玩家已出局） */
    const isStale = () => {
      const live = gameStateRef.current;
      const livePlayer = live.players.find((p) => p.playerId === player.playerId);
      return (
        live.gameId !== startGameId ||
        live.day !== startDay ||
        live.phase !== startPhase ||
        (!isLastWordsSpeech && !livePlayer?.alive)
      );
    };

    // Get current locale for voice resolution
    const locale = getLocale() as AppLocale;
    const voiceId = resolveVoiceId(
      player.agentProfile?.persona?.voiceId,
      player.agentProfile?.persona?.gender,
      player.agentProfile?.persona?.age,
      locale
    );

    const prefetchCriteria: PrefetchCriteria = {
      playerId: player.playerId,
      phase: state.phase,
      day: state.day,
      messageCount: state.messages.length,
    };

    const prefetchedSegments = consumePrefetchedSpeech(prefetchCriteria);
    if (prefetchedSegments && prefetchedSegments.length > 0) {
      currentSpeakingPlayerRef.current = player.playerId;
      setIsWaitingForAI(false);
      initSpeechQueue(
        prefetchedSegments,
        player,
        options?.afterSpeech as ((s: unknown) => Promise<void>) | undefined
      );

      try {
        const firstSegment = prefetchedSegments[0];
        if (firstSegment) {
          const task = {
            id: makeAudioTaskId(voiceId, firstSegment),
            text: firstSegment,
            voiceId,
            playerId: player.playerId,
          };
          audioManager.prefetchTasks([task], { concurrency: 1 }).catch(() => {});
        }
      } catch {
        // ignore tts prefetch errors
      }

      currentSpeakingPlayerRef.current = null;
      return;
    }

    currentSpeakingPlayerRef.current = player.playerId;
    setIsWaitingForAI(true);
    setDialogue(player.displayName, t("dayPhase.organizing"), true);

    // 60秒超时机制：避免卡死在"正在组织语言"状态
    const ORGANIZING_TIMEOUT_MS = 60000;
    const STALL_TIMEOUT_MS = 12000;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let stallTimer: ReturnType<typeof setInterval> | null = null;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutTimer = setTimeout(() => {
        if (!hasReceivedFirstSegment) {
          isTimedOut = true;
          resolve("timeout");
        }
      }, ORGANIZING_TIMEOUT_MS);
    });

    try {
      // 初始化流式发言队列
      initStreamingSpeechQueue(player, options?.afterSpeech as ((s: unknown) => Promise<void>) | undefined);

      // 喵杀修复（2026-10-30）：流式静默看门狗。
      // 请求中途报错/连接挂住时 onComplete 不会到达，队列会永久 isStreaming，
      // 玩家点「继续」也推不动 → 卡在最后一句（刷新才好的那个 bug）。
      // 这里在 12s 没有新段落时主动收尾，已收到的台词仍可逐句读完。
      stallTimer = setInterval(() => {
        if (isTimedOut) return;
        if (!hasReceivedFirstSegment) return;
        if (Date.now() - lastSegmentAt < STALL_TIMEOUT_MS) return;
        isTimedOut = true;
        if (stallTimer) {
          clearInterval(stallTimer);
          stallTimer = null;
        }
        console.warn(`[meowcha] runAISpeech: ${player.displayName} 流式静默超时，强制收尾`);
        if (!isStale()) finalizeSpeechQueue();
      }, 1000);

      // 使用流式生成，带超时保护
      const streamPromise = generateAISpeechSegmentsStream(state, player, {
        onSegmentReceived: (segment, index) => {
          // 如果已超时，忽略后续段落
          if (isTimedOut) return;
          // 换局/换天/换阶段/角色已死：丢弃迟到的流式段落
          if (isStale()) return;

          // 检查当前阶段是否仍是发言阶段
          const currentPhase = gameStateRef.current.phase;
          if (!isSpeechLikePhase(currentPhase)) {
            return;
          }

          // Deduplication: skip if segment already collected
          if (streamingSegmentsRef.current.includes(segment)) {
            return;
          }
          streamingSegmentsRef.current.push(segment);
          lastSegmentAt = Date.now();

          // 第一个段落到达时，立即显示
          if (!hasReceivedFirstSegment) {
            hasReceivedFirstSegment = true;
            setIsWaitingForAI(false);
          }

          // 添加到发言队列
          appendToSpeechQueue(segment);

          // 异步预取音频
          try {
            const task = {
              id: makeAudioTaskId(voiceId, segment),
              text: segment,
              voiceId,
              playerId: player.playerId,
            };
            audioManager.prefetchTasks([task], { concurrency: 1 }).catch(() => {});
          } catch {
            // ignore tts prefetch errors
          }
        },
        onComplete: () => {
          // 如果已超时，忽略完成回调
          if (isTimedOut) return;
          if (isStale()) return;

          // 检查当前阶段是否仍是发言阶段
          const currentState = gameStateRef.current;
          const currentPhase = currentState.phase;
          if (!isSpeechLikePhase(currentPhase)) {
            console.warn("[meowcha] runAISpeech: phase changed during AI speech generation, skipping display. Expected speech phase, got:", currentPhase);
            return;
          }

          const { nextSeat, nextSpeakerIsAI } = resolveNextSpeaker(currentState);

          if (nextSeat !== null && nextSpeakerIsAI) {
            const postSpeechState = buildPostSpeechState(currentState, player, streamingSegmentsRef.current);
            const nextPlayer = postSpeechState.players.find((p) => p.seat === nextSeat);
            if (nextPlayer && !nextPlayer.isHuman && nextPlayer.alive) {
              void prefetchNextAISpeech(postSpeechState, nextPlayer);
            }
          }

          // 标记流式生成完成，并传递下一个发言者信息
          finalizeSpeechQueue({ nextSpeakerIsAI });
        },
        onError: () => {
          // 如果已超时，忽略错误回调
          if (isTimedOut) return;
          if (isStale()) return;

          // 如果没有收到任何段落，显示中断消息
          if (!hasReceivedFirstSegment) {
            appendToSpeechQueue(t("dayPhase.interrupted"));
          }
          // 喵杀修复（2026-10-30）：即使已收到部分段落，也必须收尾。
          // 否则队列永久停在 isStreaming，玩家点「继续」推不动，白天卡在最后一句。
          finalizeSpeechQueue();
        },
      });

      // 等待流式生成完成或超时
      const result = await Promise.race([streamPromise, timeoutPromise]);

      // 处理超时情况
      if (result === "timeout") {
        console.warn(`[meowcha] runAISpeech: timeout after ${ORGANIZING_TIMEOUT_MS}ms for ${player.displayName}, skipping to next speaker`);
        // 显示超时消息并标记完成
        if (!isStale()) {
          appendToSpeechQueue(t("dayPhase.timeout"));
          finalizeSpeechQueue();
        }
      }
    } catch {
      // 喵杀修复（2026-10-30）：生成调用异常时也要保证队列能收尾。
      // 没收到任何段落 → 用中断台词开一个新队列（可正常读完）；
      // 已收到部分段落 → 直接把现有流式队列标记完成，允许玩家继续。
      if (!isTimedOut && !isStale()) {
        if (!hasReceivedFirstSegment) {
          initSpeechQueue([t("dayPhase.interrupted")], player, options?.afterSpeech as ((s: unknown) => Promise<void>) | undefined);
        } else {
          finalizeSpeechQueue();
        }
      }
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (stallTimer) {
        clearInterval(stallTimer);
        stallTimer = null;
      }
      // 只清属于自己的标记，避免把下一位正在生成的发言标记误清掉
      if (currentSpeakingPlayerRef.current === player.playerId) {
        currentSpeakingPlayerRef.current = null;
      }
      if (!hasReceivedFirstSegment) {
        setIsWaitingForAI(false);
      }
      // 兜底：生成调用已经结束（无论正常/异常），只要这轮没过期就确保队列已收尾
      if (!isTimedOut && !isStale()) finalizeSpeechQueue();
    }
  }, [
    setIsWaitingForAI,
    setDialogue,
    initSpeechQueue,
    initStreamingSpeechQueue,
    appendToSpeechQueue,
    finalizeSpeechQueue,
    consumePrefetchedSpeech,
    prefetchNextAISpeech,
    resolveNextSpeaker,
    buildPostSpeechState,
    isSpeechLikePhase,
    t,
  ]);

  // 更新 ref 以打破循环依赖
  /** 开始遗言阶段 */
  const startLastWordsPhase = useCallback(async (
    state: GameState,
    seat: number,
    afterLastWords: (s: GameState) => Promise<void>,
    token: FlowToken
  ) => {
    const speaker = state.players.find((p) => p.seat === seat);
    if (!speaker) {
      await afterLastWords(state);
      return;
    }

    setWaitingForNextRound(false);

    // 确保遗言发言者已标记为死亡
    let currentState = speaker.alive ? killPlayer(state, seat) : state;
    currentState = transitionPhase(currentState, "DAY_LAST_WORDS");
    currentState = { ...currentState, currentSpeakerSeat: seat };
    currentState = addSystemMessage(currentState, t("dayPhase.lastWordsSystem", { seat: seat + 1, name: speaker.displayName }));
    setGameState(currentState);

    if (speaker.isHuman) {
      // 保存回调，等待人类发言完毕后调用
      setAfterLastWords(afterLastWords);
      setDialogue(
        speakerHost,
        `${t("dayPhase.lastWordsPrompt", { seat: seat + 1, name: speaker.displayName })} · 点「结束遗言」进入夜晚（60 秒后自动继续）`,
        false
      );
      return;
    }

    if (!isTokenValid(token)) return;

    // AI 遗言：先显示「请 X号 发表遗言」，再进入流式生成；
    // 这样即使生成失败/超时，玩家也能看清当前在等谁的遗言。
    setDialogue(
      speakerHost,
      t("dayPhase.lastWordsPrompt", { seat: seat + 1, name: speaker.displayName }),
      false
    );
    await runAISpeech(currentState, speaker, {
      afterSpeech: async (s) => {
        if (!isTokenValid(token)) return;
        await afterLastWords(s as GameState);
      },
    });
  }, [setGameState, setDialogue, setWaitingForNextRound, isTokenValid, runAISpeech]);

  return {
    startLastWordsPhase,
    runAISpeech,
  };
}
