import type { GameState, Player } from "@/types/game";
import { GamePhase } from "../core/GamePhase";
import type { GameAction, GameContext, PromptResult, SystemPromptPart } from "../core/types";
import {
  buildGameContext,
  buildDifficultyDecisionHint,
  buildTodayTranscript,
  buildPlayerTodaySpeech,
  getRoleText,
  getWinCondition,
  getRoleKnowHow,
  buildSystemTextFromParts,
  buildVoteTallyNote,
} from "@/lib/prompt-utils";
import { getI18n } from "@/i18n/translator";
import {
  addSystemMessage,
  checkWinCondition,
  generateAIVote,
  getEligibleVoterIds,
  killPlayer,
  tallyVotes,
  transitionPhase,
} from "@/lib/game-master";
import { getSystemMessages, getUiText } from "@/lib/game-texts";
import { DELAY_CONFIG } from "@/lib/game-constants";
import { effectiveRules } from "@/lib/house-rules";
import { delay, type FlowToken } from "@/lib/game-flow-controller";
import { playNarrator } from "@/lib/narrator-audio-player";
import { getPlayerDiedKey } from "@/lib/narrator-voice";

type VotePhaseRuntime = {
  token: FlowToken;
  isRevote?: boolean;
  humanPlayer: Player | null;
  setGameState: (value: GameState | ((prev: GameState) => GameState)) => void;
  setDialogue: (speaker: string, text: string, isStreaming?: boolean) => void;
  setIsWaitingForAI: (waiting: boolean) => void;
  waitForUnpause: () => Promise<void>;
  isTokenValid: (token: FlowToken) => boolean;
  onVoteComplete: (state: GameState, result: { seat: number; count: number } | null) => Promise<void>;
  /** 喵杀（2026-10-16）：把「票型」先推给界面并等玩家点「继续」，再进入处决/遗言/入夜 */
  pauseForReview?: (state: GameState) => Promise<void>;
  onGameEnd: (state: GameState, winner: "village" | "wolf") => Promise<void>;
  runAISpeech: (state: GameState, player: Player) => Promise<void>;
  /** 与 useGameLogic 的投票安全网共用同一把锁，避免自动结算被并发触发两次 */
  beginVoteResolution?: () => void;
  endVoteResolution?: () => void;
};

export class VotePhase extends GamePhase {
  async onEnter(context: GameContext): Promise<void> {
    const runtime = this.getRuntime(context);
    if (!runtime) return;

    const { t } = getI18n();
    const uiText = getUiText();
    const systemMessages = getSystemMessages();
    const speakerHost = t("speakers.host");
    const speakerHint = t("speakers.hint");

    const { humanPlayer, setDialogue, setGameState, setIsWaitingForAI, waitForUnpause, isTokenValid, token } = runtime;
    const isRevote = runtime.isRevote === true;

    let currentState = transitionPhase(context.state, "DAY_VOTE");
    currentState = {
      ...currentState,
      currentSpeakerSeat: null,
      nextSpeakerSeatOverride: null,
      votes: {},
      voteReasons: {},
      pkTargets: isRevote ? context.state.pkTargets : undefined,
      pkSource: isRevote ? "vote" : undefined,
    };
    currentState = addSystemMessage(currentState, systemMessages.voteStart);
    // 已翻牌白痴是否失去投票权由房规决定（标准＝失去）
    const isRevealedIdiot = humanPlayer?.role === "Idiot" && currentState.roleAbilities.idiotRevealed && effectiveRules(currentState.houseRules).idiotRevealedLosesVote;
    setDialogue(speakerHost, humanPlayer?.alive && !isRevealedIdiot ? uiText.votePrompt : uiText.aiVoting, false);
    setGameState(currentState);

    await playNarrator("voteStart");
    await waitForUnpause();

    if (humanPlayer?.alive && !isRevealedIdiot) {
      setDialogue(speakerHint, uiText.clickToVote, false);
    }

    // PK投票时，参与PK的人不能投票
    const pkTargets = currentState.pkSource === "vote" && Array.isArray(currentState.pkTargets) ? currentState.pkTargets : [];
    // 已翻牌白痴不参与投票（节省 AI 调用）—— 仅当房规要求「翻牌后失去投票权」（标准）时
    const revealedIdiotId = currentState.roleAbilities.idiotRevealed && effectiveRules(currentState.houseRules).idiotRevealedLosesVote
      ? currentState.players.find((p) => p.role === "Idiot" && p.alive)?.playerId
      : undefined;
    const aiPlayers = currentState.players.filter((p) => p.alive && !p.isHuman && !pkTargets.includes(p.seat) && p.playerId !== revealedIdiotId);
    let tokenInvalidated = false;
    setIsWaitingForAI(true);
    try {
      for (const aiPlayer of aiPlayers) {
        if (!isTokenValid(token)) {
          tokenInvalidated = true;
          break;
        }
        const vote = await generateAIVote(currentState, aiPlayer);
        if (!isTokenValid(token)) {
          tokenInvalidated = true;
          break;
        }

        setGameState((prevState) => ({
          ...prevState,
          votes: { ...prevState.votes, [aiPlayer.playerId]: vote.seat },
          voteReasons: { ...(prevState.voteReasons || {}), [aiPlayer.playerId]: vote.reason },
        }));
        currentState = {
          ...currentState,
          votes: { ...currentState.votes, [aiPlayer.playerId]: vote.seat },
          voteReasons: { ...(currentState.voteReasons || {}), [aiPlayer.playerId]: vote.reason },
        };
      }
    } finally {
      setIsWaitingForAI(false);
    }
    if (tokenInvalidated) return;

    // 人类不需要投票时自动结算：死亡、白痴已翻牌、PK 目标，
    // 或场上只剩「已翻牌白痴」这一个不投票的人。
    const eligibleIds = getEligibleVoterIds(currentState);
    const allVoted =
      eligibleIds.length === 0 ||
      eligibleIds.every((id) => typeof currentState.votes[id] === "number");
    if (allVoted) {
      // 喵杀修复（2026-10-18 · 站长实测）：自动结算与投票安全网共用一把锁。
      // 两边并发结算会把「遗言 → 入夜」重复/错序，表现为死后又突然开始投票。
      runtime.beginVoteResolution?.();
      try {
        await this.resolveVotes(currentState, runtime);
      } finally {
        runtime.endVoteResolution?.();
      }
    }
  }

