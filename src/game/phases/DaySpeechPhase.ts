import { type GameState, type Player, isWolfRole } from "@/types/game";
import { GamePhase } from "../core/GamePhase";
import type { GameAction, GameContext, PromptResult, SystemPromptPart } from "../core/types";
import {
  buildGameContext,
  buildDifficultySpeechHint,
  buildPersonaSection,
  buildPlayerTodaySpeech,
  buildTodayTranscript,
  getRoleText,
  getWinCondition,
  getRoleKnowHow,
  buildSystemTextFromParts,
  getDayStartIndex,
  buildSituationalStrategy,
  buildFocusAngle,
} from "@/lib/prompt-utils";
import type { FlowToken } from "@/lib/game-flow-controller";
import {
  addSystemMessage,
  checkWinCondition,
  getNextBadgeCandidateSeat,
  getNextAliveSeat,
  getNextDaySpeechSeat,
  getSpeakingOrder,
  killPlayer,
  transitionPhase,
} from "@/lib/game-master";
import { getSystemMessages, getUiText } from "@/lib/game-texts";
import { getI18n } from "@/i18n/translator";
import { DELAY_CONFIG } from "@/lib/game-constants";
import { delay } from "@/lib/game-flow-controller";
import { playNarrator } from "@/lib/narrator-audio-player";
import { getPlayerDiedKey } from "@/lib/narrator-voice";
import { effectiveRules } from "@/lib/house-rules";

type DaySpeechRuntime = {
  token: FlowToken;
  setGameState: (value: GameState | ((prev: GameState) => GameState)) => void;
  setDialogue: (speaker: string, text: string, isStreaming?: boolean) => void;
  waitForUnpause: () => Promise<void>;
  runAISpeech: (state: GameState, player: Player) => Promise<void>;
  onBadgeTransfer: (state: GameState, sheriff: Player, afterTransfer: (s: GameState) => Promise<void>) => Promise<void>;
  onHunterDeath: (state: GameState, hunter: Player, diedAtNight: boolean) => Promise<void>;
  onGameEnd: (state: GameState, winner: "village" | "wolf") => Promise<void>;
  onStartVote: (state: GameState, token: FlowToken) => Promise<void>;
  onBadgeSpeechEnd: (state: GameState) => Promise<void>;
  onPkSpeechEnd: (state: GameState) => Promise<void>;
  onWhiteWolfKingBoomCheck: (state: GameState, wwk: Player) => Promise<boolean>;
};

export type NightDeathAnnounceDeps = {
  setGameState: (state: GameState) => void;
  setDialogue: (speaker: string, text: string, isStreaming?: boolean) => void;
  waitForUnpause: () => Promise<void>;
};

/**
 * 天亮公布夜间死讯（含「昨晚平安无事」）。
 *
 * 喵杀修正（2026-10-17 · 站长实测）：站长发现「第一轮警长竞选结束后才显示死讯」，
 * 而且竞选阶段的 AI 会说「今天没死人」——因为竞选时被杀者还没被 killPlayer，AI 看到的
 * 是「全员存活」。正确规则是：**天亮先公布死讯，再进行警长竞选**。
 * 因此把这段公布逻辑抽成独立函数：
 *  - 第一天：由 startDayPhaseInternal 在进入警长竞选**之前**调用一次；
 *  - 竞选结束后 startDaySpeechAfterBadge 再调用会因 nightDeathsAnnounced 直接跳过（幂等）；
 *  - 第二夜及以后：仍由 startDaySpeechAfterBadge 调用（行为与原来一致）。
 *
 * 本函数只负责「公布」（击杀 + 系统公告 + 旁白 + 暂停等待），
 * 不含警徽移交/猎人开枪/胜负判定 —— 那些后果统一在 startDaySpeechAfterBadge 里处理，
 * 保证逻辑只有一份实现，不会因拆分成两处而漂移。
 */
