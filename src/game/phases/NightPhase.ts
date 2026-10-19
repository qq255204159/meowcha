import { type GameState, type Player, type Phase, isWolfRole } from "@/types/game";
import { GamePhase } from "../core/GamePhase";
import type { GameAction, GameContext, PromptResult, SystemPromptPart } from "../core/types";
import {
  buildGameContext,
  buildNightDecisionContext,
  buildDifficultyDecisionHint,
  getRoleText,
  getWinCondition,
  buildSystemTextFromParts,
} from "@/lib/prompt-utils";
import {
  addSystemMessage,
  generateGuardAction,
  generateSeerAction,
  generateWitchAction,
  generateWolfAction,
  transitionPhase as rawTransitionPhase,
} from "@/lib/game-master";
import { getSystemMessages, getUiText } from "@/lib/game-texts";
import { DELAY_CONFIG, GAME_CONFIG } from "@/lib/game-constants";
import {
  computeUniqueTopSeat,
  delay,
  pickRandomFromTie,
  type FlowToken,
} from "@/lib/game-flow-controller";
import { playNarrator } from "@/lib/narrator-audio-player";
import { getI18n } from "@/i18n/translator";
import { effectiveRules } from "@/lib/house-rules";

function randomFakeActionDelay(): number {
  return Math.floor(Math.random() * 3000) + 3000;
}

type NightPhaseRuntime = {
  token: FlowToken;
  setGameState: (value: GameState | ((prev: GameState) => GameState)) => void;
  setDialogue: (speaker: string, text: string, isStreaming?: boolean) => void;
  setIsWaitingForAI: (waiting: boolean) => void;
  waitForUnpause: () => Promise<void>;
  isTokenValid: (token: FlowToken) => boolean;
  onNightComplete: (state: GameState) => Promise<void>;
  /**
   * 喵杀（十七轮 · 站长联机实测）：本机真人所坐的座位（<0 = 单人/未联机 → 场上真人都算本机）。
   * 用途：夜间的「选择击杀目标 / 查验目标 / 守护目标」这类**私密行动提示**只能给当事人看，
   * 否则房主（比如村民）会看到「选择要击杀的目标。点击玩家卡片进行选择。」→ 一眼看破朋友是狼（剧透）。
   * 非当事人一律回落到中立的「XX正在行动」文案，和 AI 回合完全一致、无从分辨。
   */
  localSeat?: number;
};

export class NightPhase extends GamePhase {
  async onEnter(_context: GameContext): Promise<void> {
    return;
  }

  getPrompt(context: GameContext, player: Player): PromptResult {
    const state = context.state;
    const extras = context.extras ?? {};

    switch (state.phase) {
      case "NIGHT_GUARD_ACTION":
        return this.buildGuardPrompt(state, player);
      case "NIGHT_WOLF_ACTION":
        return this.buildWolfPrompt(
          state,
          player,
          (extras.existingVotes as Record<string, number> | undefined) ?? {}
        );
      case "NIGHT_WITCH_ACTION":
        return this.buildWitchPrompt(
          state,
          player,
          extras.wolfTarget as number | undefined
        );
      case "NIGHT_SEER_ACTION":
        return this.buildSeerPrompt(state, player);
      default:
        return this.buildWolfPrompt(state, player, {});
    }
  }

  async handleAction(_context: GameContext, _action: GameAction): Promise<void> {
    const runtime = this.getRuntime(_context);
    if (!runtime) return;

    if (_action.type === "START_NIGHT") {
      await this.runNightPhase(_context.state, runtime);
      return;
    }
    if (_action.type === "CONTINUE_NIGHT_AFTER_GUARD") {
      await this.continueNightAfterGuard(_context.state, runtime);
      return;
    }
    if (_action.type === "CONTINUE_NIGHT_AFTER_WOLF") {
      await this.continueNightAfterWolf(_context.state, runtime);
      return;
    }
    if (_action.type === "CONTINUE_NIGHT_AFTER_WITCH") {
      await this.continueNightAfterWitch(_context.state, runtime);
      return;
    }
  }

  async onExit(_context: GameContext): Promise<void> {
    return;
  }