  getPrompt(context: GameContext, player: Player): PromptResult {
    const state = context.state;
    const gameContext = buildGameContext(state, player);
    const eligibleSeats =
      state.pkSource === "vote" && state.pkTargets && state.pkTargets.length > 0
        ? new Set(state.pkTargets)
        : null;
    const difficultyHint = buildDifficultyDecisionHint(state.difficulty, player.role);
    const alivePlayers = state.players.filter(
      (p) =>
        p.alive &&
        p.playerId !== player.playerId &&
        (!eligibleSeats || eligibleSeats.has(p.seat))
    );

    const todayTranscript = buildTodayTranscript(state, 10000);
    const selfSpeech = buildPlayerTodaySpeech(state, player, 2000);

    // Get role-specific strategy tips
    const roleKnowHow = getRoleKnowHow(player.role);

    const { t } = getI18n();

    // 喵杀修复：投票专属提示原先只给了「狼人 / 预言家」，
    // 好人阵营（村民/女巫/猎人/守卫/白痴）完全没有投票指引 → 即使警长已经归票，
    // 各 AI 仍只按自己发言里点过的人投，票型自然散开、狼人经常票不出去。
    // 现在：狼人（含白狼王）拿狼队提示；其余全部拿「好人投票原则」（跟随警长归票 + 票型集中）；预言家再叠加一条。
    const isWolfVoter = player.role === "Werewolf" || player.role === "WhiteWolfKing";
    type VoteHintKey = "prompts.vote.roleHint.werewolf" | "prompts.vote.roleHint.village" | "prompts.vote.roleHint.seer";
    const voteHintKeys: VoteHintKey[] = isWolfVoter
      ? ["prompts.vote.roleHint.werewolf"]
      : ["prompts.vote.roleHint.village"];
    if (player.role === "Seer") voteHintKeys.push("prompts.vote.roleHint.seer");
    const voteRoleHint = voteHintKeys.map((k) => t(k)).filter(Boolean).join("\n\n");
    const combinedRoleHints = [roleKnowHow, voteRoleHint].filter(Boolean).join("\n\n");

    const cacheableContent = t("prompts.vote.base", {
      seat: player.seat + 1,
      name: player.displayName,
      role: getRoleText(player.role),
      winCondition: getWinCondition(player.role),
      difficultyHint,
    });
    // 喵杀（十四轮）：把「已投出的实时票型」一并给尚未投票的 AI → 促成真实世界的「跟票/归票」，
    // 避免人人只按自己心思投、票型散开（站长反馈）。
    const tallyNote = buildVoteTallyNote(state);
    const infoGrading = t("prompts.vote.infoGrading");
    const decisionSteps = t("prompts.vote.decisionSteps");
    const dynamicContent = [decisionSteps, t("prompts.vote.task", {
      options: alivePlayers.map((p) => t("prompts.vote.option", { seat: p.seat + 1, name: p.displayName })).join(", "),
      roleHints: combinedRoleHints,
    }), tallyNote, infoGrading].filter(Boolean).join("\n\n");
    const systemParts: SystemPromptPart[] = [
      { text: cacheableContent, cacheable: true, ttl: "1h" },
      { text: dynamicContent },
    ];
    const system = buildSystemTextFromParts(systemParts);

    const lastReason = state.lastVoteReasons?.[player.playerId];
    const user = t("prompts.vote.user", {
      gameContext,
      todayTranscript: todayTranscript || t("prompts.vote.userNoTranscript"),
      selfSpeech: selfSpeech || t("prompts.vote.userNoSelfSpeech"),
      jsonFormat: JSON.stringify({ seat: 3, reason: "一句话投票依据" }),
    });

    return { system, user, systemParts };
  }

