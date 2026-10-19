"use client";

import { useCallback } from "react";
import { useAtom } from "jotai";
import type { GameState, Player, Alignment } from "@/types/game";
import { gameStateAtom } from "@/store/game-machine";
import {
  transitionPhase,
  addSystemMessage,
  killPlayer,
  checkWinCondition,
  generateHunterShoot,
} from "@/lib/game-master";
import { getSystemMessages } from "@/lib/game-texts";
import { getI18n } from "@/i18n/translator";
import { DELAY_CONFIG, getRoleName } from "@/lib/game-constants";
import { delay, type FlowToken } from "@/lib/game-flow-controller";
import { playNarrator } from "@/lib/narrator-audio-player";
import { gameStatsTracker } from "@/hooks/useGameStats";
import { gameSessionTracker } from "@/lib/game-session-tracker";
import { effectiveRules } from "@/lib/house-rules";

export interface SpecialEventsCallbacks {
  setDialogue: (speaker: string, text: string, isStreaming?: boolean) => void;
  setIsWaitingForAI: (waiting: boolean) => void;
  waitForUnpause: () => Promise<void>;
  isTokenValid: (token: FlowToken) => boolean;
  getAccessToken: () => string | null;
}

export interface SpecialEventsActions {
  handleHunterDeath: (state: GameState, hunter: Player, diedAtNight: boolean, token: FlowToken, afterHunter: (state: GameState) => Promise<void>) => Promise<void>;
  endGame: (state: GameState, winner: Alignment) => Promise<void>;
  resolveNight: (state: GameState, token: FlowToken, afterResolve: (state: GameState) => Promise<void>) => Promise<void>;
}

/**
 * 特殊事件 Hook
 * 负责管理猎人开枪、游戏结束、夜晚结算等特殊流程
 */