  private getRuntime(context: GameContext): NightPhaseRuntime | null {
    const raw = context.extras as NightPhaseRuntime | undefined;
    if (!raw) return null;
    if (!raw.setGameState || !raw.setDialogue || !raw.waitForUnpause || !raw.isTokenValid) return null;
    return raw;
  }

  private transitionPhase(state: GameState, newPhase: Phase): GameState {
    return rawTransitionPhase(state, newPhase);
  }

  /** 该真人是不是「本机操控的那一位」（单人/未联机时所有真人都算本机） */
  private isLocalHuman(runtime: NightPhaseRuntime, player: Player | undefined): boolean {
    if (!player) return false;
    const seat = runtime.localSeat;
    if (typeof seat !== "number" || seat < 0) return true;
    return player.seat === seat;
  }

  private async runGuardAction(state: GameState, runtime: NightPhaseRuntime): Promise<GameState> {
    const { t } = getI18n();
    const speakerSystem = t("speakers.system");
    const systemMessages = getSystemMessages();
    const uiText = getUiText();
    const guard = state.players.find((p) => p.role === "Guard" && p.alive);

    if (!guard) {
      return state;
    }

    let currentState = this.transitionPhase(state, "NIGHT_GUARD_ACTION");
    currentState = addSystemMessage(currentState, systemMessages.guardActionStart);
    runtime.setGameState(currentState);

    runtime.setIsWaitingForAI(true);
    runtime.setDialogue(speakerSystem, uiText.guardActing, false);
    await playNarrator("guardWake");

    if (guard.isHuman) {
      runtime.setIsWaitingForAI(false);
      // 只有本机操控的守卫才给「选择要守护的对象」提示；别人（如房主是村民）看到的是中立文案，
      // 与 AI 回合完全一致 → 无法据此判断谁是守卫。
      runtime.setDialogue(
        speakerSystem,
        this.isLocalHuman(runtime, guard) ? uiText.waitingGuard : uiText.guardActing,
        false
      );
      return currentState;
    }

    const guardTarget = await generateGuardAction(currentState, guard);
    await runtime.waitForUnpause();

    if (!runtime.isTokenValid(runtime.token)) return currentState;

    currentState = {
      ...currentState,
      nightActions: { ...currentState.nightActions, guardTarget },
    };
    runtime.setGameState(currentState);
    runtime.setIsWaitingForAI(false);

    await playNarrator("guardClose");

    return currentState;
  }

  private async runWolfAction(state: GameState, runtime: NightPhaseRuntime): Promise<GameState> {
    const { t } = getI18n();
    const speakerSystem = t("speakers.system");
    const systemMessages = getSystemMessages();
    const uiText = getUiText();
    let currentState = this.transitionPhase(state, "NIGHT_WOLF_ACTION");
    currentState = addSystemMessage(currentState, systemMessages.wolfActionStart);
    runtime.setGameState(currentState);

    const wolves = currentState.players.filter((p) => isWolfRole(p.role) && p.alive);

    if (wolves.length > 0) {
      const humanWolf = wolves.find((w) => w.isHuman);
      if (humanWolf) {
        // 剧透修复：狼人若是**别人**（联机时常见：房主是村民、朋友是狼），
        // 之前房主会看到「选择要击杀的目标。点击玩家卡片进行选择。」→ 直接看破朋友是狼。
        // 非本机狼一律给中立文案（与 AI 狼相同），本机狼才给操作提示。
        runtime.setDialogue(
          speakerSystem,
          this.isLocalHuman(runtime, humanWolf) ? uiText.waitingWolf : uiText.wolfActing,
          false
        );
      } else {
        runtime.setIsWaitingForAI(true);
        runtime.setDialogue(speakerSystem, uiText.wolfActing, false);
      }

      await playNarrator("wolfWake");

      if (humanWolf) {
        return currentState;
      }

      let wolfVotes: Record<string, number> = {};
      try {
        // 简化逻辑：第一个狼人决定目标，其他狼人自动达成共识
        const firstWolf = wolves[0];
        const targetSeat = await generateWolfAction(currentState, firstWolf, {});
        
        await runtime.waitForUnpause();
        if (!runtime.isTokenValid(runtime.token)) return currentState;
        
        // 所有狼人投票给同一个目标
        for (const wolf of wolves) {
          wolfVotes[wolf.playerId] = targetSeat;
        }

        currentState = {
          ...currentState,
          nightActions: { ...currentState.nightActions, wolfVotes, wolfTarget: targetSeat },
        };
        runtime.setGameState(currentState);
      } catch (error) {
        console.error("[meowcha] AI wolf vote failed:", error);
        const villagers = currentState.players.filter((p) => p.alive && p.alignment === "village");
        const fallbackSeat = villagers.length > 0
          ? villagers[Math.floor(Math.random() * villagers.length)].seat
          : 0;
        currentState = {
          ...currentState,
          nightActions: { ...currentState.nightActions, wolfVotes, wolfTarget: fallbackSeat },
        };
        runtime.setGameState(currentState);
      }

      runtime.setIsWaitingForAI(false);

      await playNarrator("wolfClose");
    }

    return currentState;
  }

