/**
 * 游戏状态机 - 使用 jotai 实现
 * 清晰定义所有游戏阶段和转换逻辑
 */

import { atom } from "jotai";
import { isWolfRole, type GameState, type Phase, type Player, type Role } from "@/types/game";
import { createInitialGameState } from "@/lib/game-master";
import { getI18n } from "@/i18n/translator";
import { effectiveRules } from "@/lib/house-rules";

// ============ 游戏状态持久化配置 ============

const GAME_STATE_STORAGE_KEY = "meowcha.game_state";
const GAME_STATE_VERSION = 1;
const GAME_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface PersistedGameState {
  version: number;
  state: GameState;
  savedAt: number;
}

const IN_PROGRESS_PHASES: Phase[] = [
  "NIGHT_START",
  "NIGHT_GUARD_ACTION",
  "NIGHT_WOLF_ACTION",
  "NIGHT_WITCH_ACTION",
  "NIGHT_SEER_ACTION",
  "NIGHT_RESOLVE",
  "DAY_START",
  "DAY_BADGE_SIGNUP",
  "DAY_BADGE_SPEECH",
  "DAY_BADGE_ELECTION",
  "DAY_PK_SPEECH",
  "DAY_SPEECH",
  "DAY_LAST_WORDS",
  "DAY_VOTE",
  "DAY_RESOLVE",
  "BADGE_TRANSFER",
  "HUNTER_SHOOT",
  "WHITE_WOLF_KING_BOOM",
];

export function isGameInProgress(state: GameState | null | undefined): boolean {
  if (!state) return false;
  return IN_PROGRESS_PHASES.includes(state.phase);
}

function isPhaseActionCompleted(state: GameState): boolean {
  switch (state.phase) {
    case "NIGHT_START":
    case "DAY_START":
    case "DAY_BADGE_SIGNUP":
      return true;

    case "NIGHT_GUARD_ACTION": {
      const guard = state.players.find((p: Player) => p.role === "Guard" && p.alive);
      return !guard || state.nightActions.guardTarget !== undefined;
    }

    case "NIGHT_WOLF_ACTION": {
      const aliveWolves = state.players.filter((p: Player) => isWolfRole(p.role) && p.alive);
      if (aliveWolves.length === 0) return true;
      return state.nightActions.wolfTarget !== undefined;
    }

    case "NIGHT_WITCH_ACTION": {
      const witch = state.players.find((p: Player) => p.role === "Witch" && p.alive);
      if (!witch) return true;
      if (state.roleAbilities.witchHealUsed && state.roleAbilities.witchPoisonUsed) return true;
      return (
        state.nightActions.witchSave !== undefined ||
        state.nightActions.witchPoison !== undefined
      );
    }

    case "NIGHT_SEER_ACTION": {
      const seer = state.players.find((p: Player) => p.role === "Seer" && p.alive);
      return !seer || state.nightActions.seerTarget !== undefined;
    }

    case "DAY_BADGE_ELECTION": {
      const candidates = Array.isArray(state.badge?.candidates) ? state.badge.candidates : [];
      const voterIds = state.players
        .filter((p: Player) => p.alive && !candidates.includes(p.seat))
        .map((p: Player) => p.playerId);
      if (voterIds.length === 0) return true;
      return voterIds.every((id: string) => typeof state.badge?.votes?.[id] === "number");
    }

    case "DAY_VOTE": {
      const pkTargets =
        state.pkSource === "vote" && Array.isArray(state.pkTargets) ? state.pkTargets : [];
      const revealedIdiotId =
        state.roleAbilities.idiotRevealed && effectiveRules(state.houseRules).idiotRevealedLosesVote
          ? state.players.find((p: Player) => p.role === "Idiot" && p.alive)?.playerId
          : undefined;
      const voterIds = state.players
        .filter((p: Player) => p.alive && !pkTargets.includes(p.seat) && p.playerId !== revealedIdiotId)
        .map((p: Player) => p.playerId);
      if (voterIds.length === 0) return true;
      return voterIds.every((id: string) => typeof state.votes[id] === "number");
    }

    case "DAY_BADGE_SPEECH":
    case "DAY_PK_SPEECH":
    case "DAY_SPEECH":
    case "DAY_LAST_WORDS":
      return true;

    case "NIGHT_RESOLVE":
    case "DAY_RESOLVE":
    case "BADGE_TRANSFER":
    case "HUNTER_SHOOT":
      return false;

    default:
      return false;
  }
}

