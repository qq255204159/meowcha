import { v4 as uuidv4 } from "uuid";
import { generateCompletion, generateCompletionBatch, generateCompletionStream, mergeOptionsFromModelRef, stripMarkdownCodeFences, stripReasoningArtifacts, type GenerateOptions, type LLMMessage } from "./llm";
import type { ChatCompletionResponse } from "./llm";
import { parseLLMJson } from "./llm-json";
import { StreamingSpeechParser } from "./streaming-speech-parser";
import {
  type GameState,
  type Player,
  type Role,
  type Phase,
  type ChatMessage,
  type Alignment,
  type DailySummaryFact,
  type DailySummaryVoteData,
  GENERATOR_MODEL,
  SUMMARY_MODEL,
  PLAYER_MODELS,
  type ModelRef,
} from "@/types/game";
import { GAME_TEMPERATURE, AI_TEMPERATURE } from "./ai-config";
import { sampleModelRefs, type GeneratedCharacter } from "./character-generator";
import { aiLogger } from "./ai-logger";
import { getGeneratorModel, getSummaryModel } from "@/lib/api-keys";
import { PhaseManager } from "@/game/core/PhaseManager";
import type { PromptResult } from "@/game/core/types";
import { buildCachedSystemMessageFromParts } from "./prompt-utils";
import { effectiveRules } from "@/lib/house-rules";
import { getI18n } from "@/i18n/translator";

type ParseAttempt<T> = { ok: true; value: T } | { ok: false };

type ParsedCompletion<T> = {
  result: { content: string; raw: ChatCompletionResponse };
  cleaned: string;
  parsed: T | null;
  attempts: number;
};

function parseOk<T>(value: T): ParseAttempt<T> {
  return { ok: true, value };
}

function parseFail(): ParseAttempt<never> {
  return { ok: false };
}

async function generateCompletionWithParseRetry<T>(
  options: GenerateOptions,
  parse: (cleaned: string) => ParseAttempt<T>,
  retryInstruction: string
): Promise<ParsedCompletion<T>> {
  let messages = options.messages;
  let last: ParsedCompletion<T> | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await generateCompletion({ ...options, messages });
    const cleaned = stripMarkdownCodeFences(result.content).trim();
    const parsed = parse(cleaned);

    last = {
      result,
      cleaned,
      parsed: parsed.ok ? parsed.value : null,
      attempts: attempt,
    };

    if (parsed.ok) return last;

    messages = [
      ...options.messages,
      { role: "assistant", content: result.content.slice(0, 4000) },
      { role: "user", content: retryInstruction },
    ];
  }

  if (!last) throw new Error("No LLM completion attempts were made");
  return last;
}

function jsonRetryInstruction(formatHint: string): string {
  return `上一轮输出无法按预期 JSON 结构解析。The previous output did not match the expected JSON schema. 请严格只返回 JSON / Return JSON only, no markdown, no explanation, no extra text. 预期结构 / Expected shape: ${formatHint}`;
}

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

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

const phaseManager = new PhaseManager();

function sanitizeModelArtifacts(text: string): string {
  const raw = String(text ?? "");
  if (!raw) return raw;

  return raw
    .replace(/<\|begin▁of▁sentence\|>/g, "")
    .replace(/<\|end▁of▁sentence\|>/g, "")
    .replace(/<｜begin▁of▁sentence｜>/g, "")
    .replace(/<｜end▁of▁sentence｜>/g, "")
    .trim();
}

function sanitizeSeatMentions(text: string, players: Player[]): string {
  if (!text) return text;
  const totalSeats = players.length;
  if (!Number.isFinite(totalSeats) || totalSeats <= 0) return text;
  const { t } = getI18n();

  const formatSeatWithName = (
    raw: string,
    numStr: string,
    prefix: string,
    offset: number,
    fullText: string
  ) => {
    const n = Number.parseInt(numStr, 10);
    if (!Number.isFinite(n)) return raw;
    if (n < 1 || n > totalSeats) return t("gameMaster.invalidSeat");
    if (!prefix && fullText[offset - 1] === "@") return raw;
    const player = players.find((p) => p.seat === n - 1);
    if (!player?.displayName) return raw;
    const after = fullText.slice(offset + raw.length);
    const afterTrimmed = after.replace(/^\s+/, "");
    if (afterTrimmed.startsWith(player.displayName)) return raw;
    const label = t("mentions.playerLabel", { seat: n, name: player.displayName });
    return `${prefix}${label}`;
  };

  // Handle @12 / @12号
  let out = text.replace(/@(\d+)\s*号?/g, (m, numStr, offset, fullText) =>
    formatSeatWithName(m, numStr, "@", offset as number, fullText)
  );
  // Handle 12号
  out = out.replace(/(\d+)\s*号/g, (m, numStr, offset, fullText) =>
    formatSeatWithName(m, numStr, "", offset as number, fullText)
  );
  return out;
}

function resolvePhasePrompt(
  phase: Phase,
  state: GameState,
  player: Player,
  extras?: Record<string, unknown>
) {
  // Override state.phase to ensure correct prompt is returned
  // This is needed when calling prompts for a phase different from state.phase
  const overriddenState = state.phase === phase ? state : { ...state, phase };
  const prompt = phaseManager.getPrompt(phase, { state: overriddenState, extras }, player);
  if (!prompt) {
    throw new Error(`[meowcha] Missing phase prompt for ${phase}`);
  }
  return prompt;
}

function buildMessagesForPrompt(
  prompt: PromptResult,
  useCache: boolean = true
): { messages: LLMMessage[]; systemMessage: LLMMessage } {
  const systemMessage = buildCachedSystemMessageFromParts(
    prompt.systemParts,
    prompt.system,
    useCache
  );

  return {
    systemMessage,
    messages: [
      systemMessage,
      { role: "user", content: prompt.user },
    ],
  };
}

export function createInitialGameState(): GameState {
  return {
    gameId: uuidv4(),
    phase: "LOBBY",
    day: 0,
    difficulty: "normal",
    players: [],
    events: [],
    messages: [],
    currentSpeakerSeat: null,
    nextSpeakerSeatOverride: null,
    daySpeechStartSeat: null,
    speechDirection: "clockwise",
    pkTargets: undefined,
    pkSource: undefined,
    badge: {
      holderSeat: null,
      candidates: [],
      signup: {},
      votes: {},
      history: {},
      revoteCount: 0,
    },
    votes: {},
    voteReasons: {},
    lastVoteReasons: {},
    voteHistory: {},
    dailySummaries: {},
    dailySummaryFacts: {},
    dailySummaryVoteData: {},
    nightActions: {},
    roleAbilities: {
      witchHealUsed: false,
      witchPoisonUsed: false,
      hunterCanShoot: true,
      idiotRevealed: false,
      whiteWolfKingBoomUsed: false,
    },
    winner: null,
  };
}

/**
 * 各人数局的标准配比（站长 2026-10-17 指定 · 只保留 4 档；默认 12 人）。
 *  - 6 人（快餐局）：2 狼 + 预言家·女巫 + 2 民
 *  - 8 人（经典入门）：2 狼 + 预言家·女巫·猎人 + 3 民
 *  - 10 人（速推局）：3 狼 + 预言家·女巫·猎人·白痴 + 3 民
 *  - 12 人（标准经典）：4 狼（含白狼王）+ 预言家·女巫·猎人·守卫 + 4 民
 * 说明：白痴按「神职」计入，但在自定义校验里与村民同组（见 WelcomeScreen）。
 */
export const ROLE_COMPOSITIONS: Record<number, Role[]> = {
  6: ["Werewolf", "Werewolf", "Seer", "Witch", "Villager", "Villager"],
  8: ["Werewolf", "Werewolf", "Seer", "Witch", "Hunter", "Villager", "Villager", "Villager"],
  10: ["Werewolf", "Werewolf", "Werewolf", "Seer", "Witch", "Hunter", "Idiot", "Villager", "Villager", "Villager"],
  12: ["Werewolf", "Werewolf", "Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Villager", "Villager", "Villager", "Villager"],
};

/** 可选人数（仅这 4 档）与默认人数 */
export const SUPPORTED_PLAYER_COUNTS: number[] = [6, 8, 10, 12];
export const DEFAULT_PLAYER_COUNT = 12;

export function getRoleConfiguration(playerCount: number): Role[] {
  const roles = ROLE_COMPOSITIONS[playerCount] ?? ROLE_COMPOSITIONS[DEFAULT_PLAYER_COUNT];
  return roles.slice();
}