  private async runWitchAction(state: GameState, runtime: NightPhaseRuntime): Promise<GameState> {
    const { t } = getI18n();
    const speakerSystem = t("speakers.system");
    const systemMessages = getSystemMessages();
    const uiText = getUiText();
    const witch = state.players.find((p) => p.role === "Witch" && p.alive);
    const canWitchAct = witch && (!state.roleAbilities.witchHealUsed || !state.roleAbilities.witchPoisonUsed);
    let currentState = this.transitionPhase(state, "NIGHT_WITCH_ACTION");
    currentState = addSystemMessage(currentState, systemMessages.witchActionStart);
    runtime.setGameState(currentState);

    runtime.setIsWaitingForAI(true);
    runtime.setDialogue(speakerSystem, uiText.witchActing, false);
    await playNarrator("witchWake");

    if (!witch || !canWitchAct) {
      await delay(randomFakeActionDelay());
      await runtime.waitForUnpause();
      if (!runtime.isTokenValid(runtime.token)) return currentState;
      runtime.setIsWaitingForAI(false);
      await playNarrator("witchClose");
      return currentState;
    }

    if (witch.isHuman) {
      runtime.setIsWaitingForAI(false);
      // 剧透修复：女巫是别人时不给「选择是否用药」提示（中立文案与 AI 回合一致）
      runtime.setDialogue(
        speakerSystem,
        this.isLocalHuman(runtime, witch) ? uiText.waitingWitch : uiText.witchActing,
        false
      );
      return currentState;
    }

    const witchAction = await generateWitchAction(currentState, witch, currentState.nightActions.wolfTarget);
    await runtime.waitForUnpause();

    if (!runtime.isTokenValid(runtime.token)) return currentState;

    // 房规：女巫自救限制。若本局禁止自救，AI 自救视为无效操作。
    const rules = effectiveRules(currentState.houseRules);
    const selfSaveAllowed =
      rules.witchSelfSave === "always" ||
      (rules.witchSelfSave === "firstNightOnly" && currentState.day === 1);
    const blockSelfSave =
      witchAction.type === "save" &&
      currentState.nightActions.wolfTarget === witch.seat &&
      !selfSaveAllowed;

    if (witchAction.type === "save" && !blockSelfSave) {
      currentState = {
        ...currentState,
        nightActions: { ...currentState.nightActions, witchSave: true },
        roleAbilities: { ...currentState.roleAbilities, witchHealUsed: true },
      };
    } else if (witchAction.type === "poison" && witchAction.target !== undefined) {
      currentState = {
        ...currentState,
        nightActions: { ...currentState.nightActions, witchPoison: witchAction.target },
        roleAbilities: { ...currentState.roleAbilities, witchPoisonUsed: true },
      };
    }
    runtime.setGameState(currentState);
    runtime.setIsWaitingForAI(false);

    await playNarrator("witchClose");

    return currentState;
  }