export async function announceNightDeaths(
  state: GameState,
  deps: NightDeathAnnounceDeps
): Promise<GameState> {
  const systemMessages = getSystemMessages();
  const speakerHost = getI18n().t("speakers.host");

  const { pendingWolfVictim, pendingPoisonVictim, nightDeathsAnnounced } = state.nightActions;
  // 幂等：本夜已经公布过（例如第一天在竞选前已公布），直接返回，不重复击杀/公告
  if (nightDeathsAnnounced) return state;

  let currentState = state;
  let hasDeaths = false;
  const sameTargetAsWolf =
    pendingWolfVictim !== undefined && pendingPoisonVictim === pendingWolfVictim;

  if (pendingWolfVictim !== undefined) {
    hasDeaths = true;
    currentState = killPlayer(currentState, pendingWolfVictim);
    const wolfVictim = currentState.players.find((p) => p.seat === pendingWolfVictim);
    if (wolfVictim) {
      currentState = addSystemMessage(
        currentState,
        systemMessages.playerKilled(wolfVictim.seat + 1, wolfVictim.displayName)
      );
      deps.setDialogue(
        speakerHost,
        systemMessages.playerKilled(wolfVictim.seat + 1, wolfVictim.displayName),
        false
      );
      deps.setGameState(currentState);

      const diedKey = getPlayerDiedKey(wolfVictim.seat);
      if (diedKey) await playNarrator(diedKey);

      await delay(DELAY_CONFIG.LONG);
      await deps.waitForUnpause();
    }
  }

  if (pendingPoisonVictim !== undefined) {
    if (sameTargetAsWolf) {
      // 狼刀+毒药同目标：已在狼刀步骤处理死亡，仅标记猎人不可开枪
      const overlappedVictim = currentState.players.find((p) => p.seat === pendingPoisonVictim);
      if (overlappedVictim?.role === "Hunter" && !effectiveRules(currentState.houseRules).poisonedHunterShoots) {
        currentState = {
          ...currentState,
          roleAbilities: { ...currentState.roleAbilities, hunterCanShoot: false },
        };
      }
    } else {
      hasDeaths = true;
      currentState = killPlayer(currentState, pendingPoisonVictim);
      const poisonVictim = currentState.players.find((p) => p.seat === pendingPoisonVictim);
      if (poisonVictim) {
        if (poisonVictim.role === "Hunter" && !effectiveRules(currentState.houseRules).poisonedHunterShoots) {
          currentState = {
            ...currentState,
            roleAbilities: { ...currentState.roleAbilities, hunterCanShoot: false },
          };
        }
        currentState = addSystemMessage(
          currentState,
          systemMessages.playerKilled(poisonVictim.seat + 1, poisonVictim.displayName)
        );
        deps.setDialogue(
          speakerHost,
          systemMessages.playerKilled(poisonVictim.seat + 1, poisonVictim.displayName),
          false
        );
        deps.setGameState(currentState);

        const poisonDiedKey = getPlayerDiedKey(poisonVictim.seat);
        if (poisonDiedKey) await playNarrator(poisonDiedKey);

        await delay(DELAY_CONFIG.LONG);
        await deps.waitForUnpause();
      }
    }
  }

  if (!hasDeaths) {
    currentState = addSystemMessage(currentState, systemMessages.peacefulNight);
    deps.setDialogue(speakerHost, systemMessages.peacefulNight, false);
    deps.setGameState(currentState);

    await playNarrator("peacefulNight");

    await delay(DELAY_CONFIG.NIGHT_RESOLVE);
    await deps.waitForUnpause();
  }

  // 清空 pending，并记下「本夜已公布的出局者」，供竞选结束后的猎人/警徽判定复用
  currentState = {
    ...currentState,
    nightActions: {
      ...currentState.nightActions,
      pendingWolfVictim: undefined,
      pendingPoisonVictim: undefined,
      announcedWolfVictim: pendingWolfVictim,
      announcedPoisonVictim: sameTargetAsWolf ? undefined : pendingPoisonVictim,
      nightDeathsAnnounced: true,
    },
  };
  deps.setGameState(currentState);
  return currentState;
}

export class DaySpeechPhase extends GamePhase {
  private isMovingToNextSpeaker = false;