export function useSpecialEvents(
  callbacks: SpecialEventsCallbacks
): SpecialEventsActions {
  const getTexts = () => {
    const { t } = getI18n();
    return {
      t,
      systemMessages: getSystemMessages(),
      speakerHost: t("speakers.host"),
      speakerSystem: t("speakers.system"),
    };
  };
  const [, setGameState] = useAtom(gameStateAtom);

  const { setDialogue, setIsWaitingForAI, waitForUnpause, isTokenValid, getAccessToken } = callbacks;

  /** 处理猎人死亡开枪 */
  const handleHunterDeath = useCallback(async (
    state: GameState,
    hunter: Player,
    diedAtNight: boolean,
    token: FlowToken,
    afterHunter: (state: GameState) => Promise<void>
  ) => {
    const texts = getTexts();
    let currentState = transitionPhase(state, "HUNTER_SHOOT");
    setGameState(currentState);

    if (hunter.isHuman) {
      // 存储是否夜间死亡的信息，供后续 handleNightAction 使用
      currentState = { ...currentState, hunterDiedAtNight: diedAtNight };
      setGameState(currentState);
      setDialogue(texts.speakerSystem, texts.t("specialEvents.hunterPrompt"), false);
      return;
    }

    // AI 猎人开枪
    setIsWaitingForAI(true);
    const targetSeat = await generateHunterShoot(currentState, hunter);
    setIsWaitingForAI(false);

    if (!isTokenValid(token)) return;

    if (targetSeat !== null) {
      currentState = killPlayer(currentState, targetSeat);
      const target = currentState.players.find((p) => p.seat === targetSeat);
      if (target) {
        currentState = addSystemMessage(currentState, texts.systemMessages.hunterShoot(hunter.seat + 1, targetSeat + 1, target.displayName));
        setDialogue(texts.speakerHost, texts.systemMessages.hunterShoot(hunter.seat + 1, targetSeat + 1, target.displayName), false);
      }

      // 记录猎人开枪
      const shot = { hunterSeat: hunter.seat, targetSeat };
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
      await endGame(currentState, winner);
      return;
    }

    await delay(DELAY_CONFIG.LONG);
    await waitForUnpause();
    if (!isTokenValid(token)) return;

    await afterHunter(currentState);
  }, [ setGameState, setDialogue, setIsWaitingForAI, waitForUnpause, isTokenValid]);

  /** 游戏结束 */
  const endGame = useCallback(async (state: GameState, winner: Alignment) => {
    const texts = getTexts();
    let currentState = transitionPhase(state, "GAME_END");
    currentState = { ...currentState, winner };

    currentState = addSystemMessage(currentState, winner === "village" ? texts.systemMessages.villageWin : texts.systemMessages.wolfWin);
    const roleRevealPayload = {
      title: texts.t("specialEvents.roleRevealTitle"),
      players: currentState.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({
          playerId: p.playerId,
          seat: p.seat,
          name: p.displayName,
          role: p.role,
          isHuman: p.isHuman,
          modelRef: p.agentProfile?.modelRef,
        })),
    };
    currentState = addSystemMessage(currentState, `[ROLE_REVEAL]${JSON.stringify(roleRevealPayload)}`);
    setDialogue(texts.speakerHost, winner === "village" ? texts.t("specialEvents.villageWinLine") : texts.t("specialEvents.wolfWinLine"), false);

    setGameState(currentState);
    
    // 更新游戏会话数据（前端直接调用 Supabase）
    const winnerType = winner === "village" ? "villager" : "wolf";
    gameSessionTracker.end(winnerType, true).catch((err) => {
      console.error("[game-session] Failed to end:", err);
    });
    
    // 播放游戏结束语音
    await playNarrator(winner === "village" ? "villageWin" : "wolfWin");
  }, [setGameState, setDialogue]);

  /** 结算夜晚 */
  const resolveNight = useCallback(async (
    state: GameState,
    token: FlowToken,
    afterResolve: (state: GameState) => Promise<void>
  ) => {
    const texts = getTexts();
    let currentState = transitionPhase(state, "NIGHT_RESOLVE");
    setGameState(currentState);

    const { wolfTarget, guardTarget, witchSave, witchPoison } = currentState.nightActions;
    let wolfKillSuccessful = false;
    let wolfVictimSeat: number | undefined;
    let poisonVictimSeat: number | undefined;

    // 狼人击杀判定
    if (wolfTarget !== undefined) {
      const isProtected = guardTarget === wolfTarget;
      const isSaved = witchSave === true;
      const overlapRule = effectiveRules(currentState.houseRules).guardSaveOverlap;

      // 标准（death）：守卫与解药同时作用于同一人时该玩家仍会死亡（俗称「奶穿」）。
      // 房规（survive）：同守同救则该玩家存活，只有既未守护又未被救才会死。
      const killed = overlapRule === "survive"
        ? (!isProtected && !isSaved)
        : ((isProtected && isSaved) || (!isProtected && !isSaved));

      if (killed) {
        wolfKillSuccessful = true;
        wolfVictimSeat = wolfTarget;
      }

      // 私密提示：仅当「同守同救」确实致死、且人类玩家是守卫或女巫时给出，不公开、不泄露身份
      const humanRole = currentState.players.find((p) => p.isHuman)?.role;
      if (killed && isProtected && isSaved && (humanRole === "Guard" || humanRole === "Witch")) {
        setDialogue(texts.speakerSystem, "（本局规则：同守同救判定为死亡）", false);
      }
    }

    // 女巫毒杀判定
    if (witchPoison !== undefined) {
      poisonVictimSeat = witchPoison;
    }

    // 更新状态
    currentState = {
      ...currentState,
      nightActions: {
        ...currentState.nightActions,
        lastGuardTarget: guardTarget,
        pendingWolfVictim: wolfKillSuccessful ? wolfVictimSeat : undefined,
        pendingPoisonVictim: poisonVictimSeat,
        // 喵杀修正（2026-10-17）：死讯公布标记只对「本夜」有效，新的一夜必须复位，
        // 否则次日天亮会误判为「已公布」而跳过死讯。
        nightDeathsAnnounced: false,
        announcedWolfVictim: undefined,
        announcedPoisonVictim: undefined,
      },
    };

    // 记录夜晚历史
    currentState = {
      ...currentState,
      nightHistory: {
        ...(currentState.nightHistory || {}),
        [currentState.day]: {
          guardTarget: currentState.nightActions.guardTarget,
          wolfTarget: currentState.nightActions.wolfTarget,
          witchSave: currentState.nightActions.witchSave,
          witchPoison: currentState.nightActions.witchPoison,
          seerTarget: currentState.nightActions.seerTarget,
          seerResult: currentState.nightActions.seerResult,
        },
      },
    };

    setGameState(currentState);

    await delay(DELAY_CONFIG.LONG);
    await waitForUnpause();
    if (!isTokenValid(token)) return;

    currentState = transitionPhase(currentState, "DAY_START");
    currentState = addSystemMessage(currentState, texts.systemMessages.dayBreak);
    setGameState(currentState);
    setDialogue(texts.speakerHost, texts.systemMessages.dayBreak, false);

    // 天亮时同步游戏进度到数据库
    gameSessionTracker.syncProgress().catch(() => {});

    // 播放旁白语音
    await playNarrator("dayBreak");

    await delay(DELAY_CONFIG.MEDIUM);
    await waitForUnpause();
    if (!isTokenValid(token)) return;

    await afterResolve(currentState);
  }, [setGameState, setDialogue, waitForUnpause, isTokenValid]);

  return {
    handleHunterDeath,
    endGame,
    resolveNight,
  };
}