  private async runSeerAction(state: GameState, runtime: NightPhaseRuntime): Promise<GameState> {
    const { t } = getI18n();
    const speakerSystem = t("speakers.system");
    const systemMessages = getSystemMessages();
    const uiText = getUiText();
    const seer = state.players.find((p) => p.role === "Seer" && p.alive);
    let currentState = this.transitionPhase(state, "NIGHT_SEER_ACTION");
    currentState = addSystemMessage(currentState, systemMessages.seerActionStart);
    runtime.setGameState(currentState);

    runtime.setIsWaitingForAI(true);
    runtime.setDialogue(speakerSystem, uiText.seerChecking, false);
    await playNarrator("seerWake");

    if (!seer) {
      await delay(randomFakeActionDelay());
      await runtime.waitForUnpause();
      if (!runtime.isTokenValid(runtime.token)) return currentState;
      runtime.setIsWaitingForAI(false);
      await playNarrator("seerClose");
      return currentState;
    }

    if (seer.isHuman) {
      runtime.setIsWaitingForAI(false);
      // 剧透修复：预言家是别人时不给「选择查验目标」提示（中立文案与 AI 回合一致）
      runtime.setDialogue(
        speakerSystem,
        this.isLocalHuman(runtime, seer) ? uiText.waitingSeer : uiText.seerChecking,
        false
      );
      return currentState;
    }

    const targetSeat = await generateSeerAction(currentState, seer);
    if (!runtime.isTokenValid(runtime.token)) return currentState;

    const targetPlayer = currentState.players.find((p) => p.seat === targetSeat);
    const isWolf = isWolfRole(targetPlayer?.role);

    const seerHistory = currentState.nightActions.seerHistory || [];
    currentState = {
      ...currentState,
      nightActions: {
        ...currentState.nightActions,
        seerTarget: targetSeat,
        seerResult: { targetSeat, isWolf },
        seerHistory: [...seerHistory, { targetSeat, isWolf, day: currentState.day }],
      },
    };
    runtime.setGameState(currentState);
    runtime.setIsWaitingForAI(false);

    await playNarrator("seerClose");

    return currentState;
  }

  private async runNightPhase(state: GameState, runtime: NightPhaseRuntime): Promise<void> {
    let currentState = state;

    const hasAliveGuard = currentState.players.some((p) => p.role === "Guard" && p.alive);
    if (hasAliveGuard) {
      currentState = await this.runGuardAction(currentState, runtime);
      if (!runtime.isTokenValid(runtime.token)) return;

      const guard = currentState.players.find((p) => p.role === "Guard" && p.alive);
      if (guard?.isHuman && currentState.nightActions.guardTarget === undefined) {
        return;
      }

      await delay(2000);
      await runtime.waitForUnpause();
      if (!runtime.isTokenValid(runtime.token)) return;
    }

    currentState = await this.runWolfAction(currentState, runtime);
    if (!runtime.isTokenValid(runtime.token)) return;

    const humanWolf = currentState.players.find((p) => isWolfRole(p.role) && p.alive && p.isHuman);
    if (humanWolf && currentState.nightActions.wolfTarget === undefined) {
      return;
    }

    await delay(2000);
    await runtime.waitForUnpause();
    if (!runtime.isTokenValid(runtime.token)) return;

    currentState = await this.runWitchAction(currentState, runtime);
    if (!runtime.isTokenValid(runtime.token)) return;

    const witch = currentState.players.find((p) => p.role === "Witch" && p.alive);
    const canWitchAct = witch && (!currentState.roleAbilities.witchHealUsed || !currentState.roleAbilities.witchPoisonUsed);
    if (witch?.isHuman && canWitchAct) {
      const decided =
        currentState.nightActions.witchSave !== undefined ||
        currentState.nightActions.witchPoison !== undefined;
      if (!decided) return;
    }

    await delay(2000);
    await runtime.waitForUnpause();
    if (!runtime.isTokenValid(runtime.token)) return;

    currentState = await this.runSeerAction(currentState, runtime);
    if (!runtime.isTokenValid(runtime.token)) return;

    const seer = currentState.players.find((p) => p.role === "Seer" && p.alive);
    if (seer?.isHuman && currentState.nightActions.seerTarget === undefined) {
      return;
    }

    await delay(DELAY_CONFIG.DIALOGUE);
    await runtime.waitForUnpause();
    if (!runtime.isTokenValid(runtime.token)) return;

    await runtime.onNightComplete(currentState);
  }