export function getRestorePhase(state: GameState): Phase {
  if (isPhaseActionCompleted(state)) {
    return state.phase;
  }

  switch (state.phase) {
    case "NIGHT_GUARD_ACTION":
      return "NIGHT_START";
    case "NIGHT_WOLF_ACTION": {
      const guard = state.players.find((p: Player) => p.role === "Guard" && p.alive);
      if (!guard || state.nightActions.guardTarget !== undefined) {
        return "NIGHT_GUARD_ACTION";
      }
      return "NIGHT_START";
    }
    case "NIGHT_WITCH_ACTION":
      if (state.nightActions.wolfTarget !== undefined) {
        return "NIGHT_WOLF_ACTION";
      }
      return "NIGHT_START";
    case "NIGHT_SEER_ACTION": {
      const witch = state.players.find((p: Player) => p.role === "Witch" && p.alive);
      const witchDone =
        !witch ||
        (state.roleAbilities.witchHealUsed && state.roleAbilities.witchPoisonUsed) ||
        state.nightActions.witchSave !== undefined ||
        state.nightActions.witchPoison !== undefined;
      if (witchDone) {
        return "NIGHT_WITCH_ACTION";
      }
      if (state.nightActions.wolfTarget !== undefined) {
        return "NIGHT_WOLF_ACTION";
      }
      return "NIGHT_START";
    }
    case "NIGHT_RESOLVE":
      return "NIGHT_SEER_ACTION";
    case "DAY_SPEECH":
    case "DAY_BADGE_SIGNUP":
    case "DAY_BADGE_SPEECH":
    case "DAY_BADGE_ELECTION":
    case "DAY_PK_SPEECH":
    case "DAY_VOTE":
    case "DAY_LAST_WORDS":
    case "DAY_RESOLVE":
    case "BADGE_TRANSFER":
    case "HUNTER_SHOOT":
      return "DAY_START";
    default:
      return state.phase;
  }
}

const VALID_PHASES: readonly string[] = [
  "LOBBY", "SETUP",
  "NIGHT_START", "NIGHT_GUARD_ACTION", "NIGHT_WOLF_ACTION",
  "NIGHT_WITCH_ACTION", "NIGHT_SEER_ACTION", "NIGHT_RESOLVE",
  "DAY_START", "DAY_BADGE_SIGNUP", "DAY_BADGE_SPEECH", "DAY_BADGE_ELECTION",
  "DAY_PK_SPEECH", "DAY_SPEECH", "DAY_LAST_WORDS", "DAY_VOTE", "DAY_RESOLVE",
  "BADGE_TRANSFER", "HUNTER_SHOOT", "WHITE_WOLF_KING_BOOM", "GAME_END",
] as const;

function isValidGameState(state: unknown): state is GameState {
  if (!state || typeof state !== "object") return false;
  const s = state as Record<string, unknown>;
  if (typeof s.phase !== "string" || !VALID_PHASES.includes(s.phase)) return false;
  if (!Array.isArray(s.players)) return false;
  if (typeof s.day !== "number") return false;
  return true;
}

function normalizeGameState(state: GameState): GameState {
  const initial = createInitialGameState();
  return {
    ...initial,
    ...state,
    gameId: state.gameId || initial.gameId,
    phase: state.phase || initial.phase,
    day: typeof state.day === "number" && Number.isFinite(state.day) ? state.day : initial.day,
    difficulty: state.difficulty || initial.difficulty,
    players: Array.isArray(state.players) ? state.players : initial.players,
    events: Array.isArray(state.events) ? state.events : initial.events,
    messages: Array.isArray(state.messages) ? state.messages : initial.messages,
    votes: state.votes && typeof state.votes === "object" ? state.votes : initial.votes,
    voteHistory: state.voteHistory && typeof state.voteHistory === "object" ? state.voteHistory : initial.voteHistory,
    dailySummaries: state.dailySummaries && typeof state.dailySummaries === "object" ? state.dailySummaries : initial.dailySummaries,
    dailySummaryFacts: state.dailySummaryFacts && typeof state.dailySummaryFacts === "object" ? state.dailySummaryFacts : initial.dailySummaryFacts,
    badge: state.badge && typeof state.badge === "object" ? {
      ...initial.badge,
      ...state.badge,
    } : initial.badge,
    nightActions: state.nightActions && typeof state.nightActions === "object" ? state.nightActions : initial.nightActions,
    roleAbilities: state.roleAbilities && typeof state.roleAbilities === "object" ? {
      ...initial.roleAbilities,
      ...state.roleAbilities,
    } : initial.roleAbilities,
    winner: state.winner ?? null,
  };
}

function loadPersistedGameState(): GameState {
  const initial = createInitialGameState();
  if (typeof window === "undefined") return initial;

  try {
    const raw = localStorage.getItem(GAME_STATE_STORAGE_KEY);
    if (!raw) return initial;

    const parsed: PersistedGameState = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object" || parsed.version !== GAME_STATE_VERSION) {
      localStorage.removeItem(GAME_STATE_STORAGE_KEY);
      return initial;
    }

    const age = Date.now() - parsed.savedAt;
    if (age > GAME_STATE_MAX_AGE_MS) {
      console.info("[meowcha] Saved game state expired, starting fresh");
      localStorage.removeItem(GAME_STATE_STORAGE_KEY);
      return initial;
    }

    if (!isValidGameState(parsed.state)) {
      console.warn("[meowcha] Invalid saved game state structure");
      localStorage.removeItem(GAME_STATE_STORAGE_KEY);
      return initial;
    }

    if (!isGameInProgress(parsed.state)) {
      localStorage.removeItem(GAME_STATE_STORAGE_KEY);
      return initial;
    }

    if (parsed.state.players.length === 0) {
      localStorage.removeItem(GAME_STATE_STORAGE_KEY);
      return initial;
    }

    const savedState = normalizeGameState(parsed.state);
    const restorePhase = getRestorePhase(savedState);

    if (restorePhase !== savedState.phase) {
      console.info(`[meowcha] Phase ${savedState.phase} action incomplete, restoring to ${restorePhase}`);
      const restoredState = { ...savedState, phase: restorePhase };
      console.info(`[meowcha] Restoring game at phase ${restorePhase} (rolled back from ${savedState.phase})`);
      return restoredState;
    }

    console.info(`[meowcha] Restoring game at phase ${parsed.state.phase}`);
    return savedState;
  } catch (error) {
    console.error("[meowcha] Failed to load saved game state:", error);
    try {
      localStorage.removeItem(GAME_STATE_STORAGE_KEY);
    } catch {
      // Ignore
    }
    return initial;
  }
}