  async handleAction(_context: GameContext, _action: GameAction): Promise<void> {
    if (_action.type !== "RESOLVE_VOTES") return;
    const runtime = this.getRuntime(_context);
    if (!runtime) return;
    await this.resolveVotes(_context.state, runtime);
  }

  async onExit(_context: GameContext): Promise<void> {
    return;
  }

  private getRuntime(context: GameContext): VotePhaseRuntime | null {
    const raw = context.extras as VotePhaseRuntime | undefined;
    if (!raw) return null;
    if (!raw.setGameState || !raw.setDialogue || !raw.waitForUnpause || !raw.isTokenValid) return null;
    return raw;
  }

  private getVoteCounts(state: GameState): Record<number, number> {
    const counts: Record<number, number> = {};
    const sheriffSeat = state.badge.holderSeat;
    const sheriffPlayer =
      sheriffSeat !== null ? state.players.find((p) => p.seat === sheriffSeat && p.alive) : null;
    const sheriffPlayerId = sheriffPlayer?.playerId;
    const aliveById = new Set(state.players.filter((p) => p.alive).map((p) => p.playerId));
    const aliveBySeat = new Set(state.players.filter((p) => p.alive).map((p) => p.seat));

    // 已翻牌白痴的票是否计入，由房规决定（标准＝不计入）
    const revealedIdiotId = state.roleAbilities.idiotRevealed && effectiveRules(state.houseRules).idiotRevealedLosesVote
      ? state.players.find((p) => p.role === "Idiot" && p.alive)?.playerId
      : undefined;

    for (const [voterId, targetSeat] of Object.entries(state.votes)) {
      if (!aliveById.has(voterId)) continue;
      if (!aliveBySeat.has(targetSeat)) continue;
      if (voterId === revealedIdiotId) continue; // Idiot's vote doesn't count
      const weight = voterId === sheriffPlayerId ? effectiveRules(state.houseRules).sheriffVoteWeight : 1;
      counts[targetSeat] = (counts[targetSeat] || 0) + weight;
    }
    return counts;
  }

  private generateVoteDetails(
    votes: Record<string, number>,
    players: Player[],
    title: string,
    sheriffSeat: number | null,
    sheriffWeight: number
  ): string {
    const { t } = getI18n();
    const sheriffPlayer =
      sheriffSeat !== null ? players.find((p) => p.seat === sheriffSeat && p.alive) : null;
    const sheriffPlayerId = sheriffPlayer?.playerId;
    const aliveById = new Set(players.filter((p) => p.alive).map((p) => p.playerId));
    const aliveBySeat = new Set(players.filter((p) => p.alive).map((p) => p.seat));

    const voteGroups: Record<number, number[]> = {};
    Object.entries(votes).forEach(([playerId, targetSeat]) => {
      if (!aliveById.has(playerId)) return;
      if (!aliveBySeat.has(targetSeat)) return;
      const voter = players.find((p) => p.playerId === playerId);
      if (voter) {
        if (!voteGroups[targetSeat]) voteGroups[targetSeat] = [];
        voteGroups[targetSeat].push(voter.seat);
      }
    });

    const voteResults = Object.entries(voteGroups)
      .map(([targetSeat, voterSeats]) => {
        const target = players.find((p) => p.seat === Number(targetSeat));
        let voteCount = 0;
        voterSeats.forEach((voterSeat) => {
          const voter = players.find((p) => p.seat === voterSeat);
          if (voter) {
            voteCount += voter.playerId === sheriffPlayerId ? sheriffWeight : 1;
          }
        });
        return {
          targetSeat: Number(targetSeat),
          targetName: target?.displayName || t("devConsole.unknown"),
          voterSeats,
          voteCount,
        };
      })
      .sort((a, b) => b.voteCount - a.voteCount);

    return `[VOTE_RESULT]${JSON.stringify({ title, results: voteResults })}`;
  }