  private async continueNightAfterGuard(state: GameState, runtime: NightPhaseRuntime): Promise<void> {
    let currentState = await this.runWolfAction(state, runtime);
    if (!runtime.isTokenValid(runtime.token)) return;

    const humanWolf = currentState.players.find((p) => isWolfRole(p.role) && p.alive && p.isHuman);
    if (humanWolf && currentState.nightActions.wolfTarget === undefined) {
      return;
    }

    await delay(2000);
    await runtime.waitForUnpause();
    if (!runtime.isTokenValid(runtime.token)) return;

    await this.continueNightAfterWolf(currentState, runtime);
  }

  private async continueNightAfterWolf(state: GameState, runtime: NightPhaseRuntime): Promise<void> {
    let currentState = await this.runWitchAction(state, runtime);
    if (!runtime.isTokenValid(runtime.token)) return;

    const witch = currentState.players.find((p) => p.role === "Witch" && p.alive);
    const canWitchAct = witch && (!currentState.roleAbilities.witchHealUsed || !currentState.roleAbilities.witchPoisonUsed);
    if (witch?.isHuman && canWitchAct) {
      const decided =
        currentState.nightActions.witchSave !== undefined ||
        currentState.nightActions.witchPoison !== undefined;
      if (!decided) return;
    }

    await delay(2000);
    await runtime.waitForUnpause();
    if (!runtime.isTokenValid(runtime.token)) return;

    await this.continueNightAfterWitch(currentState, runtime);
  }

  private async continueNightAfterWitch(state: GameState, runtime: NightPhaseRuntime): Promise<void> {
    let currentState = await this.runSeerAction(state, runtime);
    if (!runtime.isTokenValid(runtime.token)) return;

    const seer = currentState.players.find((p) => p.role === "Seer" && p.alive);
    if (seer?.isHuman && currentState.nightActions.seerTarget === undefined) {
      return;
    }

    await delay(2000);
    await runtime.waitForUnpause();
    if (!runtime.isTokenValid(runtime.token)) return;

    await runtime.onNightComplete(currentState);
  }

  private buildSeerPrompt(state: GameContext["state"], player: Player): PromptResult {
    const { t } = getI18n();
    const context = buildGameContext(state, player);
    const seerHistory = state.nightActions.seerHistory || [];
    const checkedSeats = seerHistory.map((h) => h.targetSeat);
    const difficultyHint = buildDifficultyDecisionHint(state.difficulty, player.role);

    const alivePlayers = state.players.filter(
      (p) => p.alive && p.playerId !== player.playerId
    );

    const uncheckedPlayers = alivePlayers.filter((p) => !checkedSeats.includes(p.seat));
    const alreadyChecked = alivePlayers.filter((p) => checkedSeats.includes(p.seat));

    const checkedList = alreadyChecked
      .map((p) => t("promptUtils.gameContext.seatLabel", { seat: p.seat + 1 }))
      .join(t("promptUtils.gameContext.listSeparator"));
    const optionsList = (uncheckedPlayers.length > 0 ? uncheckedPlayers : alivePlayers)
      .map((p) => t("prompts.night.option", { seat: p.seat + 1, name: p.displayName }))
      .join(t("promptUtils.gameContext.listSeparator"));

    const cacheableContent = t("prompts.night.seer.base", {
      seat: player.seat + 1,
      name: player.displayName,
      role: getRoleText("Seer"),
      winCondition: getWinCondition("Seer"),
      difficultyHint,
    });

    const dynamicContent = t("prompts.night.seer.task", {
      checkedLine: alreadyChecked.length > 0 ? t("prompts.night.seer.checkedLine", { list: checkedList }) : "",
      options: optionsList,
    });

    const systemParts: SystemPromptPart[] = [
      { text: cacheableContent, cacheable: true, ttl: "1h" },
      { text: dynamicContent },
    ];
    const system = buildSystemTextFromParts(systemParts);

    const user = `${t("prompts.night.seer.user", { context })}\n\n${buildNightDecisionContext(
      state,
      player,
      { transcriptChars: 3000, selfSpeechChars: 1200 }
    )}`;

    return { system, user, systemParts };
  }