  private resolveSpeechDirection(state: GameState, startSeat: number | null): "clockwise" | "counterclockwise" {
    if (startSeat === null) return "clockwise";
    const sheriffSeat = state.badge.holderSeat;
    if (sheriffSeat === null) return "clockwise";

    const aliveSeats = state.players.filter((p) => p.alive).map((p) => p.seat).sort((a, b) => a - b);
    if (!aliveSeats.includes(startSeat) || !aliveSeats.includes(sheriffSeat)) return "clockwise";

    const total = aliveSeats.length;
    const startIndex = aliveSeats.indexOf(startSeat);
    const sheriffIndex = aliveSeats.indexOf(sheriffSeat);
    if (startIndex === sheriffIndex) return "clockwise";

    const clockwiseSteps = (sheriffIndex - startIndex + total) % total;
    const counterSteps = (startIndex - sheriffIndex + total) % total;
    return clockwiseSteps >= counterSteps ? "clockwise" : "counterclockwise";
  }

  async onEnter(_context: GameContext): Promise<void> {
    return;
  }

  getPrompt(context: GameContext, player: Player): PromptResult {
    const { t } = getI18n();
    const state = context.state;
    const gameContext = buildGameContext(state, player);
    const isGenshinMode = !!state.isGenshinMode;
    const persona = buildPersonaSection(player, isGenshinMode);
    const difficultyHint = buildDifficultySpeechHint(state.difficulty);
    const totalSeats = state.players.length;

    // 喵杀（十七轮 · 站长要求）：把「当天记录」上限从 2000 提到 **4000 字** ——
    // 让 3/4/5 这类后置位的 AI 能读到前面更多人（含真人）的发言，判断更贴近真实上下文。
    // 超出部分仍会走「当天小结 + 最近发言」，所以不会无限膨胀 prompt。
    const todayTranscript = buildTodayTranscript(state, 4000);
    const selfSpeech = buildPlayerTodaySpeech(state, player, 1400);

    const todaySpeakers = new Set<string>();
    const dayStartIndex = getDayStartIndex(state);

    for (let i = dayStartIndex; i < state.messages.length; i++) {
      const m = state.messages[i];
      if (!m.isSystem && m.playerId && m.playerId !== player.playerId) {
        todaySpeakers.add(m.playerId);
      }
    }

    const isLastWords = state.phase === "DAY_LAST_WORDS";
    const isBadgeSpeech = state.phase === "DAY_BADGE_SPEECH";
    const isPkSpeech = state.phase === "DAY_PK_SPEECH";
    const isCampaignSpeech = isBadgeSpeech || isPkSpeech;

    // Define valid speakers for this phase (campaign-only speakers)
    const candidates =
      isBadgeSpeech && Array.isArray(state.badge?.candidates) ? state.badge.candidates : [];
    const pkTargets = isPkSpeech && Array.isArray(state.pkTargets) ? state.pkTargets : [];

    const hasCandidateList = isBadgeSpeech && candidates.length > 0;

    const validSpeakers = state.players.filter(p => {
        if (!p.alive) return false;
        // If candidates list is unexpectedly empty, fallback to alive players to avoid division by zero.
        if (isBadgeSpeech) return hasCandidateList ? candidates.includes(p.seat) : true;
        if (isPkSpeech) return pkTargets.includes(p.seat);
        return true;
    });

    const totalSpeakers = validSpeakers.length;
    
    // 获取完整的发言顺序（从起始座位开始，警长最后）
    const startSeat = state.daySpeechStartSeat ?? 0;
    const sheriffSeat = state.badge.holderSeat;
    const isSheriffAlive = sheriffSeat !== null && 
      state.players.some((p) => p.seat === sheriffSeat && p.alive);
    const fullSpeakingOrder = getSpeakingOrder(state, startSeat, isSheriffAlive);
    
    // 根据发言顺序，找出当前玩家在顺序中的位置
    const playerIndex = fullSpeakingOrder.indexOf(player.seat);
    
    // 已发言玩家：在当前玩家之前的所有玩家（按发言顺序）
    const spokenSeats = playerIndex > 0 ? fullSpeakingOrder.slice(0, playerIndex) : [];
    // 未发言玩家：在当前玩家之后的所有玩家（按发言顺序）
    const unspokenSeats = playerIndex >= 0 ? fullSpeakingOrder.slice(playerIndex + 1) : [];
    
    // 过滤出有效的发言者（针对竞选/PK阶段）
    const validSpeakerSeats = new Set(validSpeakers.map(p => p.seat));
    const spokenPlayers = spokenSeats
      .filter(seat => validSpeakerSeats.has(seat))
      .map(seat => state.players.find(p => p.seat === seat)!)
      .filter(Boolean);
    const unspokenPlayers = unspokenSeats
      .filter(seat => validSpeakerSeats.has(seat))
      .map(seat => state.players.find(p => p.seat === seat)!)
      .filter(Boolean);

    const speakOrder = spokenPlayers.length + 1;
    const isFirstSpeaker = speakOrder === 1;
    const isLastSpeaker = speakOrder === totalSpeakers;

    let speakOrderHint = "";
    if (isFirstSpeaker) {
      speakOrderHint = t("prompts.daySpeech.speakOrder.first");
    } else if (isLastSpeaker) {
      speakOrderHint = t("prompts.daySpeech.speakOrder.last", { speakOrder, totalSpeakers });
    } else {
      // 标记已过麦的玩家（在顺序中应该已发言但实际没有发言记录）
      const spokenList = spokenPlayers.map((p) => {
        const hasSpoken = todaySpeakers.has(p.playerId);
        const seatLabel = t("ui.seatNumber", { seat: p.seat + 1 });
        return hasSpoken ? seatLabel : t("prompts.daySpeech.speakOrder.skipped", { seat: seatLabel });
      }).join(t("common.listSeparator"));
      const unspokenList = unspokenPlayers.map((p) => t("ui.seatNumber", { seat: p.seat + 1 })).join(t("common.listSeparator"));
      speakOrderHint = t("prompts.daySpeech.speakOrder.middle", { speakOrder, totalSpeakers, spokenList: spokenList || t("common.none"), unspokenList: unspokenList || t("common.none") });
    }

    const nonCandidateList = state.players
      .filter((p) => p.alive && !candidates.includes(p.seat))
      .map((p) => t("ui.seatNumber", { seat: p.seat + 1 }))
      .join(t("common.listSeparator"));
    const campaignRequirements = isBadgeSpeech
      ? t("prompts.daySpeech.campaign.badge") + "\n" + (hasCandidateList
        ? t("prompts.daySpeech.campaign.candidateNote", { list: nonCandidateList })
        : t("prompts.daySpeech.campaign.emptyCandidateNote"))
      : isPkSpeech
        ? t("prompts.daySpeech.campaign.pk")
        : "";

    // Get role-specific strategy tips
    const roleKnowHow = getRoleKnowHow(player.role);
    
    // Get situational strategy based on current game state
    const situationalStrategy = buildSituationalStrategy(state, player);

    const baseCacheable = t("prompts.daySpeech.base", {
      seat: player.seat + 1,
      name: player.displayName,
      role: getRoleText(player.role),
      winCondition: getWinCondition(player.role),
      persona,
      difficultyHint,
    });
    const taskLine = isLastWords 
      ? t("prompts.daySpeech.task.lastWords", { seat: player.seat + 1, name: player.displayName }) 
      : isCampaignSpeech 
        ? t("prompts.daySpeech.task.campaign") 
        : t("prompts.daySpeech.task.dayDiscussion");
    
    // 喵杀修复：白狼王也属于狼营（原为 === "Werewolf"，白狼王拿不到狼人发言策略）
    const lastWordsStrategy = isLastWords && isWolfRole(player.role) 
      ? "\n" + t("prompts.daySpeech.task.lastWordsWerewolfStrategy")
      : "";
    
    const taskSection = t("prompts.daySpeech.task.section", { taskLine, campaignRequirements: campaignRequirements ? "\n" + campaignRequirements : "" }) + lastWordsStrategy;
    const roleHintLine = isWolfRole(player.role) ? t("prompts.daySpeech.roleHints.werewolf") : player.role === "Seer" ? t("prompts.daySpeech.roleHints.seer") : "";
    const guidelinesSection = isGenshinMode
      ? t("prompts.daySpeech.guidelines.genshin")
      : t("prompts.daySpeech.guidelines.default", { playerName: player.displayName, roleHintLine });
    const focusAngle = buildFocusAngle(state, player);
    const systemParts: SystemPromptPart[] = [
      { text: baseCacheable, cacheable: true, ttl: "1h" },
      { text: taskSection },
      { text: roleKnowHow },
      ...(situationalStrategy ? [{ text: situationalStrategy }] : []),
      ...(focusAngle ? [{ text: focusAngle }] : []),
      { text: guidelinesSection, cacheable: true, ttl: "1h" },
    ];
    const system = buildSystemTextFromParts(systemParts);

    const phaseHint = isBadgeSpeech
      ? t("prompts.daySpeech.phaseHint.badge")
      : isPkSpeech
        ? t("prompts.daySpeech.phaseHint.pk")
        : "";
    const phaseHintSection = phaseHint ? t("prompts.daySpeech.phaseSection", { phaseHint }) : "";

    const user = t("prompts.daySpeech.user", {
      gameContext,
      todayTranscript: todayTranscript || t("prompts.daySpeech.userNoTranscript", { speakOrder }),
      selfSpeech: selfSpeech || t("prompts.daySpeech.userNoSelfSpeech"),
      phaseHintSection,
      speakOrderHint,
    });

    return { system, user, systemParts };
  }