  private async resolveVotes(state: GameState, runtime: VotePhaseRuntime): Promise<void> {
    const { t } = getI18n();
    const uiText = getUiText();
    const systemMessages = getSystemMessages();
    const speakerHost = t("speakers.host");
    const speakerHint = t("speakers.hint");

    let currentState = transitionPhase(state, "DAY_RESOLVE");

    const currentVotes = { ...state.votes };
    const newHistory = { ...state.voteHistory, [state.day]: currentVotes };
    currentState = { ...currentState, voteHistory: newHistory };

    runtime.setGameState(currentState);
    await runtime.waitForUnpause();

    const result = tallyVotes(currentState);

    const prevDayRecord = (currentState.dayHistory || {})[currentState.day] || {};
    if (result) {
      currentState = {
        ...currentState,
        dayHistory: {
          ...(currentState.dayHistory || {}),
          [currentState.day]: { ...prevDayRecord, executed: { seat: result.seat, votes: result.count }, voteTie: false },
        },
      };
    } else {
      currentState = {
        ...currentState,
        dayHistory: {
          ...(currentState.dayHistory || {}),
          [currentState.day]: { ...prevDayRecord, executed: undefined, voteTie: true },
        },
      };
    }

    runtime.setGameState(currentState);

    const voteDetailMessage = this.generateVoteDetails(
      currentVotes,
      currentState.players,
      t("votePhase.voteDetailTitle"),
      currentState.badge.holderSeat,
      effectiveRules(currentState.houseRules).sheriffVoteWeight
    );
    currentState = addSystemMessage(currentState, voteDetailMessage);
    // 喵杀修复：先让「谁上票给谁」的票型单独呈现、等玩家点继续，再揭晓谁被投出去。
    // 原实现只把票型消息塞进 state 却没 setGameState，紧接着又追加处决消息，
    // 界面一次性收到两条 → 玩家只看到「X号出局」，票型一闪而过甚至根本没看到。
    runtime.setGameState(currentState);
    // 喵杀修复（2026-10-30 · 玩家实测「投票后卡在最后一句、看不到出局」）：
    // 暂停前必须把对话框换成明确的「票型已出，点击继续」，否则界面仍挂着上一句发言，
    // 看起来像卡住；同时这里的对话块也是玩家点「继续」的唯一落点。
    runtime.setDialogue(speakerHost, uiText.voteReviewPrompt, false);
    if (runtime.pauseForReview) {
      await runtime.pauseForReview(currentState);
    }

    if (result) {
      const executed = currentState.players.find((p) => p.seat === result.seat);

      // 喵杀修复：白痴**翻牌之后**不应再被放逐。原实现只判断 `!idiotRevealed`，
      // 于是「翻牌后的下一轮又被票出」会落到下面的正常处决分支 → 白痴被票死，
      // 与「白痴免疫放逐」的规则（以及资料弹窗里的说明）矛盾。
      if (executed?.role === "Idiot" && currentState.roleAbilities.idiotRevealed) {
        const immuneMsg = t("system.idiotImmune", { seat: result.seat + 1, name: executed.displayName });
        currentState = addSystemMessage(currentState, immuneMsg);
        runtime.setDialogue(speakerHost, immuneMsg, false);
        currentState = { ...currentState, pkTargets: undefined, pkSource: undefined };
        runtime.setGameState(currentState);

        const winnerAfterImmune = checkWinCondition(currentState);
        if (winnerAfterImmune) {
          await runtime.onGameEnd(currentState, winnerAfterImmune);
          return;
        }
        await runtime.onVoteComplete(currentState, null);
        return;
      }

      // --- Idiot immunity: if the executed player is Idiot and hasn't revealed yet ---
      if (executed?.role === "Idiot" && !currentState.roleAbilities.idiotRevealed) {
        const idiotMsg = t("system.idiotRevealed", { seat: result.seat + 1, name: executed.displayName });
        currentState = addSystemMessage(currentState, idiotMsg);
        const prevDayRec = currentState.dayHistory?.[currentState.day] || {};
        currentState = {
          ...currentState,
          roleAbilities: { ...currentState.roleAbilities, idiotRevealed: true },
          dayHistory: {
            ...(currentState.dayHistory || {}),
            [currentState.day]: { ...prevDayRec, idiotRevealed: { seat: result.seat } },
          },
          pkTargets: undefined,
          pkSource: undefined,
        };
        runtime.setDialogue(speakerHost, idiotMsg, false);
        runtime.setGameState(currentState);

        // Skip execution — Idiot stays alive but loses voting rights
        const winner = checkWinCondition(currentState);
        if (winner) {
          await runtime.onGameEnd(currentState, winner);
          return;
        }

        // 喵杀修复：白痴翻牌后**不再处决**（他只是失去投票权），所以这里必须传 null。
        // 若照原样把 result 传下去，handleVoteComplete 会走「遗言阶段」，
        // 而 startLastWordsPhase 里 `speaker.alive ? killPlayer(...)` 会把还活着的白痴又杀掉，
        // 免疫与「失去投票权」双双失效。传 null = 走「无出局」分支（延迟后进入夜晚），白痴存活。
        await runtime.onVoteComplete(currentState, null);
        return;
      }

      currentState = addSystemMessage(
        currentState,
        systemMessages.playerExecuted(result.seat + 1, executed?.displayName || "", result.count)
      );
      runtime.setDialogue(
        speakerHost,
        systemMessages.playerExecuted(result.seat + 1, executed?.displayName || "", result.count),
        false
      );

      const diedKey = getPlayerDiedKey(result.seat);
      if (diedKey) await playNarrator(diedKey);

      currentState = {
        ...currentState,
        pkTargets: undefined,
        pkSource: undefined,
      };
    } else {
      const voteCounts = this.getVoteCounts(currentState);
      const maxVotes = Math.max(0, ...Object.values(voteCounts));
      const topSeats = Object.entries(voteCounts)
        .filter(([, c]) => c === maxVotes)
        .map(([s]) => Number(s));

      if (topSeats.length > 1 && currentState.pkSource !== "vote") {
        const pkState = {
          ...currentState,
          pkTargets: topSeats,
          pkSource: "vote" as const,
        };
        let nextState = transitionPhase(pkState, "DAY_PK_SPEECH");
        const firstSeat = topSeats[0] ?? null;
        nextState = {
          ...nextState,
          currentSpeakerSeat: firstSeat,
          daySpeechStartSeat: firstSeat,
        };
        nextState = addSystemMessage(nextState, t("votePhase.tiePk"));
        runtime.setGameState(nextState);
        runtime.setDialogue(speakerHost, t("votePhase.tiePk"), false);

        await delay(DELAY_CONFIG.DIALOGUE);
        await runtime.waitForUnpause();

        const firstSpeaker = nextState.players.find((p) => p.seat === firstSeat);
        if (firstSpeaker && !firstSpeaker.isHuman) {
          await runtime.runAISpeech(nextState, firstSpeaker);
        } else if (firstSpeaker?.isHuman) {
          runtime.setDialogue(speakerHint, uiText.yourTurn, false);
        }
        return;
      }

      currentState = {
        ...currentState,
        pkTargets: undefined,
        pkSource: undefined,
      };
      currentState = addSystemMessage(currentState, systemMessages.voteTie);
      runtime.setDialogue(speakerHost, systemMessages.voteTie, false);
    }

    runtime.setGameState(currentState);

    const executed =
      result ? currentState.players.find((p) => p.seat === result.seat) : null;
    if (result && executed?.role === "Hunter" && currentState.roleAbilities.hunterCanShoot) {
      // Defer win check until after hunter shoot resolves.
      await runtime.onVoteComplete(currentState, result);
      return;
    }

    const winner = checkWinCondition(currentState);
    if (winner) {
      await runtime.onGameEnd(currentState, winner);
      return;
    }

    await runtime.onVoteComplete(currentState, result);
  }
}