  private buildWolfPrompt(
    state: GameContext["state"],
    player: Player,
    existingVotes: Record<string, number>
  ): PromptResult {
    const { t } = getI18n();
    const context = buildGameContext(state, player);
    const difficultyHint = buildDifficultyDecisionHint(state.difficulty, player.role);
    // 狼人可以刀任何存活玩家（包括队友和自己），但通常刀好人
    const alivePlayers = state.players.filter((p) => p.alive);
    const teammates = state.players.filter(
      (p) => isWolfRole(p.role) && p.playerId !== player.playerId && p.alive
    );

    const teammateVotesStr = teammates
      .map((teammate) => {
        const vote = existingVotes[teammate.playerId];
        if (vote === undefined) return null;
        const target = state.players.find((p) => p.seat === vote);
        return t("prompts.night.wolf.voteLine", {
          seat: teammate.seat + 1,
          name: teammate.displayName,
          targetSeat: vote + 1,
          targetName: target ? t("prompts.night.optionName", { name: target.displayName }) : "",
        });
      })
      .filter(Boolean)
      .join("\n");

    const identitySection = t("prompts.night.wolf.base", {
      seat: player.seat + 1,
      name: player.displayName,
      role: getRoleText("Werewolf"),
    });
    const teammateLine = teammates.length > 0
      ? t("prompts.night.wolf.teammates", {
        list: teammates
          .map((teammate) =>
            t("promptUtils.gameContext.seatName", { seat: teammate.seat + 1, name: teammate.displayName })
          )
          .join(t("promptUtils.gameContext.listSeparator")),
      })
      : t("prompts.night.wolf.solo");
    const cacheableRules = t("prompts.night.wolf.rules", {
      winCondition: getWinCondition("Werewolf"),
      difficultyHint,
    });
    const teammateVotesSection = teammateVotesStr
      ? t("prompts.night.wolf.teammateVotes", { lines: teammateVotesStr })
      : "";
    // 喵杀修复（2026-10-18 · 站长实测）：狼人首夜没有任何信息，而模型对「候选列表的第一项」有明显偏好 ——
    // 原来「可选:」按座位升序排（1号在最前），于是 AI 狼几乎每次都刀 1 号位（站长连续几局都在第一晚被刀）。
    // 现在把候选顺序打乱（Fisher–Yates）：只改变模型「读到的顺序」，不改变可选项集合。
    const shuffledAlive = [...alivePlayers];
    for (let i = shuffledAlive.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledAlive[i], shuffledAlive[j]] = [shuffledAlive[j], shuffledAlive[i]];
    }
    const taskSection = t("prompts.night.wolf.task", {
      teammateVotesSection,
      options: shuffledAlive
        .map((p) => t("prompts.night.option", { seat: p.seat + 1, name: p.displayName }))
        .join(t("promptUtils.gameContext.listSeparator")),
    });

    const systemParts: SystemPromptPart[] = [
      { text: identitySection, cacheable: true, ttl: "1h" },
      { text: teammateLine },
      { text: cacheableRules, cacheable: true, ttl: "1h" },
      { text: taskSection },
    ];
    const system = buildSystemTextFromParts(systemParts);

    const user = `${t("prompts.night.wolf.user", { context })}\n\n${buildNightDecisionContext(
      state,
      player,
      { transcriptChars: 3600, selfSpeechChars: 1200 }
    )}`;