export function setupPlayers(
  characters: GeneratedCharacter[],
  humanSeat: number = 0,
  humanName: string = "",
  playerCount: number = 12,
  fixedRoles?: Role[],
  seedPlayerIds?: string[],
  modelRefs?: ModelRef[],
  aiSeatOrder?: number[],
  preferredRole?: Role
): Player[] {
  const { t } = getI18n();
  const totalPlayers = playerCount;
  const fallbackHumanName = t("common.you");
  const roles = getRoleConfiguration(totalPlayers);
  const assignedRoles = fixedRoles && fixedRoles.length === totalPlayers ? fixedRoles : shuffleArray(roles);

  // If the user chose a preferred role (and no dev fixedRoles), swap to ensure the human gets it
  if (
    preferredRole &&
    !(fixedRoles && fixedRoles.length === totalPlayers) &&
    humanSeat >= 0
  ) {
    const currentRoleAtHumanSeat = assignedRoles[humanSeat];
    if (currentRoleAtHumanSeat !== preferredRole) {
      const targetIndex = assignedRoles.findIndex(
        (r, i) => r === preferredRole && i !== humanSeat
      );
      if (targetIndex !== -1) {
        assignedRoles[targetIndex] = currentRoleAtHumanSeat;
        assignedRoles[humanSeat] = preferredRole;
      }
    }
  }

  const players: Player[] = [];

  const computeCharIndexForSeat = (() => {
    const aiSeats = Array.from({ length: totalPlayers }, (_, seat) => seat).filter(
      (seat) => seat !== humanSeat
    );

    if (
      Array.isArray(aiSeatOrder) &&
      aiSeatOrder.length === aiSeats.length &&
      new Set(aiSeatOrder).size === aiSeats.length &&
      aiSeatOrder.every((s) => aiSeats.includes(s))
    ) {
      const seatToCharIndex = new Map<number, number>();
      aiSeatOrder.forEach((seat, idx) => seatToCharIndex.set(seat, idx));
      return (seat: number) => seatToCharIndex.get(seat) ?? -1;
    }

    return (seat: number) => (seat > humanSeat ? seat - 1 : seat);
  })();

  const getPlayerIdForSeat = (seat: number) => {
    const id = Array.isArray(seedPlayerIds) ? seedPlayerIds[seat] : undefined;
    return typeof id === "string" && id.trim() ? id : uuidv4();
  };

  for (let seat = 0; seat < totalPlayers; seat++) {
    const role = assignedRoles[seat];
    const alignment: Alignment = (role === "Werewolf" || role === "WhiteWolfKing") ? "wolf" : "village";
    const playerId = getPlayerIdForSeat(seat);

    if (seat === humanSeat) {
      players.push({
        playerId,
        seat,
        displayName: humanName.trim() || fallbackHumanName,
        avatarSeed: playerId,
        alive: true,
        role,
        alignment,
        isHuman: true,
      });
    } else {
      const charIndex = computeCharIndexForSeat(seat);
      const fallbackIndex = seat > humanSeat ? seat - 1 : seat;
      const safeCharIndex =
        Number.isFinite(charIndex) && charIndex >= 0 && charIndex < characters.length
          ? charIndex
          : Math.min(Math.max(0, fallbackIndex), Math.max(0, characters.length - 1));
      const character = characters[safeCharIndex];
      const modelRef = modelRefs?.[safeCharIndex] ?? getRandomModelRef();

      players.push({
        playerId,
        seat,
        displayName: character.displayName,
        avatarSeed: character.avatarSeed ?? playerId,
        alive: true,
        role,
        alignment,
        isHuman: false,
        agentProfile: {
          modelRef,
          persona: character.persona,
        },
      });
    }
  }

  return players;
}

export function addSystemMessage(
  state: GameState,
  content: string
): GameState {
  const { t } = getI18n();
  const message: ChatMessage = {
    id: uuidv4(),
    playerId: "system",
    playerName: t("speakers.host"),
    content,
    timestamp: Date.now(),
    day: state.day,
    phase: state.phase,
    isSystem: true,
  };

  return {
    ...state,
    messages: [...state.messages, message],
  };
}

export function addPlayerMessage(
  state: GameState,
  playerId: string,
  content: string,
  options?: { isLastWords?: boolean }
): GameState {
  const player = state.players.find((p) => p.playerId === playerId);
  if (!player) return state;

  const trimmedContent = content.trim();
  if (trimmedContent.length === 0) return state;

  // Auto-detect last words phase or use explicit flag
  const isLastWords = options?.isLastWords ?? state.phase === "DAY_LAST_WORDS";

  // Deduplication: prevent adding identical message from same player in same day/phase
  // Check recent messages (last 20) to avoid O(n) scan on large message arrays
  const recentMessages = state.messages.slice(-20);
  const isDuplicate = recentMessages.some(
    (m) =>
      m.playerId === playerId &&
      m.day === state.day &&
      m.phase === state.phase &&
      m.content === trimmedContent &&
      (isLastWords ? m.isLastWords === true : !m.isLastWords)
  );
  if (isDuplicate) {
    console.warn("[meowcha] addPlayerMessage: duplicate message blocked", {
      playerId,
      day: state.day,
      phase: state.phase,
      contentPreview: trimmedContent.slice(0, 50),
    });
    return state;
  }

  const message: ChatMessage = {
    id: uuidv4(),
    playerId,
    playerName: player.displayName,
    content: trimmedContent,
    timestamp: Date.now(),
    day: state.day,
    phase: state.phase,
    ...(isLastWords && { isLastWords: true }),
  };

  return {
    ...state,
    messages: [...state.messages, message],
  };
}

export function transitionPhase(state: GameState, newPhase: Phase): GameState {
  // Clear currentSpeakerSeat when transitioning to night phases
  const isNightPhase = newPhase.startsWith("NIGHT_");
  const shouldClearSpeaker = isNightPhase || newPhase === "DAY_VOTE" || newPhase === "DAY_RESOLVE";
  
  return {
    ...state,
    phase: newPhase,
    ...(shouldClearSpeaker && { currentSpeakerSeat: null }),
  };
}

export function checkWinCondition(state: GameState): Alignment | null {
  const alivePlayers = state.players.filter((p) => p.alive);
  const aliveWolves = alivePlayers.filter((p) => p.alignment === "wolf");
  const aliveVillagers = alivePlayers.filter((p) => p.alignment === "village");

  if (aliveWolves.length === 0) {
    return "village";
  }

  if (aliveWolves.length >= aliveVillagers.length) {
    return "wolf";
  }

  // 房规「屠边」：神职（预言家/女巫/猎人/守卫/白痴）全灭 或 村民全灭，狼人即胜。
  // 标准「屠城」时此处不生效，逻辑与旧版完全一致。
  if (effectiveRules(state.houseRules).winCondition === "side") {
    const godRoles: Role[] = ["Seer", "Witch", "Hunter", "Guard", "Idiot"];
    const hasAliveGod = alivePlayers.some((p) => godRoles.includes(p.role));
    const hasAliveVillager = alivePlayers.some((p) => p.role === "Villager");
    if (!hasAliveGod || !hasAliveVillager) {
      return "wolf";
    }
  }

  return null;
}

export function killPlayer(state: GameState, seat: number): GameState {
  return {
    ...state,
    players: state.players.map((p) =>
      p.seat === seat ? { ...p, alive: false } : p
    ),
  };
}

export function getNextAliveSeat(
  state: GameState,
  currentSeat: number,
  excludeSheriff = false,
  direction: "clockwise" | "counterclockwise" = "clockwise"
): number | null {
  const sheriffSeat = state.badge.holderSeat;
  let alivePlayers = state.players.filter((p) => p.alive);
  
  // 如果需要排除警长（警长最后发言），则从候选列表中移除警长
  if (excludeSheriff && sheriffSeat !== null) {
    alivePlayers = alivePlayers.filter((p) => p.seat !== sheriffSeat);
  }
  
  if (alivePlayers.length === 0) return null;

  const sortedSeats = alivePlayers.map((p) => p.seat).sort((a, b) => a - b);
  if (sortedSeats.length === 0) return null;

  if (direction === "counterclockwise") {
    const prevSeat = [...sortedSeats].reverse().find((s) => s < currentSeat);
    return prevSeat ?? sortedSeats[sortedSeats.length - 1];
  }

  const nextSeat = sortedSeats.find((s) => s > currentSeat);
  return nextSeat ?? sortedSeats[0];
}

/**
 * 计算完整的发言顺序列表
 * @param state 游戏状态
 * @param startSeat 起始座位号（从该座位开始发言）
 * @param sheriffLast 警长是否最后发言（默认 true）
 * @returns 按发言顺序排列的座位号数组
 */
export function getSpeakingOrder(
  state: GameState,
  startSeat: number,
  sheriffLast = true
): number[] {
  const sheriffSeat = state.badge.holderSeat;
  const alivePlayers = state.players.filter((p) => p.alive);
  const aliveSeats = alivePlayers.map((p) => p.seat).sort((a, b) => a - b);
  
  if (aliveSeats.length === 0) return [];
  
  // 找到起始座位在排序列表中的索引
  let startIndex = aliveSeats.indexOf(startSeat);
  if (startIndex === -1) {
    // 起始座位已出局/无效时，从它之后最近的存活座位开始；
    // 不能直接返回 aliveSeats，否则会绕过「警长最后发言」的规则。
    const fallbackSeat = getNextAliveSeat(state, startSeat, false, "clockwise") ?? aliveSeats[0];
    startIndex = aliveSeats.indexOf(fallbackSeat);
  }
  if (startIndex === -1) startIndex = 0;
  
  // 从起始座位开始，按顺时针顺序排列
  const order: number[] = [];
  for (let i = 0; i < aliveSeats.length; i++) {
    const seat = aliveSeats[(startIndex + i) % aliveSeats.length];
    // 如果警长最后发言，先跳过警长
    if (sheriffLast && seat === sheriffSeat) continue;
    order.push(seat);
  }
  
  // 如果警长最后发言且警长存活，将警长添加到最后
  if (sheriffLast && sheriffSeat !== null && aliveSeats.includes(sheriffSeat)) {
    order.push(sheriffSeat);
  }
  
  return order;
}

/** 当天 DAY_SPEECH 阶段已经留下发言记录（非系统消息）的座位 */
export function getTodaySpokenSeats(state: GameState): Set<number> {
  const spokenSeats = new Set<number>();
  for (const m of state.messages) {
    if (m.isSystem) continue;
    if (m.day !== state.day) continue;
    if (m.phase !== "DAY_SPEECH") continue;
    if (!m.playerId) continue;
    const player = state.players.find((p) => p.playerId === m.playerId);
    if (player) spokenSeats.add(player.seat);
  }
  return spokenSeats;
}

/**
 * 白天讨论的下一位发言者（权威顺序）。
 * 规则：从 daySpeechStartSeat 起顺时针，跳过已出局/已发言者，存活警长最后归票。
 * 返回 null = 本日讨论结束，应进入投票。
 */
export function getNextDaySpeechSeat(state: GameState): number | null {
  const sheriffSeat = state.badge.holderSeat;
  const isSheriffAlive =
    typeof sheriffSeat === "number" &&
    state.players.some((p) => p.seat === sheriffSeat && p.alive);
  const spokenSeats = getTodaySpokenSeats(state);
  const startSeat = state.daySpeechStartSeat ?? state.currentSpeakerSeat ?? -1;
  const order = getSpeakingOrder(state, startSeat, isSheriffAlive);
  const currentIndex =
    state.currentSpeakerSeat !== null ? order.indexOf(state.currentSpeakerSeat) : -1;

  for (let i = currentIndex + 1; i < order.length; i++) {
    if (!spokenSeats.has(order[i])) return order[i];
  }

  // 当前发言者没有留下消息（例如人类直接点了「结束发言」）时，
  // 仍然可以找其他还没说的人；但不能把当前座位再次排回来，否则会原地循环。
  return (
    order.find(
      (seat) => seat !== state.currentSpeakerSeat && !spokenSeats.has(seat)
    ) ?? null
  );
}