  async handleAction(_context: GameContext, _action: GameAction): Promise<void> {
    const runtime = this.getRuntime(_context);
    if (!runtime) return;

    if (_action.type === "START_DAY_SPEECH_AFTER_BADGE") {
      await this.startDaySpeechAfterBadge(_context.state, runtime, _action.options);
      return;
    }
    if (_action.type === "ADVANCE_SPEAKER") {
      await this.advanceSpeaker(_context.state, runtime);
    }
  }

  async onExit(_context: GameContext): Promise<void> {
    return;
  }

  private getRuntime(context: GameContext): DaySpeechRuntime | null {
    const raw = context.extras as DaySpeechRuntime | undefined;
    if (!raw) return null;
    if (!raw.setGameState || !raw.setDialogue || !raw.waitForUnpause) return null;
    if (!raw.runAISpeech || !raw.onBadgeTransfer || !raw.onHunterDeath || !raw.onGameEnd) return null;
    if (!raw.onStartVote || !raw.onBadgeSpeechEnd || !raw.onPkSpeechEnd) return null;
    return raw;
  }

  private async startDaySpeechAfterBadge(
    state: GameState,
    runtime: DaySpeechRuntime,
    options?: { skipAnnouncements?: boolean }
  ): Promise<void> {
    // 幂等保护：竞选完成回调可能被延迟操作重复触发；已经在白天讨论中就不要再重置。
    if (state.phase === "DAY_SPEECH" && state.daySpeechStartSeat !== null) return;
    const { t } = getI18n();
    const systemMessages = getSystemMessages();
    const uiText = getUiText();
    const speakerHost = t("speakers.host");
    const speakerHint = t("speakers.hint");
    const skipAnnouncements = options?.skipAnnouncements === true;

    // 1) 公布夜间死讯（幂等）：第一天已在警长竞选之前公布过，这里会自动跳过。
    let currentState = state;
    if (!skipAnnouncements) {
      currentState = await announceNightDeaths(currentState, {
        setGameState: runtime.setGameState,
        setDialogue: runtime.setDialogue,
        waitForUnpause: runtime.waitForUnpause,
      });
    }

    // 2) 取出「本夜已公布的出局者」（供猎人开枪/警徽移交判定复用），随后清空本夜标记。
    const announcedWolfSeat = currentState.nightActions.announcedWolfVictim;
    const announcedPoisonSeat = currentState.nightActions.announcedPoisonVictim;
    currentState = {
      ...currentState,
      nightActions: {
        ...currentState.nightActions,
        pendingWolfVictim: undefined,
        pendingPoisonVictim: undefined,
        announcedWolfVictim: undefined,
        announcedPoisonVictim: undefined,
      },
    };
    runtime.setGameState(currentState);

    const wolfVictim =
      announcedWolfSeat !== undefined
        ? currentState.players.find((p) => p.seat === announcedWolfSeat)
        : undefined;
    const poisonVictim =
      announcedPoisonSeat !== undefined
        ? currentState.players.find((p) => p.seat === announcedPoisonSeat)
        : undefined;

    const currentSheriffSeat = currentState.badge.holderSeat;
    const sheriffPlayer =
      currentSheriffSeat !== null ? currentState.players.find((p) => p.seat === currentSheriffSeat) : null;
    const deadSheriff = sheriffPlayer && !sheriffPlayer.alive ? sheriffPlayer : null;

    if (deadSheriff) {
      await runtime.onBadgeTransfer(currentState, deadSheriff, async (afterTransferState) => {
        if (wolfVictim?.role === "Hunter" && afterTransferState.roleAbilities.hunterCanShoot) {
          await runtime.onHunterDeath(afterTransferState, wolfVictim, true);
          return;
        }

        const winnerAfterTransfer = checkWinCondition(afterTransferState);
        if (winnerAfterTransfer) {
          await runtime.onGameEnd(afterTransferState, winnerAfterTransfer);
          return;
        }

        let speechState = transitionPhase(afterTransferState, "DAY_SPEECH");
        speechState = addSystemMessage(speechState, systemMessages.dayDiscussion);

        await playNarrator("discussionStart");

        const alivePlayers = speechState.players.filter((p) => p.alive);
        const speechDirection: "clockwise" = "clockwise";
        
        // 判断警徽是否移交成功
        const newSheriffSeat = speechState.badge.holderSeat;
        const isNewSheriffAlive =
          newSheriffSeat !== null &&
          alivePlayers.some((p) => p.seat === newSheriffSeat);

        let startSeat: number | null;
        if (isNewSheriffAlive) {
          // 警徽移交成功：从新警长下一位开始，新警长最后发言
          startSeat = getNextAliveSeat(speechState, newSheriffSeat, true, speechDirection);
        } else {
          // 警徽撕毁：从死者下一位开始
          startSeat = getNextAliveSeat(speechState, deadSheriff.seat, false, speechDirection);
        }
        
        const firstSpeaker =
          startSeat !== null ? alivePlayers.find((p) => p.seat === startSeat) || null : null;
        speechState = {
          ...speechState,
          daySpeechStartSeat: startSeat,
          currentSpeakerSeat: firstSpeaker?.seat ?? null,
          speechDirection,
        };

        runtime.setDialogue(speakerHost, uiText.speechOrder, false);
        runtime.setGameState(speechState);

        await delay(1500);
        await runtime.waitForUnpause();

        if (firstSpeaker && !firstSpeaker.isHuman) {
          await runtime.runAISpeech(speechState, firstSpeaker);
        } else if (firstSpeaker?.isHuman) {
          runtime.setDialogue(speakerHint, uiText.yourTurn, false);
        }
      });
      return;
    }

    // 喵杀修复：被毒死的猎人也要给开枪机会 —— 房规「被毒死的猎人可以开枪」
    //（poisonedHunterShoots）开启时 hunterCanShoot 仍为 true，但原代码只检查 wolfVictim，
    //  导致「只被毒杀」的猎人永远开不了枪、房规静默失效。（狼刀+毒同目标时 wolfVictim 即该猎人，原逻辑已覆盖）
    const hunterToShoot = [wolfVictim, poisonVictim].find((p) => p?.role === "Hunter");
    if (hunterToShoot && currentState.roleAbilities.hunterCanShoot) {
      await runtime.onHunterDeath(currentState, hunterToShoot, true);
      return;
    }

    const winner = checkWinCondition(currentState);
    if (winner) {
      await runtime.onGameEnd(currentState, winner);
      return;
    }

    let speechState = transitionPhase(currentState, "DAY_SPEECH");
    speechState = addSystemMessage(speechState, systemMessages.dayDiscussion);

    await playNarrator("discussionStart");

    const alivePlayers = speechState.players.filter((p) => p.alive);
    const speechDirection: "clockwise" = "clockwise";
    const sheriffSeat = speechState.badge.holderSeat;
    const isSheriffAlive =
      typeof sheriffSeat === "number" && alivePlayers.some((p) => p.seat === sheriffSeat);

    // 确定发言起始位置
    let startSeat: number | null;
    if (isSheriffAlive) {
      // 有警长存活：从警长下一位开始，警长最后发言
      startSeat = getNextAliveSeat(speechState, sheriffSeat, true, speechDirection);
    } else if (wolfVictim) {
      // 无警长但有死者：从死者下一位开始
      startSeat = getNextAliveSeat(speechState, wolfVictim.seat, false, speechDirection);
    } else {
      // 无警长无死者（和平夜）：从最小座位号开始
      const aliveSeats = alivePlayers.map((p) => p.seat).sort((a, b) => a - b);
      startSeat = aliveSeats[0] ?? null;
    }
    
    const firstSpeaker =
      startSeat !== null ? alivePlayers.find((p) => p.seat === startSeat) || null : null;
    speechState = {
      ...speechState,
      daySpeechStartSeat: startSeat,
      currentSpeakerSeat: firstSpeaker?.seat ?? null,
      speechDirection,
    };

    runtime.setDialogue(speakerHost, uiText.speechOrder, false);
    runtime.setGameState(speechState);

    // 喵杀（十七轮 · 站长验证用）：把「本日发言顺序」打在控制台，方便对照是否跳人。
    // 规则：从警长下一位开始顺时针，**警长最后归票**（不是警长先发言）。
    try {
      if (typeof startSeat === "number") {
        const orderSeats: number[] = getSpeakingOrder(speechState, startSeat, isSheriffAlive);
        console.info(
          `[meowcha] 白天发言顺序：${orderSeats.map((s) => s + 1).join(" → ")}` +
            (isSheriffAlive && typeof sheriffSeat === "number"
              ? `（警长 ${sheriffSeat + 1} 号最后归票）`
              : "（本局无警长）")
        );
      }
    } catch {
      /* 仅诊断用 */
    }

    await delay(1500);
    await runtime.waitForUnpause();

    if (firstSpeaker && !firstSpeaker.isHuman) {
      await runtime.runAISpeech(speechState, firstSpeaker);
    } else if (firstSpeaker?.isHuman) {
      runtime.setDialogue(speakerHint, uiText.yourTurn, false);
    }
  }