    return { system, user, systemParts };
  }

  private buildGuardPrompt(state: GameContext["state"], player: Player): PromptResult {
    const { t } = getI18n();
    const context = buildGameContext(state, player);
    const alivePlayers = state.players.filter((p) => p.alive);
    const lastTarget = state.nightActions.lastGuardTarget;
    const difficultyHint = buildDifficultyDecisionHint(state.difficulty, player.role);

    const cacheableContent = t("prompts.night.guard.base", {
      seat: player.seat + 1,
      name: player.displayName,
      role: getRoleText("Guard"),
      winCondition: getWinCondition("Guard"),
      difficultyHint,
    });
    const options = alivePlayers
      .filter((p) => p.seat !== lastTarget)
      .map((p) => t("prompts.night.option", { seat: p.seat + 1, name: p.displayName }))
      .join(t("promptUtils.gameContext.listSeparator"));
    const lastTargetLine =
      lastTarget !== undefined ? t("prompts.night.guard.lastTarget", { seat: lastTarget + 1 }) : "";
    const dynamicContent = t("prompts.night.guard.task", {
      options,
      lastTargetLine,
    });
    const systemParts: SystemPromptPart[] = [
      { text: cacheableContent, cacheable: true, ttl: "1h" },
      { text: dynamicContent },
    ];
    const system = buildSystemTextFromParts(systemParts);

    const user = `${t("prompts.night.guard.user", { context })}\n\n${buildNightDecisionContext(
      state,
      player,
      { transcriptChars: 3200, selfSpeechChars: 1200 }
    )}`;

    return { system, user, systemParts };
  }

  private buildWitchPrompt(
    state: GameContext["state"],
    player: Player,
    wolfTarget: number | undefined
  ): PromptResult {
    const { t } = getI18n();
    const context = buildGameContext(state, player);
    const difficultyHint = buildDifficultyDecisionHint(state.difficulty, player.role);
    const alivePlayers = state.players.filter(
      (p) => p.alive && p.playerId !== player.playerId
    );

    const canSave =
      !state.roleAbilities.witchHealUsed &&
      wolfTarget !== undefined;
    const canPoison = !state.roleAbilities.witchPoisonUsed;

    const victimInfo =
      wolfTarget !== undefined && !state.roleAbilities.witchHealUsed
        ? state.players.find((p) => p.seat === wolfTarget)
        : null;

    const cacheableContent = t("prompts.night.witch.base", {
      seat: player.seat + 1,
      name: player.displayName,
      role: getRoleText("Witch"),
      winCondition: getWinCondition("Witch"),
      difficultyHint,
    });
    const statusHeal = state.roleAbilities.witchHealUsed
      ? t("promptUtils.gameContext.used")
      : t("promptUtils.gameContext.available");
    const statusPoison = state.roleAbilities.witchPoisonUsed
      ? t("promptUtils.gameContext.used")
      : t("promptUtils.gameContext.available");
    const tonightInfo = victimInfo
      ? t("prompts.night.witch.victimLine", { seat: wolfTarget! + 1, name: victimInfo.displayName })
      : state.roleAbilities.witchHealUsed
        ? t("prompts.night.witch.noSense")
        : t("prompts.night.witch.noAttack");
    const saveLine = canSave
      ? t("prompts.night.witch.saveOption", { seat: wolfTarget! + 1 })
      : t("prompts.night.witch.noSave");
    const poisonLine = canPoison ? t("prompts.night.witch.poisonOption") : t("prompts.night.witch.noPoison");
    const poisonTargets = alivePlayers
      .map((p) => t("promptUtils.gameContext.seatLabel", { seat: p.seat + 1 }))
      .join(t("promptUtils.gameContext.listSeparator"));
    const firstNightHint =
      state.day === 1 && canSave ? t("prompts.night.witch.firstNightHint") : "";
    const dynamicContent = t("prompts.night.witch.task", {
      healStatus: statusHeal,
      poisonStatus: statusPoison,
      tonightInfo,
      saveLine,
      poisonLine,
      poisonTargets,
    }) + (firstNightHint ? `\n\n${firstNightHint}` : "");
    const systemParts: SystemPromptPart[] = [
      { text: cacheableContent, cacheable: true, ttl: "1h" },
      { text: dynamicContent },
    ];
    const system = buildSystemTextFromParts(systemParts);

    const user = `${t("prompts.night.witch.user", { context })}\n\n${buildNightDecisionContext(
      state,
      player,
      { transcriptChars: 3200, selfSpeechChars: 1200 }
    )}`;

    return { system, user, systemParts };
  }
}