/**
 * 警长竞选发言的下一位候选人。
 * 候选人按座位号排序，最后一位之后返回 null —— 不能取模绕回第一位，
 * 否则竞选会无限循环（站长实测：几个候选人反复对话）。
 */
export function getNextBadgeCandidateSeat(state: GameState): number | null {
  const candidates = Array.isArray(state.badge?.candidates) ? state.badge.candidates : [];
  const aliveCandidates = Array.from(new Set(candidates))
    .filter((seat) => state.players.some((p) => p.seat === seat && p.alive))
    .sort((a, b) => a - b);
  if (aliveCandidates.length === 0) return null;

  const currentIndex = aliveCandidates.indexOf(state.currentSpeakerSeat ?? -1);
  if (currentIndex === -1) return aliveCandidates[0];
  return aliveCandidates[currentIndex + 1] ?? null;
}

/**
 * 本阶段真正需要投票的玩家 ID。
 * 排除：已出局、PK 目标、已翻牌且按房规失去投票权的白痴。
 */
export function getEligibleVoterIds(state: GameState): string[] {
  const pkTargets =
    state.pkSource === "vote" && Array.isArray(state.pkTargets)
      ? new Set(state.pkTargets)
      : new Set<number>();
  const revealedIdiotId =
    state.roleAbilities.idiotRevealed && effectiveRules(state.houseRules).idiotRevealedLosesVote
      ? state.players.find((p) => p.role === "Idiot" && p.alive)?.playerId
      : undefined;

  return state.players
    .filter(
      (p) =>
        p.alive &&
        !pkTargets.has(p.seat) &&
        p.playerId !== revealedIdiotId
    )
    .map((p) => p.playerId);
}

/**
 * 计算发言起始座位
 * @param state 游戏状态
 * @param options.deadSeat 死者座位（用于确定从死者下一位开始）
 * @param options.hasSheriff 是否有存活警长（默认自动检测）
 * @returns 起始座位号
 */
export function resolveSpeechStartSeat(
  state: GameState,
  options?: { deadSeat?: number; hasSheriff?: boolean }
): number | null {
  const alivePlayers = state.players.filter((p) => p.alive);
  const aliveSeats = alivePlayers.map((p) => p.seat).sort((a, b) => a - b);
  
  if (aliveSeats.length === 0) return null;
  
  const sheriffSeat = state.badge.holderSeat;
  const isSheriffAlive = options?.hasSheriff ?? 
    (sheriffSeat !== null && aliveSeats.includes(sheriffSeat));
  
  // 场上存在警长：从警长下一位开始
  if (isSheriffAlive && sheriffSeat !== null) {
    return getNextAliveSeat(state, sheriffSeat, true, "clockwise");
  }
  
  // 无警长但有死者：从死者下一位开始
  if (options?.deadSeat !== undefined) {
    return getNextAliveSeat(state, options.deadSeat, false, "clockwise");
  }
  
  // 默认：从最小座位号开始
  return aliveSeats[0];
}

export function tallyVotes(state: GameState): { seat: number; count: number } | null {
  const voteCounts: Record<number, number> = {};
  const sheriffSeat = state.badge.holderSeat;
  const aliveById = new Set(state.players.filter((p) => p.alive).map((p) => p.playerId));
  const aliveBySeat = new Set(state.players.filter((p) => p.alive).map((p) => p.seat));
  
  // 找到警长的 playerId
  const sheriffPlayer = sheriffSeat !== null 
    ? state.players.find((p) => p.seat === sheriffSeat && p.alive)
    : null;
  const sheriffPlayerId = sheriffPlayer?.playerId;

  // 喵杀修复：与 VotePhase.getVoteCounts / game-machine（DAY_VOTE 完成判定）保持同一口径 ——
  // 已翻牌、且按房规「失去投票权」的白痴，其票不算数（原实现漏了这条，会出现「展示票数」与「结算票数」不一致）
  const revealedIdiotId =
    state.roleAbilities.idiotRevealed && effectiveRules(state.houseRules).idiotRevealedLosesVote
      ? state.players.find((p) => p.role === "Idiot" && p.alive)?.playerId
      : undefined;
  
  for (const [voterId, targetSeat] of Object.entries(state.votes)) {
    if (!aliveById.has(voterId)) continue;
    if (!aliveBySeat.has(targetSeat)) continue;
    if (voterId === revealedIdiotId) continue; // 翻牌白痴（按房规失去投票权）的票不计入
    // 警长的票权由房规决定（标准为1.5票）
    const voteWeight = voterId === sheriffPlayerId ? effectiveRules(state.houseRules).sheriffVoteWeight : 1;
    voteCounts[targetSeat] = (voteCounts[targetSeat] || 0) + voteWeight;
  }

  let maxVotes = 0;
  let maxSeat: number | null = null;

  for (const [seat, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) {
      maxVotes = count;
      maxSeat = parseInt(seat);
    }
  }

  // 平票判定：如果最高票并列，则无人被放逐
  if (maxVotes > 0) {
    const topSeats = Object.entries(voteCounts)
      .filter(([, c]) => c === maxVotes)
      .map(([s]) => parseInt(s));
    if (topSeats.length !== 1) return null;
  }

  if (maxSeat === null) return null;
  return { seat: maxSeat, count: maxVotes };
}