const SPEECH_SAVE_THROTTLE_MS = 3000;
let lastSpeechSaveTimestamp = 0;
let pendingSpeechSaveTimer: ReturnType<typeof setTimeout> | null = null;

const THROTTLED_SAVE_PHASES: Phase[] = [
  "DAY_BADGE_SPEECH",
  "DAY_PK_SPEECH",
  "DAY_SPEECH",
  "DAY_LAST_WORDS",
];

function saveGameState(state: GameState): void {
  if (typeof window === "undefined") return;

  if (!isGameInProgress(state)) {
    if (pendingSpeechSaveTimer !== null) {
      clearTimeout(pendingSpeechSaveTimer);
      pendingSpeechSaveTimer = null;
    }
    try {
      localStorage.removeItem(GAME_STATE_STORAGE_KEY);
    } catch {
      // Ignore
    }
    return;
  }

  if (!isPhaseActionCompleted(state)) {
    return;
  }

  if (THROTTLED_SAVE_PHASES.includes(state.phase) && state.phase !== "DAY_LAST_WORDS") {
    const now = Date.now();
    const elapsed = now - lastSpeechSaveTimestamp;

    if (elapsed < SPEECH_SAVE_THROTTLE_MS) {
      if (pendingSpeechSaveTimer !== null) {
        clearTimeout(pendingSpeechSaveTimer);
      }
      pendingSpeechSaveTimer = setTimeout(() => {
        pendingSpeechSaveTimer = null;
        doSaveGameState(state);
        lastSpeechSaveTimestamp = Date.now();
      }, SPEECH_SAVE_THROTTLE_MS - elapsed);
      return;
    }

    lastSpeechSaveTimestamp = now;
  }

  if (pendingSpeechSaveTimer !== null) {
    clearTimeout(pendingSpeechSaveTimer);
    pendingSpeechSaveTimer = null;
  }

  doSaveGameState(state);
}

function doSaveGameState(state: GameState): void {
  if (!isGameInProgress(state)) return;

  try {
    const persisted: PersistedGameState = {
      version: GAME_STATE_VERSION,
      state,
      savedAt: Date.now(),
    };
    localStorage.setItem(GAME_STATE_STORAGE_KEY, JSON.stringify(persisted));
    console.debug(`[meowcha] Saved checkpoint at ${state.phase}, day ${state.day}`);
  } catch (error) {
    console.error("[meowcha] Failed to save game state:", error);
  }
}