  private async advanceSpeaker(state: GameState, runtime: DaySpeechRuntime): Promise<void> {
    const { t } = getI18n();
    const uiText = getUiText();
    const speakerHint = t("speakers.hint");

    // 喵杀修正（第十二轮）：遗言阶段是「一次性」流程，绝不能被「推进发言者」轮转接管。
    // 历史 bug：被投票出局者说完遗言后，又轮到下一位活着的人继续发言——
    // 根因是 ADVANCE_SPEAKER 落到下方 else 分支，把 DAY_LAST_WORDS 当普通发言阶段去算
    // getNextAliveSeat(currentSpeakerSeat) 得到「下一个存活座位」并 runAISpeech。
    // 这里直接短路：遗言阶段的收尾统一交给 afterLastWords（→入夜），不做发言者推进。
    if (state.phase === "DAY_LAST_WORDS") return;

    // 防跳人（2026-10-18 · 站长实测）：轮到真人、且本回合还没有任何发言记录时，
    // 不允许任何「推进」越过他。否则旧客户端/延迟操作可能让 1/2 号被跳过，
    // 直接跑到 3/4 号发言。
    const currentSpeaker = state.players.find((p) => p.seat === state.currentSpeakerSeat);
    if (currentSpeaker?.isHuman) {
      const hasSpokenThisPhase = state.messages.some(
        (m) =>
          !m.isSystem &&
          m.day === state.day &&
          m.phase === state.phase &&
          m.playerId === currentSpeaker.playerId
      );
      if (!hasSpokenThisPhase) return;
    }

    if (this.isMovingToNextSpeaker) return;
    this.isMovingToNextSpeaker = true;

    try {
      // AI白狼王自爆决策：发言结束后检查是否自爆
      if (state.phase === "DAY_SPEECH" || state.phase === "DAY_PK_SPEECH") {
        const currentSpeaker = state.players.find((p) => p.seat === state.currentSpeakerSeat);
        if (
          currentSpeaker &&
          !currentSpeaker.isHuman &&
          currentSpeaker.role === "WhiteWolfKing" &&
          currentSpeaker.alive &&
          !state.roleAbilities.whiteWolfKingBoomUsed &&
          effectiveRules(state.houseRules).whiteWolfKingCanBoom
        ) {
          const boomed = await runtime.onWhiteWolfKingBoomCheck(state, currentSpeaker);
          if (boomed) return;
        }
      }

      const getNextPkSeat = (): number | null => {
        const pkTargets = (state.pkTargets || []).filter((seat) =>
          state.players.some((p) => p.seat === seat && p.alive)
        );
        if (pkTargets.length === 0) return null;
        const currentSeat = state.currentSpeakerSeat ?? -1;
        const currentIndex = pkTargets.indexOf(currentSeat);
        const nextIndex = currentIndex + 1;
        if (currentIndex === -1) return pkTargets[0] ?? null;
        if (nextIndex >= pkTargets.length) return null;
        return pkTargets[nextIndex];
      };

      const getNextCandidateSeat = (): number | null => {
        // 按候选人座位顺序推进，最后一位之后返回 null（不能绕回第一位）。
        return getNextBadgeCandidateSeat(state);
      };

      const isDaySpeech = state.phase === "DAY_SPEECH";

      // 喵杀修复（2026-10-18 · 站长实测）：白天发言顺序统一走 getNextDaySpeechSeat。
      // 规则：从 daySpeechStartSeat 起顺时针，跳过已出局/已发言者，存活警长最后归票。
      // 旧实现在「警长不是起始发言者」时，循环回起点会直接开投票，导致警长被跳过。
      let nextSeat: number | null;
      if (state.phase === "DAY_PK_SPEECH") {
        nextSeat = getNextPkSeat();
      } else if (state.phase === "DAY_BADGE_SPEECH") {
        nextSeat = getNextCandidateSeat();
      } else if (isDaySpeech) {
        nextSeat = getNextDaySpeechSeat(state);
      } else {
        nextSeat = null;
      }

      if (nextSeat === null) {
        if (state.phase === "DAY_PK_SPEECH") {
          await runtime.onPkSpeechEnd(state);
          return;
        }
        if (state.phase === "DAY_BADGE_SPEECH") {
          await runtime.onBadgeSpeechEnd(state);
          return;
        }
        await runtime.onStartVote(state, runtime.token);
        return;
      }

      const currentState = { ...state, currentSpeakerSeat: nextSeat };
      runtime.setGameState(currentState);

      const nextPlayer = currentState.players.find((p) => p.seat === nextSeat);
      if (nextPlayer?.alive && !nextPlayer.isHuman) {
        // 喵杀（十七轮 · 站长验证用）：AI 发言**一定是在前面的真人说完之后**才开始，
        // 且它拿到的上下文里已经包含所有已发言的人（含真人）。这里把「已有多少条当天发言」打出来。
        const todayCount = currentState.messages.filter(
          (m) => !m.isSystem && m.day === state.day && m.phase === "DAY_SPEECH"
        ).length;
        console.info(
          `[meowcha] 顺序发言：开始生成 ${nextPlayer.seat + 1}号（AI）· 上下文已含当天 ${todayCount} 条发言`
        );
        await runtime.runAISpeech(currentState, nextPlayer);
      } else if (nextPlayer?.alive && nextPlayer.isHuman) {
        // 关键：真人发言位会把引擎停在这里等待 —— 后面（AI）的发言不会抢跑
        console.info(
          `[meowcha] 顺序发言：轮到 ${nextPlayer.seat + 1}号（真人）→ 后台暂停生成，等他发言完再继续`
        );
        runtime.setDialogue(speakerHint, uiText.yourTurn, false);
      }
    } finally {
      this.isMovingToNextSpeaker = false;
    }
  }
}