/** Extract structured vote_data from [VOTE_RESULT] in day messages. Preserves "who voted for whom" so it is not lost when context is trimmed. */
function extractVoteDataFromDayMessages(
  dayMessages: ChatMessage[],
  state: GameState
): DailySummaryVoteData | undefined {
  const { t } = getI18n();
  const badgeVoteTitle = t("badgePhase.voteDetailTitle");
  const dayVoteTitle = t("votePhase.voteDetailTitle");
  let sheriff: { winner: number; votes: Record<string, number[]> } | undefined;
  let execution: { eliminated: number; votes: Record<string, number[]> } | undefined;

  for (const m of dayMessages) {
    if (!m.isSystem || !m.content.startsWith("[VOTE_RESULT]")) continue;
    try {
      const json = m.content.slice("[VOTE_RESULT]".length);
      const data = JSON.parse(json) as { title?: string; results?: Array<{ targetSeat: number; voterSeats?: number[] }> };
      const results = data.results ?? [];
      const votes: Record<string, number[]> = {};
      for (const r of results) {
        const k = String(r.targetSeat);
        votes[k] = Array.isArray(r.voterSeats) ? r.voterSeats : [];
      }
      if (data.title === badgeVoteTitle && Object.keys(votes).length > 0) {
        const winner = state.badge.holderSeat ?? -1;
        sheriff = { winner, votes };
      } else if (data.title === dayVoteTitle && Object.keys(votes).length > 0) {
        const eliminated = state.dayHistory?.[state.day]?.executed?.seat ?? -1;
        execution = { eliminated, votes };
      }
    } catch {
      // skip malformed [VOTE_RESULT]
    }
  }

  if (!sheriff && !execution) return undefined;
  const out: DailySummaryVoteData = {};
  if (sheriff != null && sheriff.winner >= 0) out.sheriff_election = sheriff;
  if (execution != null && execution.eliminated >= 0) out.execution_vote = execution;
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function generateDailySummary(
  state: GameState
): Promise<{ bullets: string[]; facts: DailySummaryFact[]; voteData?: DailySummaryVoteData }> {
  const { t } = getI18n();
  const startTime = Date.now();
  const summaryModel = getSummaryModel();
  const dayBreakShort = t("system.dayBreakShort");
  const systemSpeaker = t("speakers.system");

  const dayStartIndex = (() => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.isSystem && m.content === dayBreakShort) return i;
    }
    return 0;
  })();

  const dayMessages = state.messages.slice(dayStartIndex);
  const voteData = extractVoteDataFromDayMessages(dayMessages, state);

  const transcript = dayMessages
    .map((m) => {
      if (m.isSystem) return `${systemSpeaker}: ${m.content}`;
      const player = state.players.find((p) => p.playerId === m.playerId);
      const seatLabel = player ? t("mentions.seatLabel", { seat: player.seat + 1 }) : "";
      const nameLabel = player?.displayName || m.playerName;
      const speaker = seatLabel ? `${seatLabel} ${nameLabel}`.trim() : nameLabel;
      return `${speaker}: ${m.content}`;
    })
    .join("\n")
    .slice(0, 15000);

  const system = t("gameMaster.dailySummary.systemPrompt");
  const user = t("gameMaster.dailySummary.userPrompt", { day: state.day, transcript });

  const messages: LLMMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const result = await generateCompletion({
    model: summaryModel,
    messages,
    temperature: GAME_TEMPERATURE.SUMMARY,
    response_format: { type: "json_object" },
  });

  const cleanedDaily = stripMarkdownCodeFences(result.content);

  await aiLogger.log({
    type: "daily_summary",
    request: {
      model: summaryModel,
      messages,
    },
    response: {
      content: cleanedDaily,
      raw: result.content,
      rawResponse: JSON.stringify(result.raw, null, 2),
      finishReason: result.raw.choices?.[0]?.finish_reason,
      duration: Date.now() - startTime,
    },
  });

  // Parse the new { "summary": "..." } or { "bullets": [...] } format
  let summaryText = "";
  
  const obj = parseLLMJson<{ bullets?: unknown; summary?: unknown }>(cleanedDaily);
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    if (Array.isArray(obj.bullets) && obj.bullets.length > 0) {
      summaryText = obj.bullets.map(b => String(b)).join("\n");
    } else if (typeof obj.summary === "string" && obj.summary.trim()) {
      summaryText = obj.summary.trim();
    }
  }

  // If we got a summary, return it as a single bullet (preserving full text) and structured vote_data
  if (summaryText) {
    return { bullets: [summaryText], facts: [], voteData };
  }

  // Fallback: use raw content
  const fallback = result.content
    .replace(/```json\s*|\s*```/g, "")
    .replace(/^\s*\{[\s\S]*?"summary"\s*:\s*"/, "")
    .replace(/"\s*\}\s*$/, "")
    .trim();

  const fallbackBullets = fallback ? [fallback] : [result.content.trim()].filter(Boolean);
  return { bullets: fallbackBullets, facts: [], voteData };
}

export async function* generateAISpeechStream(
  state: GameState,
  player: Player
): AsyncGenerator<string, void, unknown> {
  const { t } = getI18n();
  const prompt = resolvePhasePrompt(state.phase, state, player);
  const startTime = Date.now();
  const { messages } = buildMessagesForPrompt(prompt);

  let fullResponse = "";
  try {
    for await (const chunk of generateCompletionStream(mergeOptionsFromModelRef(player.agentProfile!.modelRef, {
      model: player.agentProfile!.modelRef.model,
      messages,
      temperature: GAME_TEMPERATURE.SPEECH,
    }))) {
      fullResponse += chunk;
      yield chunk;
    }

    const sanitizedSpeech = sanitizeSeatMentions(sanitizeModelArtifacts(fullResponse), state.players);
    await aiLogger.log({
      type: "speech",
      request: { 
        model: player.agentProfile!.modelRef.model,
        messages,
        temperature: GAME_TEMPERATURE.SPEECH,
        player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
      },
      response: {
        content: sanitizedSpeech,
        raw: fullResponse,
        duration: Date.now() - startTime,
      },
    });
  } catch (error) {
    const sanitizedSpeech = sanitizeSeatMentions(sanitizeModelArtifacts(fullResponse), state.players);
    await aiLogger.log({
      type: "speech",
      request: { 
        model: player.agentProfile!.modelRef.model,
        messages,
        player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
      },
      response: { content: sanitizedSpeech, duration: Date.now() - startTime },
      error: String(error),
    });

    const raw = String(error);
    if (raw.includes("429") || raw.includes("limit_requests")) {
      if (!fullResponse.trim()) {
        yield t("gameMaster.tooManyRequests");
      }
      return;
    }

    throw error;
  }
}

export async function generateAISpeech(
  state: GameState,
  player: Player
): Promise<string> {
  let result = "";
  for await (const chunk of generateAISpeechStream(state, player)) {
    result += chunk;
  }
  return result;
}

export async function generateAISpeechSegments(
  state: GameState,
  player: Player
): Promise<string[]> {
  const { t } = getI18n();
  const prompt = resolvePhasePrompt(state.phase, state, player);
  const startTime = Date.now();
  const { messages } = buildMessagesForPrompt(prompt);

  const extractQuotedSegments = (text: string): string[] => {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    const slice = start >= 0 && end > start ? text.slice(start, end + 1) : text;
    const out: string[] = [];
    const regex = /"(?:\\.|[^"\\])*"/g;
    let match: RegExpExecArray | null = null;
    while ((match = regex.exec(slice)) !== null) {
      const m = match[0];
      const matchEndIndex = match.index + m.length;

      let lookaheadIndex = matchEndIndex;
      while (lookaheadIndex < slice.length && /\s/.test(slice[lookaheadIndex] ?? "")) {
        lookaheadIndex++;
      }

      // If this string is immediately followed by ':' (after optional whitespace), it's a JSON object key.
      if (slice[lookaheadIndex] === ":") continue;

      try {
        const s = JSON.parse(m);
        if (typeof s === "string") {
          const cleaned = s.trim();
          if (cleaned) out.push(cleaned);
        }
      } catch {
        // ignore
      }
    }
    return out;
  };

  const extractObjectSegments = (text: string): string[] => {
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (!objectMatch) return [];
    try {
      const parsed = parseLLMJson<unknown>(objectMatch[0]);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

      const out: string[] = [];
      const allowedKeys = new Set(["speech", "message", "content", "text", "value"]);
      const reservedKeys = new Set(["analysis", "judgment", "judgement", "observation", "reasoning", "thought"]);
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const loweredKey = k.toLowerCase();
        if (reservedKeys.has(loweredKey)) continue;
        if (!allowedKeys.has(loweredKey)) continue;

        if (typeof v === "string") {
          const cleaned = v.trim();
          if (cleaned) out.push(cleaned);
          continue;
        }
        if (Array.isArray(v)) {
          for (const item of v) {
            if (typeof item === "string") {
              const cleaned = item.trim();
              if (cleaned) out.push(cleaned);
            }
          }
        }
      }
      return out;
    } catch {
      return [];
    }
  };

  try {
    const result = await generateCompletion(mergeOptionsFromModelRef(player.agentProfile!.modelRef, {
      model: player.agentProfile!.modelRef.model,
      messages,
      temperature: GAME_TEMPERATURE.SPEECH,
    }));

    const cleanedSpeech = sanitizeModelArtifacts(stripMarkdownCodeFences(result.content));
    const sanitizedSpeech = sanitizeSeatMentions(cleanedSpeech, state.players);

    await aiLogger.log({
      type: "speech",
      request: { 
        model: player.agentProfile!.modelRef.model,
        messages,
        player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
      },
      response: {
        content: sanitizedSpeech,
        raw: result.content,
        rawResponse: JSON.stringify(result.raw, null, 2),
        finishReason: result.raw.choices?.[0]?.finish_reason,
        duration: Date.now() - startTime,
      },
    });

    // 尝试解析JSON数组
    try {
      const jsonMatch = sanitizedSpeech.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const segments = parseLLMJson<unknown[]>(jsonMatch[0]);
        if (Array.isArray(segments) && segments.length > 0) {
          const normalized: string[] = [];
          for (const item of segments) {
            if (typeof item === "string") {
              // 情况1: ["话1", "话2"] - 字符串数组
              const cleaned = item.trim().replace(/^["']+|["']+$/g, "");
              if (cleaned) normalized.push(cleaned);
            } else if (item && typeof item === "object") {
              // 情况2: [{"speaker": "...", "message": "..."}] - 对象数组
              // 优先提取 content, message, text, value 等常见字段
              const obj = item as Record<string, unknown>;
              const text = obj.content || obj.message || obj.text || obj.value || obj.speech;
              if (typeof text === "string") {
                const cleaned = text.trim();
                if (cleaned) normalized.push(cleaned);
              }
            }
          }

          if (normalized.length > 0) {
            return normalized;
          }
        }
      }
    } catch {
      // JSON解析失败，按换行分割
    }

    const objectExtracted = extractObjectSegments(sanitizedSpeech);
    if (objectExtracted.length > 0) return objectExtracted;

    const extracted = extractQuotedSegments(sanitizedSpeech)
      .map((s) => s.trim().replace(/^['"]+|['"]+$/g, ""))
      .filter((s) => s.length > 0);
    if (extracted.length > 0) return extracted;

    // 降级处理：按换行或句号分割
    const fallbackSegments = sanitizedSpeech
      .replace(/[\[\]]/g, "")  // 只移除方括号，保留引号
      .split(/[。！？]+(?=\s|$)|\n+/)  // 按句号、感叹号、问号（后面跟空格或结尾）或换行分割
      .map(s => s.trim().replace(/^["']+|["']+$/g, ""))  // 移除首尾引号
      .filter(s => s.length > 2);  // 过滤掉长度小于等于2的片段
    
    if (fallbackSegments.length > 0) return fallbackSegments;

    const cleanedSingle = sanitizedSpeech
      .replace(/[\[\]]/g, "")
      .trim()
      .replace(/^["']+|["']+$/g, "")
      .trim();

    return cleanedSingle.length > 0 ? [cleanedSingle] : ["（……）"];
  } catch (error) {
    await aiLogger.log({
      type: "speech",
      request: { 
        model: player.agentProfile!.modelRef.model,
        messages,
        player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
      },
      response: { content: "", duration: Date.now() - startTime },
      error: String(error),
    });

    const raw = String(error);
    if (raw.includes("429") || raw.includes("limit_requests")) {
      return [t("gameMaster.tooManyRequests")];
    }

    throw error;
  }
}

export interface StreamingSpeechOptions {
  onSegmentReceived?: (segment: string, index: number) => void;
  onProgress?: (current: number) => void;
  onComplete?: (segments: string[]) => void;
  onError?: (error: string) => void;
}

/**
 * 流式生成 AI 发言段落
 * 实时输出发言内容，每完成一个段落就立即通知
 */
export async function generateAISpeechSegmentsStream(
  state: GameState,
  player: Player,
  options: StreamingSpeechOptions = {}
): Promise<string[]> {
  const { t } = getI18n();
  const prompt = resolvePhasePrompt(state.phase, state, player);
  const startTime = Date.now();
  const { messages } = buildMessagesForPrompt(prompt);

  // Track segments already emitted via streaming to prevent double-emit in fallback
  const emittedSegments = new Set<string>();
  let emittedCount = 0;

  const parser = new StreamingSpeechParser({
    onSegmentReceived: (segment, index) => {
      const sanitized = sanitizeSeatMentions(sanitizeModelArtifacts(segment), state.players);
      if (!emittedSegments.has(sanitized)) {
        emittedSegments.add(sanitized);
        options.onSegmentReceived?.(sanitized, emittedCount++);
      }
    },
    onProgress: options.onProgress,
    onError: options.onError,
  });

  try {
    const stream = generateCompletionStream(mergeOptionsFromModelRef(player.agentProfile!.modelRef, {
      model: player.agentProfile!.modelRef.model,
      messages,
      temperature: GAME_TEMPERATURE.SPEECH,
    }));

    let accumulatedContent = "";
    let chunkCount = 0;

    for await (const chunk of stream) {
      chunkCount++;
      accumulatedContent += chunk;
      parser.processChunk(chunk);
      
      // 调试：每10个chunk输出一次
      if (chunkCount % 10 === 0) {
        console.log(`[streaming] chunks: ${chunkCount}, accumulated: ${accumulatedContent.length} chars, segments: ${parser.getSegmentCount()}`);
      }
    }
    
    console.log(`[streaming] done. total chunks: ${chunkCount}, segments emitted: ${parser.getSegmentCount()}, unique emitted: ${emittedSegments.size}`);

    // 结束解析
    const segments = parser.end();

    // 如果流式解析没有产生结果，回退到传统解析
    // 注意：只有当 emittedSegments 也为空时才进行回退，避免重复发射
    if (segments.length === 0 && emittedSegments.size === 0) {
      const cleanedSpeech = sanitizeModelArtifacts(stripMarkdownCodeFences(accumulatedContent));
      const sanitizedSpeech = sanitizeSeatMentions(cleanedSpeech, state.players);

      // 尝试解析 JSON 数组
      const jsonMatch = sanitizedSpeech.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const parsed = parseLLMJson<unknown[]>(jsonMatch[0]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const normalized: string[] = [];
            for (const item of parsed) {
              if (typeof item === "string") {
                // 情况1: ["话1", "话2"] - 字符串数组
                const cleaned = item.trim().replace(/^["']+|["']+$/g, "");
                if (cleaned) normalized.push(cleaned);
              } else if (item && typeof item === "object") {
                // 情况2: [{"speaker": "...", "message": "..."}] - 对象数组
                const obj = item as Record<string, unknown>;
                const text = obj.content || obj.message || obj.text || obj.value || obj.speech;
                if (typeof text === "string") {
                  const cleaned = text.trim();
                  if (cleaned) normalized.push(cleaned);
                }
              }
            }

            if (normalized.length > 0) {
              // 通知回退解析的结果（只发射未发射过的）
              normalized.forEach((seg) => {
                if (!emittedSegments.has(seg)) {
                  emittedSegments.add(seg);
                  options.onSegmentReceived?.(seg, emittedCount++);
                }
              });
              options.onComplete?.(normalized);
              return normalized;
            }
          }
        } catch {
          // 继续尝试其他方法
        }
      }

      // 降级处理：按换行或句号分割
      const fallbackSegments = sanitizedSpeech
        .replace(/[\[\]]/g, "")
        .split(/[。！？]+(?=\s|$)|\n+/)
        .map((s) => s.trim().replace(/^["']+|["']+$/g, ""))
        .filter((s) => s.length > 2);

      if (fallbackSegments.length > 0) {
        fallbackSegments.forEach((seg) => {
          if (!emittedSegments.has(seg)) {
            emittedSegments.add(seg);
            options.onSegmentReceived?.(seg, emittedCount++);
          }
        });
        options.onComplete?.(fallbackSegments);
        return fallbackSegments;
      }

      const cleanedSingle = sanitizedSpeech
        .replace(/[\[\]]/g, "")
        .trim()
        .replace(/^["']+|["']+$/g, "")
        .trim();

      const result = cleanedSingle.length > 0 ? [cleanedSingle] : ["（……）"];
      result.forEach((seg) => {
        if (!emittedSegments.has(seg)) {
          emittedSegments.add(seg);
          options.onSegmentReceived?.(seg, emittedCount++);
        }
      });
      options.onComplete?.(result);
      return result;
    }
    
    // 如果流式已经发射了 segments 但 parser.end() 返回空，使用已发射的
    if (segments.length === 0 && emittedSegments.size > 0) {
      const emittedList = Array.from(emittedSegments);
      options.onComplete?.(emittedList);
      return emittedList;
    }

    // Sanitize all segments
    const sanitizedSegments = segments.map((s) =>
      sanitizeSeatMentions(sanitizeModelArtifacts(s), state.players)
    );

    await aiLogger.log({
      type: "speech",
      request: {
        model: player.agentProfile!.modelRef.model,
        messages,
        player: {
          playerId: player.playerId,
          displayName: player.displayName,
          seat: player.seat,
          role: player.role,
        },
      },
      response: {
        content: sanitizedSegments.join("\n"),
        raw: accumulatedContent,
        duration: Date.now() - startTime,
      },
    });

    options.onComplete?.(sanitizedSegments);
    return sanitizedSegments;
  } catch (error) {
    await aiLogger.log({
      type: "speech",
      request: {
        model: player.agentProfile!.modelRef.model,
        messages,
        player: {
          playerId: player.playerId,
          displayName: player.displayName,
          seat: player.seat,
          role: player.role,
        },
      },
      response: { content: "", duration: Date.now() - startTime },
      error: String(error),
    });

    const raw = String(error);
    if (raw.includes("429") || raw.includes("limit_requests")) {
      const result = [t("gameMaster.tooManyRequests")];
      options.onComplete?.(result);
      return result;
    }

    options.onError?.(String(error));
    throw error;
  }
}

/**
 * 从玩家当天最后一段公开发言中提取明确的归票目标。
 * 只认「归票/投/出 + N号」这种明确句式；否定句（不投/别投）跳过。
 * 返回 0 基座位号；没有明确目标或目标已出局则返回 null。
 */
function extractDeclaredVoteTarget(state: GameState, player: Player): number | null {
  const text = state.messages
    .filter(
      (m) =>
        !m.isSystem &&
        m.day === state.day &&
        m.playerId === player.playerId &&
        (m.phase === "DAY_SPEECH" || m.phase === "DAY_PK_SPEECH")
    )
    .map((m) => String(m.content || ""))
    .join("\n");
  if (!text.trim()) return null;

  // 喵杀修复（2026-10-30 · 站长实测「大家都说投4号、结果全投1号」）：
  // 玩家名经过 mention 规范化后，真实句子常写成「今天票压 英短蓝猫 灰灰@4号…」——
  // 原来的正则要求「动词 → 数字」紧挨着，名字一夹在中间就识别失败，
  // 「言行一致」校验形同虚设，AI 的票就被实时票型带着跑。
  // 现在：动词后允许同一句内最多 30 字的内容，再找第一个「@N号 / N号」；
  // 同时保留否定与第三人称的排除。
  const otherNames = state.players
    .filter((p) => p.playerId !== player.playerId && p.displayName)
    .map((p) => p.displayName);
  const verbPattern =
    /(?:今日归票|本轮归票|归票|票投|投给|放逐|推出|票出|投|出|压|往|打|踩)(?:给|到|掉)?/g;
  const seatMention = /@?(\d+)\s*号/;

  let targetSeat: number | null = null;
  let bestIndex = -1;

  for (const match of text.matchAll(verbPattern)) {
    const index = match.index ?? 0;
    const afterVerb = text.slice(index + match[0].length, index + match[0].length + 30);
    const stop = afterVerb.search(/[。；！？\n]/);
    const clause = stop >= 0 ? afterVerb.slice(0, stop) : afterVerb;
    const seatMatch = clause.match(seatMention);
    if (!seatMatch) continue;

    // 只看「当前这句」里、动词之前的成分：避免把上一句的别人名字带进来误判第三人称。
    const sentenceStart = Math.max(
      text.lastIndexOf("。", index - 1),
      text.lastIndexOf("；", index - 1),
      text.lastIndexOf("！", index - 1),
      text.lastIndexOf("？", index - 1),
      text.lastIndexOf("\n", index - 1)
    );
    const prefix = text.slice(sentenceStart + 1, index);
    // 否定：不投/别投/不要出/不会投……
    if (/(?:不要|不用|不是|不会|没想|不|别)\s*$/.test(prefix)) continue;
    // 第三人称：他/她/它/对方/别人，或「N号一直/也/还…」这类描述别人的句式
    if (/(?:他|她|它|对方|别人|有人|某个)\s*[^，。；\n]{0,6}$/.test(prefix)) continue;
    if (/\d+\s*号(?:今天|今晚|白天|一直|在|也|还|又|先|就|想|要|会|应该|可能|明显|疯狂|刚刚)*\s*$/.test(prefix)) {
      continue;
    }
    // 前缀里出现了别人的名字、且没有第一人称 → 在描述别人的动作，不是本人归票
    const mentionsOther = otherNames.some((name) => prefix.includes(name));
    const firstPerson = /(?:我|本喵|本猫|咱|俺)/.test(prefix);
    if (mentionsOther && !firstPerson) continue;

    if (index >= bestIndex) {
      bestIndex = index;
      targetSeat = Number(seatMatch[1]) - 1;
    }
  }

  if (targetSeat === null || !Number.isFinite(targetSeat)) return null;
  if (targetSeat === player.seat) return null;
  return state.players.some((p) => p.seat === targetSeat && p.alive)
    ? targetSeat
    : null;
}

export async function generateAIVote(
  state: GameState,
  player: Player
): Promise<{ seat: number; reason: string }> {
  const { t } = getI18n();
  const prompt = resolvePhasePrompt("DAY_VOTE", state, player);
  const eligibleSeats = state.pkSource === "vote" && state.pkTargets && state.pkTargets.length > 0
    ? new Set(state.pkTargets)
    : null;
  const alivePlayers = state.players.filter(
    (p) => p.alive && p.playerId !== player.playerId && (!eligibleSeats || eligibleSeats.has(p.seat))
  );
  const startTime = Date.now();
  const { messages } = buildMessagesForPrompt(prompt);

  let result: { content: string; raw: ChatCompletionResponse };
  try {
    // 喵杀（十四轮）：投票改用「严格」温度（0.1，而不是行动默认的 0.4）——
    // 投票是纯粹的服从性决策（言行一致 / 跟查杀 / 跟归票 / 跟实时票型），
    // 降低随机性才能减少「人人各投一个 → 票型散开」的情况（站长反馈）。
    result = await generateCompletion(mergeOptionsFromModelRef(player.agentProfile!.modelRef, {
      model: player.agentProfile!.modelRef.model,
      messages,
      temperature: AI_TEMPERATURE.STRICT,
      response_format: { type: "json_object" },
    }));

    const rawContent = result.content;
    const cleanedVote = stripMarkdownCodeFences(rawContent);
    const cleaned = cleanedVote.trim();
    
    let parsedResult: { seat: number; reason: string } | null = null;
    
    const parsed = parseLLMJson<{ seat?: number; reason?: string }>(cleaned);
    if (parsed) {
      const seat = typeof parsed.seat === "number" ? parsed.seat - 1 : NaN;
      const validSeats = alivePlayers.map((p) => p.seat);
      if (Number.isFinite(seat) && validSeats.includes(seat)) {
        const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
        parsedResult = { seat, reason: reason || t("gameMaster.voteFallback.missingReason") };
      }
    }

    // 喵杀修复（2026-10-18 · 站长实测）：模型偶尔会无视自己刚说过的归票目标
    //（例：预言家公开说「今日归票 11号」，实际却投了金水 7号）。
    // 这里从本人今天最后一段公开发言中提取明确的「归票/投 X号」，
    // 只要目标仍存活，就强制与公开承诺一致。狼人若公开归票的是狼队友，
    // 保留不投队友的策略例外。
    const declaredTarget = extractDeclaredVoteTarget(state, player);
    if (declaredTarget !== null) {
      const declaredPlayer = state.players.find((p) => p.seat === declaredTarget);
      const wouldVoteTeammate =
        player.alignment === "wolf" && declaredPlayer?.alignment === "wolf";
      if (!wouldVoteTeammate && parsedResult?.seat !== declaredTarget) {
        console.info(
          `[meowcha] 投票言行一致：${player.seat + 1}号公开归票 ${declaredTarget + 1}号，` +
            `模型选择 ${parsedResult ? parsedResult.seat + 1 : "无"}号 → 已纠正`
        );
        parsedResult = {
          seat: declaredTarget,
          reason: t("gameMaster.voteFallback.declaredTarget"),
        };
      }
    }

    if (!parsedResult) {
      // 喵杀修复：原实现只取文本里**第一个**数字当座位号 → 很容易拿错
      //（例如「我怀疑3号，第1天他就…」会取到 1 → 投给 1 号），
      // 取错/取不到就退化成「随机投票」，这正是票型散开的放大器。
      // 现在按「明确程度」依次尝试：JSON 的 seat 字段 → "N号" → 任意能映射到合法座位的数字。
      const validSeats = alivePlayers.map((p) => p.seat);
      const candidates: number[] = [];
      const seatField = cleaned.match(/"seat"\s*:\s*(\d+)/);
      if (seatField) candidates.push(Number(seatField[1]));
      for (const m of cleaned.matchAll(/(\d+)\s*号/g)) candidates.push(Number(m[1]));
      for (const m of cleaned.matchAll(/\d+/g)) candidates.push(Number(m[0]));
      for (const c of candidates) {
        const seat = c - 1;
        if (Number.isFinite(seat) && validSeats.includes(seat)) {
          parsedResult = { seat, reason: t("gameMaster.voteFallback.parseSeatOnly") };
          break;
        }
      }
    }

    if (!parsedResult) {
      if (alivePlayers.length === 0) {
        parsedResult = { seat: player.seat, reason: t("gameMaster.voteFallback.noTargets") };
      } else {
        const fallback = alivePlayers[Math.floor(Math.random() * alivePlayers.length)].seat;
        parsedResult = { seat: fallback, reason: t("gameMaster.voteFallback.randomPick") };
      }
    }

    // Log with both raw and parsed data
    await aiLogger.log({
      type: "vote",
      request: { 
        model: player.agentProfile!.modelRef.model,
        messages,
        player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
      },
      response: { 
        content: cleanedVote, 
        raw: rawContent,
        rawResponse: JSON.stringify(result.raw, null, 2),
        finishReason: result.raw.choices?.[0]?.finish_reason,
        parsed: parsedResult,
        duration: Date.now() - startTime 
      },
    });

    return parsedResult;
  } catch (error) {
    const fallbackResult = alivePlayers.length === 0
      ? { seat: player.seat, reason: t("gameMaster.voteFallback.noTargets") }
      : { seat: alivePlayers[Math.floor(Math.random() * alivePlayers.length)].seat, reason: t("gameMaster.voteFallback.randomPick") };
    
    await aiLogger.log({
      type: "vote",
      request: {
        model: player.agentProfile!.modelRef.model,
        messages,
        player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
      },
      response: { 
        content: "", 
        parsed: fallbackResult,
        duration: Date.now() - startTime 
      },
      error: String(error),
    });

    return fallbackResult;
  }
}

/** Sentinel for abstain when AI fails to vote or parse. Counting logic skips -1 via aliveBySeat.has(seat). */
export const BADGE_VOTE_ABSTAIN = -1;

export const BADGE_TRANSFER_TORN = -1;

/**
 * 使用 SUMMARY_MODEL 一次性判断所有玩家是否上警
 * 基于玩家的背景信息和第一晚的操作信息来决策
 */
export async function generateAIBadgeSignupBatch(
  state: GameState,
  players: Player[]
): Promise<Record<string, boolean>> {
  if (!players || players.length === 0) return {};

  const { t } = getI18n();
  const startTime = Date.now();

  // 构建所有玩家的信息摘要
  const playersInfo = players.map((player) => {
    const persona = player.agentProfile?.persona;
    const roleText = (() => {
      switch (player.role) {
        case "Werewolf": return t("promptUtils.roleText.werewolf");
        case "Seer": return t("promptUtils.roleText.seer");
        case "Witch": return t("promptUtils.roleText.witch");
        case "Hunter": return t("promptUtils.roleText.hunter");
        case "Guard": return t("promptUtils.roleText.guard");
        default: return t("promptUtils.roleText.villager");
      }
    })();

    // 获取玩家第一晚的行动信息
    let nightActionInfo = "";
    if (player.role === "Seer" && state.nightActions.seerHistory && state.nightActions.seerHistory.length > 0) {
      const lastCheck = state.nightActions.seerHistory[state.nightActions.seerHistory.length - 1];
      const targetPlayer = state.players.find((p) => p.seat === lastCheck.targetSeat);
      if (targetPlayer) {
        nightActionInfo = t("gameMaster.badgeSignup.seerChecked", {
          targetSeat: lastCheck.targetSeat + 1,
          targetName: targetPlayer.displayName,
          result: lastCheck.isWolf ? t("gameMaster.badgeSignup.werewolf") : t("gameMaster.badgeSignup.notWerewolf"),
        });
      }
    } else if (player.role === "Witch") {
      const actions: string[] = [];
      if (state.roleAbilities?.witchHealUsed) {
        actions.push(t("gameMaster.badgeSignup.witchHealed"));
      }
      if (state.roleAbilities?.witchPoisonUsed) {
        actions.push(t("gameMaster.badgeSignup.witchPoisoned"));
      }
      if (actions.length > 0) {
        nightActionInfo = actions.join(t("promptUtils.gameContext.listSeparator"));
      }
    } else if (player.role === "Guard" && state.nightActions.lastGuardTarget !== undefined) {
      const targetPlayer = state.players.find((p) => p.seat === state.nightActions.lastGuardTarget);
      if (targetPlayer) {
        nightActionInfo = t("gameMaster.badgeSignup.guardProtected", { 
          targetSeat: state.nightActions.lastGuardTarget + 1,
          targetName: targetPlayer.displayName 
        });
      }
    } else if (player.role === "Werewolf") {
      nightActionInfo = t("gameMaster.badgeSignup.werewolfParticipated");
    }

    // 从 Persona 构建性格描述
    const personalityParts: string[] = [];
    if (persona?.mbti) personalityParts.push(persona.mbti);
    if (persona?.styleLabel) personalityParts.push(persona.styleLabel);
    if (persona?.socialHabit) personalityParts.push(persona.socialHabit);

    return {
      playerId: player.playerId,
      seat: player.seat + 1,
      name: player.displayName,
      role: roleText,
      personality: personalityParts.join("，") || "",
      nightAction: nightActionInfo,
    };
  });

  // 构建批量判断的 prompt
  // 使用 t.raw() 因为 prompt 包含字面的 {} 字符（JSON 示例），不应被解析为 ICU 占位符
  const systemPrompt = t.raw("gameMaster.badgeSignup.systemPrompt");
  const playerDescriptions = playersInfo.map((info) => {
    let desc = t("gameMaster.badgeSignup.playerDesc", {
      seat: info.seat,
      name: info.name,
      role: info.role,
      personality: info.personality || t("gameMaster.badgeSignup.noPersonality"),
    });
    if (info.nightAction) {
      desc += t("gameMaster.badgeSignup.nightActionSuffix", { action: info.nightAction });
    }
    return desc;
  }).join("\n");

  // userPrompt 也包含字面 {} 字符，需要手动替换占位符
  const userPromptTemplate = t.raw("gameMaster.badgeSignup.userPrompt");
  const userPrompt = userPromptTemplate
    .replace("{playerDescriptions}", playerDescriptions)
    .replace("{seatList}", playersInfo.map((p) => p.seat).join(", "));

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const parsedByPlayer: Record<string, boolean> = {};

  try {
    const result = await generateCompletion({
      model: getSummaryModel(),
      messages,
      temperature: GAME_TEMPERATURE.BADGE_SIGNUP,
      response_format: { type: "json_object" },
    });

    const cleaned = stripMarkdownCodeFences(result.content).trim();
    const duration = Date.now() - startTime;

    await aiLogger.log({
      type: "badge_signup",
      request: {
        model: getSummaryModel(),
        messages,
        player: { playerId: "batch", displayName: "All Players", seat: -1, role: "Villager" as Role },
      },
      response: {
        content: cleaned,
        raw: result.content,
        rawResponse: JSON.stringify(result.raw, null, 2),
        finishReason: result.raw.choices?.[0]?.finish_reason,
        duration,
      },
    });

    // 解析 JSON 响应
    const parsed = parseLLMJson<Record<string, unknown>>(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // 支持多种响应格式
      // 格式1: { "decisions": { "1": true, "2": false, ... } }
      // 格式2: { "1": true, "2": false, ... }
      // 格式3: { "signup": [1, 3, 5] } (seats that signup)
      let decisions: Record<string, boolean> = {};

      if (parsed.decisions && typeof parsed.decisions === "object") {
        decisions = parsed.decisions as Record<string, boolean>;
      } else if (parsed.signup && Array.isArray(parsed.signup)) {
        const signupSeats = new Set((parsed.signup as number[]).map(Number));
        for (const info of playersInfo) {
          decisions[String(info.seat)] = signupSeats.has(info.seat);
        }
      } else {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "boolean" || value === 0 || value === 1) {
            decisions[key] = Boolean(value);
          }
        }
      }

      for (const info of playersInfo) {
        const decision = decisions[String(info.seat)];
        parsedByPlayer[info.playerId] = decision === true;
      }
    } else {
      for (const player of players) {
        parsedByPlayer[player.playerId] = false;
      }
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    await aiLogger.log({
      type: "badge_signup",
      request: {
        model: getSummaryModel(),
        messages,
        player: { playerId: "batch", displayName: "All Players", seat: -1, role: "Villager" as Role },
      },
      response: { content: "", duration },
      error: String(error),
    });

    // 出错时默认所有人不上警
    for (const player of players) {
      parsedByPlayer[player.playerId] = false;
    }
  }

  return parsedByPlayer;
}

export async function generateAIBadgeVote(
  state: GameState,
  player: Player
): Promise<number> {
  const prompt = resolvePhasePrompt("DAY_BADGE_ELECTION", state, player);
  const alivePlayers = state.players.filter((p) => p.alive && p.playerId !== player.playerId);
  const startTime = Date.now();
  const { messages } = buildMessagesForPrompt(prompt);

  try {
    const result = await generateCompletion(mergeOptionsFromModelRef(player.agentProfile!.modelRef, {
      model: player.agentProfile!.modelRef.model,
      messages,
      temperature: GAME_TEMPERATURE.ACTION,
    }));

    const cleanedBadgeVote = stripMarkdownCodeFences(result.content);

    await aiLogger.log({
      type: "badge_vote",
      request: {
        model: player.agentProfile!.modelRef.model,
        messages,
        player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
      },
      response: {
        content: cleanedBadgeVote,
        raw: result.content,
        rawResponse: JSON.stringify(result.raw, null, 2),
        finishReason: result.raw.choices?.[0]?.finish_reason,
        duration: Date.now() - startTime,
      },
    });

    const match = cleanedBadgeVote.match(/\d+/);
    if (match) {
      const seat = parseInt(match[0]) - 1;
      const validSeats = alivePlayers.map((p) => p.seat);
      if (validSeats.includes(seat)) {
        return seat;
      }
    }

    // Parse failed or invalid seat: treat as abstain instead of random to avoid stuck flow
    return BADGE_VOTE_ABSTAIN;
  } catch (error) {
    // Network/API error: treat as abstain so the phase does not get stuck
    console.warn("[meowcha] generateAIBadgeVote failed, treating as abstain:", error);
    await aiLogger.log({
      type: "badge_vote",
      request: {
        model: player.agentProfile!.modelRef.model,
        messages: [],
        player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
      },
      response: { content: "", duration: Date.now() - startTime },
      error: String(error),
    });
    return BADGE_VOTE_ABSTAIN;
  }
}

export async function generateBadgeTransfer(
  state: GameState,
  player: Player
): Promise<number> {
  const prompt = resolvePhasePrompt("BADGE_TRANSFER", state, player);
  const alivePlayers = state.players.filter(
    (p) => p.alive && p.playerId !== player.playerId
  );
  const confirmedWolfSeats = new Set(
    (state.nightActions.seerHistory || [])
      .filter((x) => x && x.isWolf)
      .map((x) => x.targetSeat)
  );
  const startTime = Date.now();
  const { messages } = buildMessagesForPrompt(prompt);

  const result = await generateCompletion(mergeOptionsFromModelRef(player.agentProfile!.modelRef, {
    model: player.agentProfile!.modelRef.model,
    messages,
    temperature: GAME_TEMPERATURE.ACTION,
  }));

  const cleanedTransfer = stripMarkdownCodeFences(result.content);

  await aiLogger.log({
    type: "badge_transfer",
    request: {
      model: player.agentProfile!.modelRef.model,
      messages,
      player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
    },
    response: {
      content: cleanedTransfer,
      raw: result.content,
      rawResponse: JSON.stringify(result.raw, null, 2),
      finishReason: result.raw.choices?.[0]?.finish_reason,
      duration: Date.now() - startTime,
    },
  });

  const validSeats = alivePlayers.map((p) => p.seat);
  const pickFallbackSeat = (): number => {
    if (player.alignment === "village" && player.role === "Seer" && confirmedWolfSeats.size > 0) {
      const safeSeats = validSeats.filter((s) => !confirmedWolfSeats.has(s));
      if (safeSeats.length > 0) {
        return safeSeats[Math.floor(Math.random() * safeSeats.length)];
      }
      return BADGE_TRANSFER_TORN;
    }
    return validSeats[Math.floor(Math.random() * validSeats.length)];
  };

  const match = cleanedTransfer.match(/-?\d+/);
  if (match) {
    const parsed = Number.parseInt(match[0], 10);
    if (parsed === 0) {
      return BADGE_TRANSFER_TORN;
    }
    const seat = parsed - 1;
    if (validSeats.includes(seat)) {
      if (player.alignment === "village" && player.role === "Seer" && confirmedWolfSeats.has(seat)) {
        return pickFallbackSeat();
      }
      return seat;
    }
  }

  return pickFallbackSeat();
}

export async function generateSeerAction(
  state: GameState,
  player: Player
): Promise<number> {
  const prompt = resolvePhasePrompt("NIGHT_SEER_ACTION", state, player);
  const alivePlayers = state.players.filter(
    (p) => p.alive && p.playerId !== player.playerId
  );
  const startTime = Date.now();
  const { messages } = buildMessagesForPrompt(prompt);

  const result = await generateCompletion(mergeOptionsFromModelRef(player.agentProfile!.modelRef, {
    model: player.agentProfile!.modelRef.model,
    messages,
    temperature: GAME_TEMPERATURE.ACTION,
  }));

  const rawContent = result.content;
  const cleanedSeer = stripMarkdownCodeFences(rawContent);

  const match = cleanedSeer.match(/\d+/);
  let parsedSeat: number;
  if (match) {
    const seat = parseInt(match[0]) - 1;
    const validSeats = alivePlayers.map((p) => p.seat);
    if (validSeats.includes(seat)) {
      parsedSeat = seat;
    } else {
      parsedSeat = alivePlayers[Math.floor(Math.random() * alivePlayers.length)].seat;
    }
  } else {
    parsedSeat = alivePlayers[Math.floor(Math.random() * alivePlayers.length)].seat;
  }

  await aiLogger.log({
    type: "seer_action",
    request: { 
      model: player.agentProfile!.modelRef.model,
      messages,
      player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
    },
    response: { 
      content: cleanedSeer, 
      raw: rawContent,
      rawResponse: JSON.stringify(result.raw, null, 2),
      finishReason: result.raw.choices?.[0]?.finish_reason,
      parsed: { targetSeat: parsedSeat },
      duration: Date.now() - startTime 
    },
  });

  return parsedSeat;
}

export async function generateWolfAction(
  state: GameState,
  player: Player,
  existingVotes: Record<string, number> = {}
): Promise<number> {
  const prompt = resolvePhasePrompt("NIGHT_WOLF_ACTION", state, player, { existingVotes });
  const alivePlayers = state.players.filter((p) => p.alive);
  const startTime = Date.now();
  const { messages } = buildMessagesForPrompt(prompt);

  const result = await generateCompletion(mergeOptionsFromModelRef(player.agentProfile!.modelRef, {
    model: player.agentProfile!.modelRef.model,
    messages,
    temperature: GAME_TEMPERATURE.ACTION,
  }));

  const rawContent = result.content;
  const cleanedWolf = stripMarkdownCodeFences(rawContent);

  const match = cleanedWolf.match(/\d+/);
  let parsedSeat: number;
  if (match) {
    const seat = parseInt(match[0]) - 1;
    const validSeats = alivePlayers.map((p) => p.seat);
    if (validSeats.includes(seat)) {
      parsedSeat = seat;
    } else {
      parsedSeat = alivePlayers[Math.floor(Math.random() * alivePlayers.length)].seat;
    }
  } else {
    parsedSeat = alivePlayers[Math.floor(Math.random() * alivePlayers.length)].seat;
  }

  await aiLogger.log({
    type: "wolf_action",
    request: { 
      model: player.agentProfile!.modelRef.model,
      messages,
      player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
    },
    response: { 
      content: cleanedWolf, 
      raw: rawContent,
      rawResponse: JSON.stringify(result.raw, null, 2),
      finishReason: result.raw.choices?.[0]?.finish_reason,
      parsed: { targetSeat: parsedSeat },
      duration: Date.now() - startTime 
    },
  });

  return parsedSeat;
}

export type WitchAction =
  | { type: "save" }
  | { type: "poison"; target: number }
  | { type: "pass" };

export async function generateWitchAction(
  state: GameState,
  player: Player,
  wolfTarget: number | undefined
): Promise<WitchAction> {
  const prompt = resolvePhasePrompt("NIGHT_WITCH_ACTION", state, player, { wolfTarget });
  const startTime = Date.now();
  const { messages } = buildMessagesForPrompt(prompt);

  const result = await generateCompletion(mergeOptionsFromModelRef(player.agentProfile!.modelRef, {
    model: player.agentProfile!.modelRef.model,
    messages,
    temperature: GAME_TEMPERATURE.ACTION,
  }));

  const cleanedWitch = stripMarkdownCodeFences(result.content);

  const rawText = cleanedWitch.trim();
  const normalized = rawText.replace(/^[\s"'`]+|[\s"'`]+$/g, "").trim();
  // 喵杀修复（2026-10-19 · 站长实测）：原来只认「以 save/救/poison/毒 开头」的回复，
  // 模型只要写成「我选择救5号」「不救，毒3号」就会被误判成 pass →
  // 女巫首夜几乎从不救人。这里改为识别自然语言里的真实意图，并优先处理否定词。
  const poisonMatch = normalized.match(/(?:poison|毒)\s*(?:杀|掉|死|使用毒药|用毒药)?\s*(\d+)\s*号?/i);
  const negatedPoison = /(?:不毒|别毒|不要毒|不使用毒药|不用毒药|不 poison|no poison)/i.test(normalized);
  const negatedSave = /(?:不救|别救|不要救|不使用解药|不用解药|不解药|不 save|no save)/i.test(normalized);
  const wantsPoison = !!poisonMatch && !negatedPoison;
  const wantsSave = !negatedSave && /(?:save|使用解药|用解药|解药|救)/i.test(normalized);
  const wantsPass = /(?:pass|不救|不用药|不使用|跳过|空过|放弃|什么都不做)/i.test(normalized);

  const canSave =
    !state.roleAbilities.witchHealUsed &&
    wolfTarget !== undefined;
  const canPoison = !state.roleAbilities.witchPoisonUsed;

  let parsedAction: WitchAction;
  if (wantsPoison) {
    if (!canPoison) {
      parsedAction = { type: "pass" };
    } else {
      const seat = parseInt(poisonMatch![1], 10) - 1;
      if (!Number.isFinite(seat) || seat === player.seat) {
        parsedAction = { type: "pass" };
      } else {
        const target = state.players.find((p) => p.seat === seat);
        if (!target || !target.alive) {
          parsedAction = { type: "pass" };
        } else {
          parsedAction = { type: "poison", target: seat };
        }
      }
    }
  } else if (wantsSave) {
    parsedAction = canSave ? { type: "save" } : { type: "pass" };
  } else if (wantsPass) {
    parsedAction = { type: "pass" };
  } else {
    parsedAction = { type: "pass" };
  }

  await aiLogger.log({
    type: "witch_action",
    request: {
      model: player.agentProfile!.modelRef.model,
      messages,
      player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
    },
    response: {
      content: cleanedWitch,
      raw: result.content,
      rawResponse: JSON.stringify(result.raw, null, 2),
      finishReason: result.raw.choices?.[0]?.finish_reason,
      parsed: parsedAction,
      duration: Date.now() - startTime,
    },
  });

  return parsedAction;
}

// ...

export async function generateGuardAction(
  state: GameState,
  player: Player
): Promise<number> {
  const prompt = resolvePhasePrompt("NIGHT_GUARD_ACTION", state, player);
  const lastTarget = state.nightActions.lastGuardTarget;
  const alivePlayers = state.players.filter(
    (p) => p.alive && p.seat !== lastTarget
  );
  const startTime = Date.now();
  const { messages } = buildMessagesForPrompt(prompt);

  const result = await generateCompletion(mergeOptionsFromModelRef(player.agentProfile!.modelRef, {
    model: player.agentProfile!.modelRef.model,
    messages,
    temperature: GAME_TEMPERATURE.ACTION,
  }));

  const cleanedGuard = stripMarkdownCodeFences(result.content);

  const match = cleanedGuard.match(/\d+/);
  let parsedSeat: number;
  if (match) {
    const seat = parseInt(match[0]) - 1;
    const validSeats = alivePlayers.map((p) => p.seat);
    if (validSeats.includes(seat)) {
      parsedSeat = seat;
    } else {
      parsedSeat = alivePlayers[Math.floor(Math.random() * alivePlayers.length)].seat;
    }
  } else {
    parsedSeat = alivePlayers[Math.floor(Math.random() * alivePlayers.length)].seat;
  }

  await aiLogger.log({
    type: "guard_action",
    request: { 
      model: player.agentProfile!.modelRef.model,
      messages,
      player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
    },
    response: {
      content: cleanedGuard,
      raw: result.content,
      rawResponse: JSON.stringify(result.raw, null, 2),
      finishReason: result.raw.choices?.[0]?.finish_reason,
      parsed: { targetSeat: parsedSeat },
      duration: Date.now() - startTime,
    },
  });

  return parsedSeat;
}

// ...

export async function generateHunterShoot(
  state: GameState,
  player: Player
): Promise<number | null> {
  const prompt = resolvePhasePrompt("HUNTER_SHOOT", state, player);
  const alivePlayers = state.players.filter(
    (p) => p.alive && p.playerId !== player.playerId
  );
  const startTime = Date.now();
  const { messages } = buildMessagesForPrompt(prompt);

  const result = await generateCompletion(mergeOptionsFromModelRef(player.agentProfile!.modelRef, {
    model: player.agentProfile!.modelRef.model,
    messages,
    temperature: GAME_TEMPERATURE.ACTION,
  }));

  const cleanedHunter = stripMarkdownCodeFences(result.content);

  const contentLower = cleanedHunter.toLowerCase().trim();
  let parsedTarget: number | null;
  
  if (contentLower.includes("pass")) {
    parsedTarget = null;
  } else {
    const match = cleanedHunter.match(/\d+/);
    if (match) {
      const seat = parseInt(match[0]) - 1;
      const validSeats = alivePlayers.map((p) => p.seat);
      if (validSeats.includes(seat)) {
        parsedTarget = seat;
      } else {
        // 猎人随机选择一个目标
        parsedTarget = alivePlayers[Math.floor(Math.random() * alivePlayers.length)].seat;
      }
    } else {
      // 猎人随机选择一个目标
      parsedTarget = alivePlayers[Math.floor(Math.random() * alivePlayers.length)].seat;
    }
  }

  await aiLogger.log({
    type: "hunter_shoot",
    request: { 
      model: player.agentProfile!.modelRef.model,
      messages,
      player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
    },
    response: {
      content: cleanedHunter,
      raw: result.content,
      rawResponse: JSON.stringify(result.raw, null, 2),
      finishReason: result.raw.choices?.[0]?.finish_reason,
      parsed: { targetSeat: parsedTarget },
      duration: Date.now() - startTime,
    },
  });

  return parsedTarget;
}

function parseDisplaySeatValue(value: unknown, validSeats: number[]): number | null {
  const displaySeat =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+$/.test(value.trim())
        ? Number.parseInt(value.trim(), 10)
        : NaN;

  if (!Number.isFinite(displaySeat)) return null;
  const seat = displaySeat - 1;
  return validSeats.includes(seat) ? seat : null;
}

function parseLLMDisplaySeat(raw: string, validSeats: number[], keys: string[] = ["seat", "targetSeat", "target", "vote"]): number | null {
  if (validSeats.length === 0) return null;

  const cleaned = stripMarkdownCodeFences(raw).trim();
  const parsed = parseLLMJson<unknown>(cleaned);

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const key of keys) {
      const seat = parseDisplaySeatValue(record[key], validSeats);
      if (seat !== null) return seat;
    }
  }

  return null;
}

function firstSeat(validSeats: number[]): number | undefined {
  return [...validSeats].sort((a, b) => a - b)[0];
}

/**
 * AI 白狼王自爆决策：返回目标座位号（自爆）或 null（不自爆）
 */
export async function generateWhiteWolfKingBoomDecision(
  state: GameState,
  player: Player
): Promise<number | null> {
  const prompt = resolvePhasePrompt("WHITE_WOLF_KING_BOOM", state, player);
  const alivePlayers = state.players.filter(
    (p) => p.alive && p.playerId !== player.playerId
  );
  const startTime = Date.now();
  const { messages } = buildMessagesForPrompt(prompt);
  const validSeats = alivePlayers.map((p) => p.seat);

  if (validSeats.length === 0) return null;

  try {
    const completion = await generateCompletionWithParseRetry<number | null>(
      mergeOptionsFromModelRef(player.agentProfile!.modelRef, {
        model: player.agentProfile!.modelRef.model,
        messages,
        temperature: GAME_TEMPERATURE.ACTION,
        response_format: { type: "json_object" },
      }),
      (cleaned) => {
        const parsed = parseLLMJson<unknown>(cleaned);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parseFail();

        const record = parsed as Record<string, unknown>;
        const action = String(record.action ?? record.type ?? "").trim().toLowerCase();
        const seatValue = record.seat ?? record.targetSeat ?? record.target ?? record.boom;
        const wantsPass =
          action.includes("pass") ||
          action.includes("skip") ||
          action.includes("none") ||
          seatValue === null ||
          seatValue === 0 ||
          seatValue === "0";

        if (wantsPass) return parseOk(null);
        const wantsBoom =
          action === "" ||
          action.includes("boom") ||
          action.includes("explode") ||
          action.includes("self");
        if (!wantsBoom) return parseFail();

        const target = parseLLMDisplaySeat(cleaned, validSeats, ["seat", "targetSeat", "target", "boom"]);
        return target === null ? parseFail() : parseOk(target);
      },
      jsonRetryInstruction(`${JSON.stringify({ action: "boom", seat: (firstSeat(validSeats) ?? 0) + 1 })} 或 / or ${JSON.stringify({ action: "pass" })}`)
    );
    const parsedTarget = completion.parsed;

    await aiLogger.log({
      type: "wwk_boom_decision",
      request: {
        model: player.agentProfile!.modelRef.model,
        messages,
        player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
      },
      response: {
        content: completion.cleaned,
        raw: completion.result.content,
        rawResponse: JSON.stringify(completion.result.raw, null, 2),
        finishReason: completion.result.raw.choices?.[0]?.finish_reason,
        parsed: { targetSeat: parsedTarget, attempts: completion.attempts },
        duration: Date.now() - startTime,
      },
    });

    return parsedTarget;
  } catch (error) {
    console.warn("[meowcha] generateWhiteWolfKingBoomDecision failed, passing self-destruct:", error);
    await aiLogger.log({
      type: "wwk_boom_decision",
      request: {
        model: player.agentProfile!.modelRef.model,
        messages,
        player: { playerId: player.playerId, displayName: player.displayName, seat: player.seat, role: player.role },
      },
      response: {
        content: "",
        parsed: { targetSeat: null },
        duration: Date.now() - startTime,
      },
      error: String(error),
    });
    return null;
  }
}