export function clearPersistedGameState(): void {
  if (typeof window === "undefined") return;
  if (pendingSpeechSaveTimer !== null) {
    clearTimeout(pendingSpeechSaveTimer);
    pendingSpeechSaveTimer = null;
  }
  try {
    localStorage.removeItem(GAME_STATE_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

// ============ 基础状态 Atoms ============

// 持久化存储
// 说明：原来这里还有一个 humanNameAtom（jotai atomWithStorage 抢了和
// hooks/useGameLogic.ts 里 ahooks useLocalStorageState 同一个 key "meowcha_human_name"）。
// 两套序列化方式不一致（jotai 走 JSON，ahooks 容错读取），且该 atom 全项目无人使用，
// 属于死代码 + 报错来源，2026-10-17 删除。
export const apiKeyConfirmedAtom = atom(false);

// 游戏核心状态 - with localStorage persistence
const rawGameStateAtom = atom<GameState>(loadPersistedGameState());

export const gameStateAtom = atom(
  (get) => get(rawGameStateAtom),
  (get, set, update: GameState | ((prev: GameState) => GameState)) => {
    const prev = get(rawGameStateAtom);
    const next = typeof update === "function" ? update(prev) : update;
    set(rawGameStateAtom, next);
    saveGameState(next);
  }
);

// UI 状态
export const uiStateAtom = atom({
  isLoading: false,
  isWaitingForAI: false,
  showTable: false,
  selectedSeat: null as number | null,
  showRoleReveal: false,
  showLog: false,
});

// 当前对话状态
export interface DialogueState {
  speaker: string;
  text: string;
  isStreaming: boolean;
}
export const dialogueAtom = atom<DialogueState | null>(null);

// 输入文本
export const inputTextAtom = atom("");

// ============ 派生状态 Atoms ============

// 人类玩家
export const humanPlayerAtom = atom((get) => {
  const gameState = get(gameStateAtom);
  return gameState.players.find((p) => p.isHuman) || null;
});

// 是否夜晚
export const isNightAtom = atom((get) => {
  const gameState = get(gameStateAtom);
  return gameState.phase.includes("NIGHT");
});

// 存活玩家
export const alivePlayersAtom = atom((get) => {
  const gameState = get(gameStateAtom);
  return gameState.players.filter((p) => p.alive);
});

// AI 玩家（排除人类）
export const aiPlayersAtom = atom((get) => {
  const gameState = get(gameStateAtom);
  return gameState.players.filter((p) => !p.isHuman);
});

// ============ 阶段相关逻辑 ============

// 阶段配置 - 定义每个阶段的行为
export interface PhaseConfig {
  phase: Phase;
  description: string;
  humanDescription?: (humanPlayer: Player | null, gameState: GameState) => string;
  requiresHumanInput: (humanPlayer: Player | null, gameState: GameState) => boolean;
  canSelectPlayer: (humanPlayer: Player | null, targetPlayer: Player, gameState: GameState) => boolean;
  actionType: "none" | "speech" | "vote" | "night_action" | "special";
}

export const PHASE_CONFIGS: Record<Phase, PhaseConfig> = {
  LOBBY: {
    phase: "LOBBY",
    description: "phase.lobby.description",
    requiresHumanInput: () => false,
    canSelectPlayer: () => false,
    actionType: "none",
  },
  SETUP: {
    phase: "SETUP",
    description: "phase.setup.description",
    requiresHumanInput: () => false,
    canSelectPlayer: () => false,
    actionType: "none",
  },
  NIGHT_START: {
    phase: "NIGHT_START",
    description: "phase.nightStart.description",
    requiresHumanInput: () => false,
    canSelectPlayer: () => false,
    actionType: "none",
  },
  NIGHT_GUARD_ACTION: {
    phase: "NIGHT_GUARD_ACTION",
    description: "phase.nightGuard.description",
    humanDescription: (hp) => {
      const { t } = getI18n();
      return hp?.role === "Guard" ? t("phase.nightGuard.human") : t("phase.nightGuard.description");
    },
    requiresHumanInput: (hp, gs) => {
      // 喵杀修复（2026-10-18 · 站长实测）：本夜已守护过就不该再要人类输入 ——
      // 原先只看角色，于是神职行动后 UI 仍停在「选择目标」，配合「夜晚等待状态」卡片
      // （那一屏没有可点的对话框）直接卡死。
      if (!hp?.alive || hp?.role !== "Guard") return false;
      return gs.nightActions.guardTarget === undefined;
    },
    canSelectPlayer: (hp, target, gs) => {
      if (!hp || hp.role !== "Guard" || !target.alive) return false;
      // 不能连续保护同一人
      if (gs.nightActions.lastGuardTarget === target.seat) return false;
      return true;
    },
    actionType: "night_action",
  },
  NIGHT_WOLF_ACTION: {
    phase: "NIGHT_WOLF_ACTION",
    description: "phase.nightWolf.description",
    humanDescription: (hp) => {
      const { t } = getI18n();
      return isWolfRole(hp?.role) ? t("phase.nightWolf.human") : t("phase.nightWolf.description");
    },
    requiresHumanInput: (hp, gs) => {
      // 喵杀修复（2026-10-18 · 站长实测）：本夜刀口已定 → 不再需要人类输入（避免神职行动后仍停在选择态）
      if (!hp?.alive || !isWolfRole(hp?.role)) return false;
      return gs.nightActions.wolfTarget === undefined;
    },
    canSelectPlayer: (hp, target) => {
      if (!hp || !isWolfRole(hp.role) || !target.alive) return false;
      // 狼人可以刀任何存活玩家（包括队友和自己）
      return true;
    },
    actionType: "night_action",
  },
  NIGHT_WITCH_ACTION: {
    phase: "NIGHT_WITCH_ACTION",
    description: "phase.nightWitch.description",
    humanDescription: (hp) => {
      const { t } = getI18n();
      return hp?.role === "Witch" ? t("phase.nightWitch.human") : t("phase.nightWitch.description");
    },
    requiresHumanInput: (hp, gs) => {
      if (!hp?.alive || hp?.role !== "Witch") return false;
      return !gs.roleAbilities.witchHealUsed || !gs.roleAbilities.witchPoisonUsed;
    },
    canSelectPlayer: (hp, target, gs) => {
      if (!hp || hp.role !== "Witch" || !target.alive) return false;
      // 毒药已用则不能选
      if (gs.roleAbilities.witchPoisonUsed) return false;
      return true;
    },
    actionType: "special",
  },
  NIGHT_SEER_ACTION: {
    phase: "NIGHT_SEER_ACTION",
    description: "phase.nightSeer.description",
    humanDescription: (hp) => {
      const { t } = getI18n();
      return hp?.role === "Seer" ? t("phase.nightSeer.human") : t("phase.nightSeer.description");
    },
    requiresHumanInput: (hp, gs) => {
      // 喵杀修复（2026-10-18 · 站长实测）：本夜已查验过 → 不再需要人类输入。
      // 站长实测现象：人类预言家查验后，界面仍显示「点击玩家卡片 选择查验目标」＋
      // 「预言家请睁眼」等待卡片，没有任何可点的继续入口 → 卡死。
      if (!hp?.alive || hp?.role !== "Seer") return false;
      return gs.nightActions.seerTarget === undefined;
    },
    canSelectPlayer: (hp, target, gs) => {
      // 喵杀修复（十七轮 · 站长联机实测）：原先用 `target.isHuman` 当作「不能选自己」，
      // 单机时 isHuman 只有本机那一位、恰好等价；联机时另一位真人也是 isHuman，
      // 于是「客人想验/投/移交房主」全部点不动 → 关键选择卡死。改为按座位排除自己。
      if (!hp || hp.role !== "Seer" || !target.alive || target.seat === hp.seat) return false;
      // Seer can only check once per night
      if (gs.nightActions.seerTarget !== undefined) return false;
      return true;
    },
    actionType: "night_action",
  },
  NIGHT_RESOLVE: {
    phase: "NIGHT_RESOLVE",
    description: "phase.nightResolve.description",
    requiresHumanInput: () => false,
    canSelectPlayer: () => false,
    actionType: "none",
  },
  DAY_START: {
    phase: "DAY_START",
    description: "phase.dayStart.description",
    requiresHumanInput: () => false,
    canSelectPlayer: () => false,
    actionType: "none",
  },
  DAY_BADGE_SIGNUP: {
    phase: "DAY_BADGE_SIGNUP",
    description: "phase.badgeSignup.description",
    humanDescription: (hp, gs) => {
      const { t } = getI18n();
      return hp?.alive && typeof gs.badge.signup?.[hp.playerId] !== "boolean"
        ? t("phase.badgeSignup.human")
        : t("phase.badgeSignup.description");
    },
    requiresHumanInput: (hp, gs) => hp?.alive && typeof gs.badge.signup?.[hp.playerId] !== "boolean" || false,
    canSelectPlayer: () => false,
    actionType: "special",
  },
  DAY_BADGE_SPEECH: {
    phase: "DAY_BADGE_SPEECH",
    description: "phase.badgeSpeech.description",
    humanDescription: (hp, gs) => {
      const { t } = getI18n();
      return gs.currentSpeakerSeat === hp?.seat
        ? t("phase.speechYourTurn")
        : t("phase.badgeSpeech.description");
    },
    requiresHumanInput: (hp, gs) => hp?.alive && gs.currentSpeakerSeat === hp?.seat || false,
    canSelectPlayer: () => false,
    actionType: "speech",
  },
  DAY_BADGE_ELECTION: {
    phase: "DAY_BADGE_ELECTION",
    description: "phase.badgeElection.description",
    humanDescription: (hp, gs) => {
      const { t } = getI18n();
      const candidates = gs.badge.candidates || [];
      if (candidates.length === 0) return t("phase.badgeElection.description");
      if (hp && candidates.includes(hp.seat)) return t("phase.badgeElection.noVote");
      return hp?.alive && typeof gs.badge.votes[hp.playerId] !== "number"
        ? t("phase.badgeElection.human")
        : t("phase.badgeElection.description");
    },
    requiresHumanInput: (hp, gs) => {
      if (!hp?.alive) return false;
      // 候选人不需要投票
      const candidates = gs.badge.candidates || [];
      if (candidates.length === 0) return false;
      if (candidates.includes(hp.seat)) return false;
      return typeof gs.badge.votes[hp.playerId] !== "number";
    },
    canSelectPlayer: (hp, target, gs) => {
      if (!hp?.alive || !target.alive) return false;
      // 只能排除「自己」，不能排除另一位真人（联机修复，同上）
      if (target.seat === hp.seat) return false;
      // 候选人不能投票
      const candidates = gs.badge.candidates || [];
      if (candidates.length === 0) return false;
      if (candidates.includes(hp.seat)) return false;
      if (typeof gs.badge.votes[hp.playerId] === "number") return false;
      if (candidates.length > 0 && !candidates.includes(target.seat)) return false;
      return true;
    },
    actionType: "vote",
  },
  DAY_PK_SPEECH: {
    phase: "DAY_PK_SPEECH",
    description: "phase.pkSpeech.description",
    humanDescription: (hp, gs) => {
      const { t } = getI18n();
      return gs.currentSpeakerSeat === hp?.seat ? t("phase.speechYourTurn") : t("phase.pkSpeech.description");
    },
    requiresHumanInput: (hp, gs) => hp?.alive && gs.currentSpeakerSeat === hp?.seat || false,
    // 喵杀（2026-10-17）：白狼王是人类时，白天发言阶段可点选「自爆要带走的人」
    canSelectPlayer: (hp, p, gs) =>
      !!hp &&
      hp.alive &&
      hp.role === "WhiteWolfKing" &&
      p.alive &&
      p.seat !== hp.seat &&
      !gs.roleAbilities.whiteWolfKingBoomUsed &&
      effectiveRules(gs.houseRules).whiteWolfKingCanBoom,
    actionType: "speech",
  },
  DAY_SPEECH: {
    phase: "DAY_SPEECH",
    description: "phase.daySpeech.description",
    humanDescription: (hp, gs) => {
      const { t } = getI18n();
      return gs.currentSpeakerSeat === hp?.seat ? t("phase.speechYourTurn") : t("phase.daySpeech.description");
    },
    requiresHumanInput: (hp, gs) => hp?.alive && gs.currentSpeakerSeat === hp?.seat || false,
    // 喵杀（2026-10-17）：白狼王是人类时，白天发言阶段可点选「自爆要带走的人」
    canSelectPlayer: (hp, p, gs) =>
      !!hp &&
      hp.alive &&
      hp.role === "WhiteWolfKing" &&
      p.alive &&
      p.seat !== hp.seat &&
      !gs.roleAbilities.whiteWolfKingBoomUsed &&
      effectiveRules(gs.houseRules).whiteWolfKingCanBoom,
    actionType: "speech",
  },
  DAY_LAST_WORDS: {
    phase: "DAY_LAST_WORDS",
    description: "phase.lastWords.description",
    requiresHumanInput: (hp, gs) => gs.currentSpeakerSeat === hp?.seat || false,
    canSelectPlayer: () => false,
    actionType: "speech",
  },
  DAY_VOTE: {
    phase: "DAY_VOTE",
    description: "phase.dayVote.description",
    humanDescription: (hp, gs) => {
      const { t } = getI18n();
      // PK投票时，参与PK的人不能投票
      if (gs.pkSource === "vote" && Array.isArray(gs.pkTargets) && gs.pkTargets.length > 0) {
        if (hp && gs.pkTargets.includes(hp.seat)) {
          return t("phase.dayVote.noVotePk");
        }
      }
      return hp?.alive && typeof gs.votes[hp?.playerId || ""] !== "number"
        ? t("phase.dayVote.human")
        : t("phase.dayVote.description");
    },
    requiresHumanInput: (hp, gs) => {
      if (!hp?.alive) return false;
      // PK投票时，参与PK的人不需要投票
      if (gs.pkSource === "vote" && Array.isArray(gs.pkTargets) && gs.pkTargets.length > 0) {
        if (gs.pkTargets.includes(hp.seat)) return false;
      }
      return typeof gs.votes[hp?.playerId || ""] !== "number";
    },
    canSelectPlayer: (hp, target, gs) => {
      // 联机修复：原先 target.isHuman 会把另一位真人一起排除 → 朋友投不了房主（本次卡死的直接原因）
      if (!hp?.alive || !target.alive || target.seat === hp.seat) return false;
      if (typeof gs.votes[hp.playerId] === "number") return false;
      // PK投票时，参与PK的人不能投票
      if (gs.pkSource === "vote" && Array.isArray(gs.pkTargets) && gs.pkTargets.length > 0) {
        if (gs.pkTargets.includes(hp.seat)) return false;
        return gs.pkTargets.includes(target.seat);
      }
      if (gs.pkSource === "vote" && Array.isArray(gs.pkTargets) && gs.pkTargets.length === 0) {
        return false;
      }
      return true;
    },
    actionType: "vote",
  },
  DAY_RESOLVE: {
    phase: "DAY_RESOLVE",
    description: "phase.dayResolve.description",
    requiresHumanInput: () => false,
    canSelectPlayer: () => false,
    actionType: "none",
  },
  BADGE_TRANSFER: {
    phase: "BADGE_TRANSFER",
    description: "phase.badgeTransfer.description",
    humanDescription: () => {
      const { t } = getI18n();
      return t("phase.badgeTransfer.human");
    },
    requiresHumanInput: (hp, gs) => {
      // 只有当人类玩家是死亡的警长时才需要输入
      const sheriffSeat = gs.badge.holderSeat;
      return hp?.seat === sheriffSeat && !hp?.alive || false;
    },
    canSelectPlayer: (hp, target, gs) => {
      // 只能选择存活的非自己的玩家（联机修复：不能误伤另一位真人）
      if (!target.alive || target.seat === hp?.seat) return false;
      const sheriffSeat = gs.badge.holderSeat;
      if (hp?.seat !== sheriffSeat) return false;
      return true;
    },
    actionType: "vote",
  },
  WHITE_WOLF_KING_BOOM: {
    phase: "WHITE_WOLF_KING_BOOM",
    description: "白狼王自爆",
    humanDescription: () => "白狼王自爆",
    requiresHumanInput: () => false,
    canSelectPlayer: () => false,
    actionType: "none",
  },
  HUNTER_SHOOT: {
    phase: "HUNTER_SHOOT",
    description: "phase.hunterShoot.description",
    humanDescription: (hp) => {
      const { t } = getI18n();
      return hp?.role === "Hunter" ? t("phase.hunterShoot.human") : t("phase.hunterShoot.description");
    },
    requiresHumanInput: (hp, gs) => hp?.role === "Hunter" && gs.roleAbilities.hunterCanShoot || false,
    canSelectPlayer: (hp, target) => {
      // 联机修复：只能排除自己（原先 target.isHuman 会连另一位真人一起排除）
      if (!hp || hp.role !== "Hunter" || !target.alive || target.seat === hp.seat) return false;
      return true;
    },
    actionType: "night_action",
  },
  GAME_END: {
    phase: "GAME_END",
    description: "phase.gameEnd.description",
    humanDescription: (_, gs) => {
      const { t } = getI18n();
      return gs.winner === "village" ? t("phase.gameEnd.villageWin") : t("phase.gameEnd.wolfWin");
    },
    requiresHumanInput: () => false,
    canSelectPlayer: () => false,
    actionType: "none",
  },
};

// 当前阶段配置
export const currentPhaseConfigAtom = atom((get) => {
  const gameState = get(gameStateAtom);
  return PHASE_CONFIGS[gameState.phase];
});

// 当前阶段描述
export const phaseDescriptionAtom = atom((get) => {
  const { t } = getI18n();
  const gameState = get(gameStateAtom);
  const humanPlayer = get(humanPlayerAtom);
  const config = PHASE_CONFIGS[gameState.phase];
  
  if (config.humanDescription) {
    return config.humanDescription(humanPlayer, gameState);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t(config.description as any);
});

// 是否需要人类输入
export const needsHumanInputAtom = atom((get) => {
  const gameState = get(gameStateAtom);
  const humanPlayer = get(humanPlayerAtom);
  const config = PHASE_CONFIGS[gameState.phase];
  
  return config.requiresHumanInput(humanPlayer, gameState);
});

// 检查是否可以选择某个玩家
export const canSelectPlayerAtom = atom((get) => {
  const gameState = get(gameStateAtom);
  const humanPlayer = get(humanPlayerAtom);
  const config = PHASE_CONFIGS[gameState.phase];
  
  return (targetPlayer: Player) => config.canSelectPlayer(humanPlayer, targetPlayer, gameState);
});

// 当前操作类型
export const currentActionTypeAtom = atom((get) => {
  const config = get(currentPhaseConfigAtom);
  return config.actionType;
});

// ============ UI 操作 Atoms ============

// 设置选中的座位
export const setSelectedSeatAtom = atom(
  null,
  (get, set, seat: number | null) => {
    set(uiStateAtom, (prev) => ({ ...prev, selectedSeat: seat }));
  }
);

// 设置加载状态
export const setLoadingAtom = atom(
  null,
  (get, set, isLoading: boolean) => {
    set(uiStateAtom, (prev) => ({ ...prev, isLoading }));
  }
);

// 设置等待 AI 状态
export const setWaitingForAIAtom = atom(
  null,
  (get, set, isWaitingForAI: boolean) => {
    set(uiStateAtom, (prev) => ({ ...prev, isWaitingForAI }));
  }
);

// 切换日志显示
export const toggleLogAtom = atom(
  null,
  (get, set) => {
    set(uiStateAtom, (prev) => ({ ...prev, showLog: !prev.showLog }));
  }
);

// 设置角色揭示弹窗
export const setRoleRevealAtom = atom(
  null,
  (get, set, show: boolean) => {
    set(uiStateAtom, (prev) => ({ ...prev, showRoleReveal: show }));
  }
);

// 重置游戏
export const resetGameAtom = atom(null, (get, set) => {
  set(gameStateAtom, createInitialGameState());
  set(dialogueAtom, null);
  set(inputTextAtom, "");
  set(uiStateAtom, {
    isLoading: false,
    isWaitingForAI: false,
    showTable: false,
    selectedSeat: null,
    showRoleReveal: false,
    showLog: false,
  });
});

// ============ 状态机转换规则 ============

/**
 * 定义有效的阶段转换
 * key: 当前阶段
 * value: 可转换到的阶段列表
 */
export const VALID_TRANSITIONS: Record<Phase, Phase[]> = {
  LOBBY: ["SETUP"],
  SETUP: ["NIGHT_START"],
  
  // 夜晚流程: 守卫 -> 狼人 -> 女巫 -> 预言家 -> 结算
  NIGHT_START: ["NIGHT_GUARD_ACTION", "NIGHT_WOLF_ACTION"],
  NIGHT_GUARD_ACTION: ["NIGHT_WOLF_ACTION"],
  NIGHT_WOLF_ACTION: ["NIGHT_WITCH_ACTION"],
  NIGHT_WITCH_ACTION: ["NIGHT_SEER_ACTION"],
  NIGHT_SEER_ACTION: ["NIGHT_RESOLVE"],
  NIGHT_RESOLVE: ["DAY_START", "HUNTER_SHOOT", "BADGE_TRANSFER", "GAME_END"],
  
  // 白天流程: 开始 -> 发言 -> 投票 -> 结算
  DAY_START: ["DAY_BADGE_SIGNUP", "DAY_SPEECH"],
  DAY_BADGE_SIGNUP: ["DAY_BADGE_SPEECH", "DAY_SPEECH"],
  DAY_BADGE_SPEECH: ["DAY_BADGE_ELECTION"],
  DAY_BADGE_ELECTION: ["DAY_PK_SPEECH", "DAY_SPEECH"],
  DAY_PK_SPEECH: ["DAY_BADGE_ELECTION", "DAY_VOTE", "WHITE_WOLF_KING_BOOM"],
  DAY_SPEECH: ["DAY_VOTE", "WHITE_WOLF_KING_BOOM"],
  DAY_VOTE: ["DAY_RESOLVE"],
  DAY_RESOLVE: ["DAY_PK_SPEECH", "DAY_LAST_WORDS", "BADGE_TRANSFER", "NIGHT_START", "GAME_END"],
  DAY_LAST_WORDS: ["NIGHT_START", "HUNTER_SHOOT", "BADGE_TRANSFER", "GAME_END"],
  
  // 特殊阶段
  BADGE_TRANSFER: ["DAY_LAST_WORDS", "HUNTER_SHOOT", "NIGHT_START", "DAY_SPEECH", "GAME_END"],
  HUNTER_SHOOT: ["DAY_START", "NIGHT_START", "BADGE_TRANSFER", "GAME_END"],
  WHITE_WOLF_KING_BOOM: ["BADGE_TRANSFER", "DAY_LAST_WORDS", "NIGHT_START", "GAME_END"],
  GAME_END: ["LOBBY"], // 允许重新开始
};

/**
 * 检查阶段转换是否有效
 */
export function isValidTransition(from: Phase, to: Phase): boolean {
  const validTargets = VALID_TRANSITIONS[from];
  return validTargets?.includes(to) ?? false;
}

/**
 * 安全的阶段转换 atom
 * 如果转换无效，会抛出错误（开发环境）或记录警告（生产环境）
 */
export const safeTransitionAtom = atom(
  null,
  (get, set, nextPhase: Phase) => {
    const currentState = get(gameStateAtom);
    const currentPhase = currentState.phase;
    
    if (!isValidTransition(currentPhase, nextPhase)) {
      const error = `Invalid phase transition: ${currentPhase} -> ${nextPhase}`;
      if (process.env.NODE_ENV === "development") {
        console.error(error);
        // 在开发环境下仍然允许转换，但会警告
      }
      console.warn(error);
    }
    
    set(gameStateAtom, {
      ...currentState,
      phase: nextPhase,
    });
  }
);

// ============ 夜晚阶段处理 ============

/**
 * 检查某个角色是否需要在当前夜晚行动
 */
export const roleNeedsActionAtom = atom((get) => {
  const gameState = get(gameStateAtom);
  
  return (role: Role): boolean => {
    const player = gameState.players.find(p => p.role === role && p.alive);
    if (!player) return false;
    
    switch (role) {
      case "Guard":
        return true; // 守卫每晚都可以行动
      case "Werewolf":
      case "WhiteWolfKing":
        return true; // 狼人每晚都要行动
      case "Witch":
        return !gameState.roleAbilities.witchHealUsed || !gameState.roleAbilities.witchPoisonUsed;
      case "Seer":
        return true; // 预言家每晚都可以查验
      case "Hunter":
        return false; // 猎人不在夜晚行动
      default:
        return false;
    }
  };
});

/**
 * 获取下一个夜晚阶段
 */
export function getNextNightPhase(currentPhase: Phase, gameState: GameState): Phase {
  const phaseOrder: Phase[] = [
    "NIGHT_START",
    "NIGHT_GUARD_ACTION", 
    "NIGHT_WOLF_ACTION",
    "NIGHT_WITCH_ACTION",
    "NIGHT_SEER_ACTION",
    "NIGHT_RESOLVE",
  ];
  
  const currentIndex = phaseOrder.indexOf(currentPhase);
  if (currentIndex === -1 || currentIndex === phaseOrder.length - 1) {
    return "NIGHT_RESOLVE";
  }
  
  // 检查下一个阶段是否需要执行
  const nextPhase = phaseOrder[currentIndex + 1];
  
  // 如果该阶段的角色不存在或已死亡，跳过
  const roleForPhase: Record<string, Role> = {
    NIGHT_GUARD_ACTION: "Guard",
    NIGHT_WOLF_ACTION: "Werewolf",
    NIGHT_WITCH_ACTION: "Witch",
    NIGHT_SEER_ACTION: "Seer",
  };
  
  const requiredRole = roleForPhase[nextPhase];
  if (requiredRole) {
    const hasAliveRole = requiredRole === "Werewolf"
      ? gameState.players.some(p => isWolfRole(p.role) && p.alive)
      : gameState.players.some(p => p.role === requiredRole && p.alive);
    if (!hasAliveRole) {
      // 递归跳到下一个阶段
      return getNextNightPhase(nextPhase, gameState);
    }
    
    // 女巫特殊检查：两瓶药都用完则跳过
    if (requiredRole === "Witch") {
      if (gameState.roleAbilities.witchHealUsed && gameState.roleAbilities.witchPoisonUsed) {
        return getNextNightPhase(nextPhase, gameState);
      }
    }
  }
  
  return nextPhase;
}

// ============ 游戏分析 Atoms ============

import type { GameAnalysisData } from "@/types/analysis";

export const gameAnalysisAtom = atom<GameAnalysisData | null>(null);
export const analysisLoadingAtom = atom<boolean>(false);
export const analysisErrorAtom = atom<string | null>(null);
