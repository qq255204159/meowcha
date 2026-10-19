"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  Users,
  NotePencil,
  X,
  Eye,
  Skull,
  Shield,
  Drop,
  Crosshair,
  GearSix,
  BookOpen,
  PawPrint,
  SpeakerHigh,
} from "@phosphor-icons/react";
import {
  NightIcon,
  DayIcon,
  SpeechIcon,
  TimerIcon,
  SeerIcon,
  WitchIcon,
  HunterIcon,
  GuardIcon,
  VillagerIcon,
} from "@/components/icons/FlatIcons";
import { useTypewriter } from "@/hooks/useTypewriter";
import { useGameLogic } from "@/hooks/useGameLogic";
import { type Player, type Role, type DifficultyLevel, type HouseRules, type GameState, isWolfRole } from "@/types/game";
import { PHASE_CONFIGS } from "@/store/game-machine";

// Components
import { WelcomeScreen } from "@/components/game/WelcomeScreen";
import { PlayerCardCompact } from "@/components/game/PlayerCardCompact";
import { DialogArea } from "@/components/game/DialogArea";
import { Notebook } from "@/components/game/Notebook";
import { GameBackground } from "@/components/game/GameBackground";
import { PlayerDetailModal } from "@/components/game/PlayerDetailModal";
import { RoleRevealOverlay } from "@/components/game/RoleRevealOverlay";
import { NightActionOverlay, type NightActionOverlayType } from "@/components/game/NightActionOverlay";
import { TutorialOverlay, type TutorialPayload } from "@/components/game/TutorialOverlay";
import { DevConsole, DevModeButton } from "@/components/DevTools";
import { SettingsModal } from "@/components/game/SettingsModal";
import { RulesModal } from "@/components/game/RulesModal";

import { buildSimpleAvatarUrl } from "@/lib/avatar-config";
import { BRAND } from "@/lib/brand";
import { DEFAULT_SPEECH_RATE, SPEECH_RATE_OPTIONS, useSpeechRate } from "@/lib/speech-rate";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { audioManager, makeAudioTaskId } from "@/lib/audio-manager";
import { resolveVoiceId } from "@/lib/voice-constants";
import { playGunshot, playExplosion, playReveal } from "@/lib/sfx";
import { useSettings } from "@/hooks/useSettings";
import { useTutorial } from "@/hooks/useTutorial";
import { useGameAnalysis } from "@/hooks/useGameAnalysis";
import { PostGameAnalysisPage } from "@/components/analysis/PostGameAnalysisPage";
import { getI18n } from "@/i18n/translator";
import { assetPath } from "@/lib/site-path";
import { effectiveRules } from "@/lib/house-rules";
// 喵杀联机（邀请码房间）：客户端 + 大厅
import { useMeowRoom } from "@/hooks/useMeowRoom";
import { MultiplayerLobby } from "@/components/game/MultiplayerLobby";
import { buildViewsForSeats } from "@/lib/meowroom/view";
import { readInviteCodeFromUrl, getPlayerName, getSavedRoomCode } from "@/lib/meowroom/client";
import { useSetAtom } from "jotai";
import { gameStateAtom } from "@/store/game-machine";

/**
 * 联机「可读台词」判定 —— 与 DialogArea 的历史列表过滤保持一致。
 * 喵杀修复（2026-10-18 · 站长实测）：**系统旁白不算「一句台词」** —— 这是本次卡死的根因。
 * 原判定只排除结构化消息/「轮到你」/「正在组织语言」，**漏了 isSystem**，于是夜间旁白
 * （「守卫请睁眼」「狼人请睁眼」「女巫请睁眼」「预言家请睁眼」）、天亮、死讯、竞选公告
 * 全都变成了「要逐句读的台词」：联机的房主/客人必须一句句点过去，指针就卡在「狼人请睁眼」，
 * 对话框显示这一句、而历史列表被截断在指针之前 —— 站长的观感正是「一直显示狼人请睁眼、
 * 白天竞选的对话都没了」。
 * 现在：系统消息只按历史正常铺出（旁白本来就是公开信息，不需要点），逐句阅读只针对玩家发言。
 */
function isReadableDialogue(m: { content?: unknown; isSystem?: boolean }): boolean {
  const c = String(m.content || "").trim();
  if (!c) return false;
  if (m.isSystem) return false;
  if (c.startsWith("[")) return false;
  if (c.includes("轮到你发言") || c.includes("轮到你发表遗言")) return false;
  if (c.includes("正在组织语言") || c.includes("生成语音")) return false;
  return true;
}

const RITUAL_CUE_DURATION_SECONDS = 2.2;
const NIGHTFALL_CUE_REGEX = /^第\s*\d+\s*夜，天黑请闭眼$/;
// 喵杀（十七轮）：「对话后台泵」只在发言类阶段跑 —— 夜间与投票结算有自己的节拍，不能被它推。
const MP_SPEECH_PHASES = ["DAY_SPEECH", "DAY_BADGE_SPEECH", "DAY_PK_SPEECH", "DAY_LAST_WORDS"];
const DAY_NIGHT_BLINK = {
  closeMs: 360,
  holdMs: 120,
  openMs: 620,
};
// 2026-10-16 修复：原为 "/bgm/day.mp3"（缺 basePath 前缀）——实际会请求站点根 /bgm/…，
// 命中 @legacy 规则 301 到 /repo（再被闸门拦下），音频加载静默失败，这就是「没有背景音乐」的根因。
// 现改由单一常量 BASE_PATH 统一拼接前缀（见 @/lib/site-path，与 next.config.ts 的 basePath 一致）。
const dayBgm = assetPath("/bgm/day.mp3");
const nightBgm = assetPath("/bgm/night.mp3");
const REFERRAL_STORAGE_KEY = "meowcha_referral";

// 喵杀版：头像由 buildSimpleAvatarUrl 统一映射到本地萌猫插画
const avatarUrl = (seed: string) => buildSimpleAvatarUrl(seed);

const getRoleLabel = (role?: Role | null) => {
  switch (role) {
    case "Werewolf": return "狼人";
    case "Seer": return "预言家";
    case "Witch": return "女巫";
    case "Hunter": return "猎人";
    case "Guard": return "守卫";
    case "Villager": return "村民";
    // 喵杀修复：白狼王 / 白痴 原先漏了，会兜底成「?」（白狼王被查验为狼、被投出后显示不出真实身份）
    case "WhiteWolfKing": return "白狼王";
    case "Idiot": return "白痴";
    default: return "?";
  }
};

function getRitualCueFromSystemMessage(content: string): { title: string; subtitle?: string } | null {
  const text = content.trim();
  if (text === "人到齐了，开始吧。") return { title: "开局" };
  if (NIGHTFALL_CUE_REGEX.test(text)) return { title: text };
  if (text === "守卫请睁眼") return { title: text };
  if (text === "狼人请睁眼") return { title: text };
  if (text === "女巫请睁眼") return { title: text };
  if (text === "预言家请睁眼") return { title: text };
  if (text === "昨晚平安无事") return { title: "昨晚平安无事" };
  if (/^\d+号\s+.+\s+昨晚出局$/.test(text)) return { title: text };
  if (/^\d+号\s+.+\s+昨晚中毒出局$/.test(text)) return { title: text };
  if (text === "天亮了，请睁眼") return { title: "天亮了，请睁眼" };
  if (text === "进入警徽竞选报名环节") return { title: "警徽竞选报名" };
  if (text === "警徽竞选开始，请候选人依次发言") return { title: "警徽竞选开始", subtitle: "请候选人依次发言" };
  if (text === "开始警徽评选") return { title: text };
  if (text === "警徽平票，重新投票") return { title: text };
  if (/^\s*警徽授予\s*\d+号\s+.+（\d+票）\s*$/.test(text)) return { title: text };
  if (text === "开始自由发言") return { title: "开始自由发言" };
  if (text === "发言结束，开始投票。") return { title: text };
  if (/^\d+号\s+.+\s+以\s+\d+\s+票出局$/.test(text)) return { title: text };
  if (text === "票数相同，今天无人出局") return { title: text };
  return null;
}

// ============ 工具函数 ============

// ============ 主组件 ============

export default function Home() {
  const {
    humanName,
    setHumanName,
    gameStarted,
    gameState,
    isLoading,
    isWaitingForAI,
    currentDialogue,
    inputText,
    setInputText,
    showTable,
    humanPlayer,
    isNight,
    startGame,
    continueAfterRoleReveal,
    restartGame,
    handleHumanSpeech,
    handleFinishSpeaking,
    handleBadgeSignup,
    handleHumanVote,
    handleNightAction,
    handleHumanBadgeTransfer,
    handleHumanWhiteWolfKingBoom,
    handleNextRound,
    waitingForNextRound,
    scrollToBottom,
    advanceSpeech,
    applyRemoteAction,
    // 联机：上报/记录「读到哪里」（供投票前的「全员读完」门使用）
    reportReadProgress: reportReadProgressFromLogic,
    // 联机：投票门当前在等谁（显示出来，让「卡住」看得见）
    gateNotice,
    setShowTable,
    setGameStarted,
  } = useGameLogic();

  // ============ 喵杀联机（邀请码房间） ============
  const mp = useMeowRoom();
  const inviteCode = useMemo(() => readInviteCodeFromUrl(), []);
  const mpAutoClaimedRef = useRef(false);

  // 带邀请链接进来、且此前签过名 → 自动进房（省掉「填名字 → 再填码」两步）
  useEffect(() => {
    if (mpAutoClaimedRef.current || !inviteCode || mp.room) return;
    const name = getPlayerName();
    if (!name) return;
    mpAutoClaimedRef.current = true;
    void mp.joinRoom(inviteCode, name);
  }, [inviteCode, mp]);

  // 喵杀（2026-10-17）：断线重连 —— 刷新页面 / 关标签再打开后，自动重新入房并**拿回原来的座位与身份**。
  // 同一个 playerId（本机持久化）会命中房间里的既有成员 → 座位不变；房主/客人身份也随之恢复。
  // 有邀请链接时优先走上面那个 effect。
  const mpRejoinRef = useRef(false);
  useEffect(() => {
    if (mpRejoinRef.current || mp.room || inviteCode) return;
    const savedCode = getSavedRoomCode();
    const name = getPlayerName();
    if (!savedCode || !name) return;
    mpRejoinRef.current = true;
    void mp.joinRoom(savedCode, name);
  }, [mp, inviteCode]);

  // 房主页面被刷新 → 本地引擎状态丢失、本局无法续跑。这里只提示（不自动作废，避免同机双标签误伤），
  // 由房主手动「本局作废 · 回到大厅」；期间朋友那边会显示「整局暂停」。
  const [hostNeedsRecovery, setHostNeedsRecovery] = useState(false);
  useEffect(() => {
    const playing = mp.room?.data.status === "playing";
    const hasPublished = !!mp.room?.data.views || !!mp.room?.data.gameState;
    setHostNeedsRecovery(!!mp.room && mp.role === "host" && playing && !gameStarted && hasPublished);
  }, [mp.room?.data.status, mp.room?.data.views, mp.room?.data.gameState, mp.role, gameStarted]);

  // 房主在大厅点「开始游戏喵」：房间置为对局中，随后本地引擎照常开局
  //（联机关键：把房间里的真人座位与昵称交给引擎，让这些座位不再由 AI 接管）
  const handleHostStart = useCallback(async (): Promise<boolean> => {
    const room = mp.room;
    if (!room) return false;
    const roster = [...room.data.players].sort((a, b) => a.seat - b.seat);
    const ok = await mp.hostStart();
    if (!ok) return false;
    void startGame({
      playerCount: room.data.seats,
      difficulty: (room.data.options?.difficulty as DifficultyLevel) || "normal",
      houseRules: room.data.options?.houseRules as HouseRules | undefined,
      humanSeats: roster.map((p) => p.seat),
      humanNames: roster.map((p) => p.name),
    });
    return true;
  }, [mp, startGame]);

  const inLobby = !!mp.room && mp.room.data.status === "waiting";
  const isGuestPlaying = !!mp.room && mp.room.data.status === "playing" && mp.role === "guest";
  // 喵杀（十七轮 · 方向 A）：**联机对局**里，对话改成「后台照着跑 + 双方各自按历史阅读」。
  // 单机模式保持原来的「房主按 Enter 逐句推进」手感不动，避免动到主玩法。
  const isMpPlaying = !!mp.room && mp.room.data.status === "playing" && (mp.role === "host" || mp.role === "guest");

  // ---- 兜底：把「黑屏」变成「看得见的报错」 ----
  // 未捕获异常 / 未处理的 Promise 一律在屏幕上显示原文（含堆栈），方便一眼定位；
  // 只做诊断用，不改变任何业务流程。
  const [fatalError, setFatalError] = useState<string | null>(null);
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      setFatalError(
        `[未捕获异常] ${e.message}\n${e.error?.stack || "(no stack)"}\n@ ${e.filename || "?"}:${e.lineno || 0}:${e.colno || 0}`
      );
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { stack?: string; message?: string } | string;
      setFatalError(`[未处理的 Promise] ${typeof r === "string" ? r : r?.stack || r?.message || String(r)}`);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // ---- 联机 · 客人侧：把房主下发的「我这一个座位可见的局面」装进本地状态并直接上桌 ----
  // 客人端复用与主机**完全相同**的界面/动画/音效（不重写任何 UI），
  // 靠 useGameLogic 里的「客人开关」保证本地不跑引擎（AI 发言/阶段推进/投票结算一律由房主做）。
  const setGameStateAtom = useSetAtom(gameStateAtom);
  const guestViewKeyRef = useRef("");
  useEffect(() => {
    if (!isGuestPlaying || !mp.room) return;
    const key = `${mp.room.version}:${mp.seat}`;
    if (guestViewKeyRef.current === key) return;
    const view = mp.room.data.views?.[String(mp.seat)];
    if (!view) return;
    guestViewKeyRef.current = key;
    setGameStateAtom(view as GameState);
    setGameStarted(true);
    setShowTable(true);
  }, [isGuestPlaying, mp.room?.version, mp.seat, setGameStateAtom, setGameStarted, setShowTable]);

  // ---- 联机 · 客人侧：本机操作不落到本地引擎，而是发给房主（房主才是权威端） ----
  const guestSend = mp.sendAction;
  const effectiveVote: (targetSeat: number) => Promise<void> = isGuestPlaying
    ? async (targetSeat: number) => {
        const ok = await guestSend({ type: "vote", payload: { targetSeat } });
        if (!ok) toast.error("投票没发出去，请再试一次");
      }
    : handleHumanVote;
  const effectiveNightAction: (targetSeat: number, act?: "save" | "poison" | "pass") => Promise<void> =
    isGuestPlaying
      ? async (targetSeat: number, act?: "save" | "poison" | "pass") => {
          const ok = await guestSend({ type: "night_action", payload: { targetSeat, witchAction: act } });
          if (!ok) toast.error("夜间操作没发出去，请再试一次");
        }
      : handleNightAction;
  const effectiveBadgeTransfer: (targetSeat: number) => Promise<void> = isGuestPlaying
    ? async (targetSeat: number) => {
        const ok = await guestSend({ type: "badge_transfer", payload: { targetSeat } });
        if (!ok) toast.error("警徽操作没发出去，请再试一次");
      }
    : handleHumanBadgeTransfer;
  // 白狼王自爆（人类侧）——客人把操作发给房主，房主消费
  const effectiveWWKBoom: (targetSeat: number) => Promise<void> = isGuestPlaying
    ? async (targetSeat: number) => {
        const ok = await guestSend({ type: "wwk_boom", payload: { targetSeat } });
        if (!ok) toast.error("自爆操作没发出去，请再试一次");
      }
    : handleHumanWhiteWolfKingBoom;
  const effectiveSpeech: () => Promise<void> = isGuestPlaying
    ? async () => {
        const text = inputText.trim();
        if (!text) return;
        const ok = await guestSend({ type: "speech", payload: { content: text } });
        if (!ok) {
          toast.error("发言没发出去，文字已保留，请再试一次");
          return;
        }
        setInputText("");
        toast("发言已发送，正在同步…", { duration: 1200 });
      }
    : handleHumanSpeech;
  const effectiveFinishSpeaking: () => Promise<void> = isGuestPlaying
    ? async () => {
        const ok = await guestSend({ type: "finish_speech" });
        if (!ok) toast.error("结束发言没发出去，请再试一次");
      }
    : handleFinishSpeaking;
  const effectiveBadgeSignup: (wants: boolean) => Promise<void> = isGuestPlaying
    ? async (wants: boolean) => {
        const ok = await guestSend({ type: "badge_signup", payload: { content: wants ? "yes" : "no" } });
        if (!ok) toast.error("报名没发出去，请再试一次");
      }
    : handleBadgeSignup;

  // ---- 联机 · 房主侧：① 每 0.5s 把「按座位裁剪过的局面」下发 ② 消费远程真人提交的操作 ----
  const viewsRef = useRef<Record<string, unknown> | null>(null);
  /**
   * 喵杀修复（2026-10-18 · 站长实测）：投票门提示条要**两边都有**。
   * 原先只有房主本机的 gateNotice 会渲染，客人把对话快进到推不动时看不到任何提示
   *（站长实测：只有「主机(1号)」有「投票前：1号 还没发言，正在等他」）。
   * 现在房主把这条随局面一起下发（room.data.notice），客人直接读它。
   */
  const gateNoticeRef = useRef<string | null>(null);
  gateNoticeRef.current = gateNotice ?? null;
  const lastPublishedSigRef = useRef("");
  /**
   * 喵杀优化（2026-10-18 · 站长实测）：联机时把「现在到底在等谁」做成常驻状态条。
   * 之前只有投票门会显示提示，遗言/发言/投票卡住时两边都只能看到最后一句台词，
   * 无法判断是对方没说完、还是房主没点继续。
   */
  const mpStatusNotice = useMemo(() => {
    if (!isMpPlaying) return null;
    if (mp.room?.data.hostAway) return "房主切屏中，游戏可能暂停";

    const phase = gameState.phase;
    const nameOf = (seat: number | null) => {
      if (seat === null) return "";
      const p = gameState.players.find((x) => x.seat === seat);
      return p ? `${p.seat + 1}号 ${p.displayName}` : `${seat + 1}号`;
    };
    const current = gameState.players.find((p) => p.seat === gameState.currentSpeakerSeat) ?? null;
    const isMine = (p: typeof current) => !!p && p.seat === humanPlayer?.seat;

    if (phase === "DAY_LAST_WORDS") {
      if (!current) return "正在整理遗言…";
      return isMine(current)
        ? "轮到你发表遗言：输入后点「结束遗言」，60 秒后自动进入夜晚"
        : `等待 ${nameOf(current.seat)} 发表遗言`;
    }
    if (phase === "DAY_SPEECH" || phase === "DAY_BADGE_SPEECH" || phase === "DAY_PK_SPEECH") {
      if (!current) return "正在整理下一位发言者…";
      if (!current.isHuman) return `${nameOf(current.seat)} 正在发言…`;
      return isMine(current)
        ? "轮到你发言：输入后点「结束发言」"
        : `等待 ${nameOf(current.seat)} 发言`;
    }
    if (phase === "DAY_VOTE" || phase === "DAY_BADGE_ELECTION") {
      // 客人端看不到别人的票，等待信息由房主通过 room.data.notice 下发。
      if (isGuestPlaying) return null;
      const candidates = new Set(gameState.badge.candidates || []);
      const pkTargets = new Set(gameState.pkTargets || []);
      const revealedIdiotId =
        gameState.roleAbilities.idiotRevealed &&
        effectiveRules(gameState.houseRules).idiotRevealedLosesVote
          ? gameState.players.find((p) => p.role === "Idiot" && p.alive)?.playerId
          : undefined;
      const eligible = gameState.players.filter(
        (p) =>
          p.alive &&
          (phase === "DAY_VOTE" ? !pkTargets.has(p.seat) : !candidates.has(p.seat)) &&
          p.playerId !== revealedIdiotId
      );
      const pending = eligible.filter((p) => {
        const v =
          phase === "DAY_VOTE"
            ? gameState.votes[p.playerId]
            : gameState.badge.votes?.[p.playerId];
        return typeof v !== "number";
      });
      if (pending.length > 0) {
        return `等待 ${pending.map((p) => `${p.seat + 1}号`).join("、")} 投票`;
      }
      return "票已投完，等待房主确认结果";
    }
    if (phase === "DAY_RESOLVE") return "等待房主确认票型";
    if (phase === "HUNTER_SHOOT") return "等待猎人决定是否开枪";
    if (phase === "BADGE_TRANSFER") return "等待警长移交警徽";
    return null;
  }, [
    isMpPlaying,
    isGuestPlaying,
    mp.room?.data.hostAway,
    gameState.phase,
    gameState.players,
    gameState.currentSpeakerSeat,
    gameState.votes,
    gameState.badge,
    gameState.roleAbilities,
    gameState.houseRules,
    gameState.pkTargets,
    humanPlayer?.seat,
  ]);
  const mpStatusNoticeRef = useRef<string | null>(null);
  mpStatusNoticeRef.current = mpStatusNotice;
  useEffect(() => {
    if (!mp.room || mp.role !== "host" || mp.room.data.status !== "playing" || !gameStarted) {
      viewsRef.current = null;
      lastPublishedSigRef.current = "";
      return;
    }
    const seats = mp.room.data.players.map((p) => p.seat).sort((a, b) => a - b);
    viewsRef.current = buildViewsForSeats(gameState, seats) as unknown as Record<string, unknown>;
    // 局面一变就立刻下发一次（外加每 0.5s 的兜底轮询），
    // 把朋友端「慢一秒」压到半个轮询周期左右。
    const notice = gateNoticeRef.current ?? mpStatusNoticeRef.current ?? undefined;
    const sig = JSON.stringify({ views: viewsRef.current, notice });
    if (sig !== lastPublishedSigRef.current) {
      lastPublishedSigRef.current = sig;
      void mp.publishViews(viewsRef.current, { notice });
    }
  }, [gameState, mp.room?.code, mp.room?.data.status, mp.role, gameStarted, mp.publishViews]);

  useEffect(() => {
    if (!mp.room || mp.role !== "host" || mp.room.data.status !== "playing") return;
    const timer = window.setInterval(() => {
      if (viewsRef.current) {
        // 只在局面/提示真的变化时写入，避免每 0.5s 无意义地抬版本号、
        // 让客人端反复重渲染（站长反馈的「对话框时有时无」体感优化）。
        const notice = gateNoticeRef.current ?? mpStatusNoticeRef.current ?? undefined;
        const sig = JSON.stringify({ views: viewsRef.current, notice });
        if (sig === lastPublishedSigRef.current) return;
        lastPublishedSigRef.current = sig;
        void mp.publishViews(viewsRef.current, { notice });
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [mp.room?.code, mp.role, mp.room?.data.status]);

  const appliedActionIdsRef = useRef<Set<string>>(new Set());
  const roomRef = useRef(mp.room);
  roomRef.current = mp.room;
  const applyRemoteActionRef = useRef(applyRemoteAction);
  applyRemoteActionRef.current = applyRemoteAction;
  const advanceCursorRef = useRef(mp.advanceCursor);
  advanceCursorRef.current = mp.advanceCursor;
  const actionPumpRunningRef = useRef(false);
  const actionPumpAgainRef = useRef(false);

  /**
   * 喵杀修复（2026-10-18 · 站长实测）：房主消费远程操作改成**串行泵**。
   * 旧实现每 0.5s 房间版本更新就会 cleanup/cancel 上一轮 async 循环，
   * 客人的发言/投票可能被反复取消，表现为「点了半天没反应，一分钟后才出现」。
   * 现在泵只启动一次，房间更新只标记「有新数据」，不会打断正在处理的操作。
   */
  useEffect(() => {
    if (!mp.room || mp.role !== "host" || mp.room.data.status !== "playing") return;
    actionPumpAgainRef.current = true;
    if (actionPumpRunningRef.current) return;

    actionPumpRunningRef.current = true;
    void (async () => {
      try {
        while (actionPumpAgainRef.current) {
          actionPumpAgainRef.current = false;
          while (true) {
            const currentRoom = roomRef.current;
            if (!currentRoom || currentRoom.data.status !== "playing") break;
            const actions = currentRoom.data.actions || [];
            const cursor = currentRoom.data.actionCursor ?? 0;
            const next = actions
              .slice(cursor)
              .find((a) => !appliedActionIdsRef.current.has(a.id));
            if (!next) {
              if (actions.length > cursor) {
                await advanceCursorRef.current(actions.length);
              }
              break;
            }

            appliedActionIdsRef.current.add(next.id);
            try {
              await applyRemoteActionRef.current(next);
            } catch (e) {
              console.warn("[meowcha] remote action failed", e);
            }

            const latestActions = roomRef.current?.data.actions || actions;
            const index = latestActions.findIndex((a) => a.id === next.id);
            const nextCursor = index >= 0 ? index + 1 : cursor + 1;
            await advanceCursorRef.current(nextCursor);
          }
        }
      } finally {
        actionPumpRunningRef.current = false;
      }
    })();
  }, [mp.room?.version, mp.room?.data.status, mp.role]);

  // ---- 联机 · 房主侧：切屏/最小化时主动告诉朋友「我暂时不在前台」----
  // 喵杀（十七轮 · 站长实测）：浏览器会把后台标签页的定时器节流甚至整个冻结 —— 5s 心跳与
  // 0.5s 下发都会停，朋友那边几秒后就被误报「房主掉线，整局暂停」，而房主这边毫无察觉。
  // 现在：切屏瞬间打 hostAway 标记（朋友看到的是温和提示、界面不锁），回到前台立刻清标记 +
  // 补发一次局面，并在房主屏幕上提示「刚才页面被挂起」——让房主自己也知道发生了什么。
  const hostHiddenAtRef = useRef(0);
  const markHostAwayRef = useRef(mp.markHostAway);
  const publishViewsRef = useRef(mp.publishViews);
  markHostAwayRef.current = mp.markHostAway;
  publishViewsRef.current = mp.publishViews;
  useEffect(() => {
    if (mp.role !== "host" || mp.room?.data.status !== "playing") return;
    const onVisibility = () => {
      const hidden = document.visibilityState === "hidden";
      if (hidden) hostHiddenAtRef.current = Date.now();
      void markHostAwayRef.current(hidden);
      if (hidden) return;
      // 回到前台：立刻补一次局面，让朋友那边瞬间恢复
      if (viewsRef.current) void publishViewsRef.current(viewsRef.current);
      const awayMs = hostHiddenAtRef.current > 0 ? Date.now() - hostHiddenAtRef.current : 0;
      hostHiddenAtRef.current = 0;
      if (awayMs > 4000) {
        toast("已恢复同步喵", {
          description: `刚才页面被挂起了约 ${Math.round(awayMs / 1000)} 秒，朋友那边会短暂等待（不是掉线）。`,
        });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [mp.role, mp.room?.code, mp.room?.data.status]);

  // ---- 联机 · 房主侧：「对话后台泵」（十七轮 · 方向 A）----
  // 让引擎**不跟着任何人的阅读速度走**：只要处在发言阶段、没在等「先看票型再确认」这个节拍，
  // 就每隔约 1.1s 把 AI 发言的分段持续写进消息记录；房主与朋友各自按历史读，日志始终跑在读者前面，
  // 正常阅读速度下「读下一句」就不用再等 AI 思考。夜间与投票结算有自己的节拍，这个泵一律不碰。
  const pumpRef = useRef({ phase: gameState.phase, waitingForNextRound, advanceSpeech, handleNextRound });
  pumpRef.current = { phase: gameState.phase, waitingForNextRound, advanceSpeech, handleNextRound };
  useEffect(() => {
    if (mp.role !== "host" || mp.room?.data.status !== "playing") return;
    const timer = window.setInterval(() => {
      const p = pumpRef.current;
      if (!MP_SPEECH_PHASES.includes(p.phase)) return;
      if (p.waitingForNextRound) return;
      void (async () => {
        const r = await p.advanceSpeech();
        if (r?.shouldAdvanceToNextSpeaker) await p.handleNextRound();
      })();
    }, 1100);
    return () => window.clearInterval(timer);
  }, [mp.role, mp.room?.code, mp.room?.data.status]);

  const { settings, setBgmVolume, setSoundEnabled, setAiVoiceEnabled } = useSettings();
  const { bgmVolume, isSoundEnabled, isAiVoiceEnabled, isGenshinMode } = settings;
  const shouldUseAiVoice = isSoundEnabled && isAiVoiceEnabled && bgmVolume > 0;

  // ---- 联机对局：本地「对话阅读指针」（十七轮 · 方向 A）----
  // 站长的设计：**关键选择同步，对话则「后台照着跑 + 各人按历史自己读」**。
  // 房主浏览器仍在跑引擎，但引擎不再跟着某个人的阅读速度走（见下面的「后台泵」），
  // 而是把 AI 发言持续写进消息记录；房主与客人**各自**维护一个「读到第几句」的指针，
  // 按自己的节奏逐句读/听，最多可以快推到「当前已生成」的位置，谁停下都不影响对方。
  // 语音复用同一套 TTS：历史台词按 (voiceId, text) 命中缓存，不会重新生成。
  const readableMessages = useMemo(() => {
    if (!isMpPlaying) return [];
    return gameState.messages.filter(isReadableDialogue);
  }, [isMpPlaying, gameState.messages]);

  const [readPointer, setReadPointer] = useState(0);
  const readGameIdRef = useRef<string | null>(null);
  const readContextRef = useRef<string>("");
  useEffect(() => {
    if (!isMpPlaying) {
      readGameIdRef.current = null;
      readContextRef.current = "";
      setReadPointer(0);
      return;
    }
    const gid = gameState.gameId || "";
    if (!gid) return;
    if (readGameIdRef.current === gid) return;
    // 第一次拿到本局局面：把「此刻已有的消息」当作历史直接跳过（对局中途重连不重放旧台词），
    // 之后的台词按自己的节奏逐句读/听。
    readGameIdRef.current = gid;
    readContextRef.current = `${gameState.day}:${gameState.phase}`;
    setReadPointer(readableMessages.length);
  }, [isMpPlaying, gameState.gameId, gameState.day, gameState.phase, readableMessages.length]);

  /**
   * 换天/换阶段时把本机阅读指针推到新阶段的第一句。
   * 否则警长投票结束后，朋友端可能还在慢慢读竞选发言，界面就像“竞选又重播了一遍”；
   * 第二天也可能停在第一天的旧台词上。旧历史仍保留在滚动记录里。
   */
  useEffect(() => {
    if (!isMpPlaying) return;
    const key = `${gameState.day}:${gameState.phase}`;
    if (!readContextRef.current) {
      readContextRef.current = key;
      return;
    }
    if (readContextRef.current === key) return;
    readContextRef.current = key;

    const firstNewContextIndex = gameState.messages.findIndex(
      (m) =>
        m.day === gameState.day &&
        m.phase === gameState.phase &&
        isReadableDialogue(m)
    );
    if (firstNewContextIndex < 0) {
      setReadPointer(readableMessages.length);
      return;
    }
    let readableBefore = 0;
    for (let i = 0; i < firstNewContextIndex; i++) {
      if (isReadableDialogue(gameState.messages[i])) readableBefore += 1;
    }
    setReadPointer(readableBefore);
  }, [
    isMpPlaying,
    gameState.day,
    gameState.phase,
    gameState.messages,
    readableMessages.length,
  ]);

  const pendingMessage = isMpPlaying && readPointer < readableMessages.length
    ? readableMessages[readPointer]
    : null;

  /** 本机真人还有没有「别人（非自己）说的话」没读到 —— 用来决定「轮到你发言」的输入框什么时候露出 */
  const unreadFromOthers = useMemo(() => {
    if (!isMpPlaying) return false;
    const myId = humanPlayer?.playerId;
    for (let i = readPointer; i < readableMessages.length; i++) {
      const m = readableMessages[i];
      if (!myId || m.playerId !== myId) return true;
    }
    return false;
  }, [isMpPlaying, readPointer, readableMessages, humanPlayer?.playerId]);

  /**
   * 本机当前是否轮到真人发言。
   * 单独抽出来给「玩家卡片高亮」和输入框共用，保证两边判断一致。
   */
  const humanTurnSeat = useMemo(() => {
    const speechPhase =
      gameState.phase === "DAY_SPEECH" ||
      gameState.phase === "DAY_LAST_WORDS" ||
      gameState.phase === "DAY_BADGE_SPEECH" ||
      gameState.phase === "DAY_PK_SPEECH";
    if (!speechPhase) return null;
    if (gameState.currentSpeakerSeat !== humanPlayer?.seat) return null;
    if (!(gameState.phase === "DAY_LAST_WORDS" || !!humanPlayer?.alive)) return null;
    if (waitingForNextRound) return null;
    if (isMpPlaying && unreadFromOthers && gameState.phase !== "DAY_LAST_WORDS") return null;
    return humanPlayer?.seat ?? null;
  }, [
    gameState.phase,
    gameState.currentSpeakerSeat,
    humanPlayer?.seat,
    humanPlayer?.alive,
    waitingForNextRound,
    isMpPlaying,
    unreadFromOthers,
  ]);

  /** 本机「未读条数」（0 = 已把已生成的台词全部读完）—— 上报给房主，用于投票前「等所有人读完」这道门 */
  const localUnread = isMpPlaying ? Math.max(0, readableMessages.length - readPointer) : 0;
  const localUnreadRef = useRef(0);
  localUnreadRef.current = localUnread;
  const reportReadProgress = reportReadProgressFromLogic; // useGameLogic 提供：写入本机（房主）/ 记录远程上报

  useEffect(() => {
    if (!isMpPlaying) return;
    // 房主：本机进度直接写进去；客人：既写本地，也随心跳发给房主（房主是权威端）
    reportReadProgress(localUnread);
  }, [isMpPlaying, localUnread, reportReadProgress]);

  useEffect(() => {
    // 只有**客人**需要上报（房主是本机直接写入，不下发动作）
    if (!isMpPlaying || !isGuestPlaying) return;
    // 每 ~2.5s 上报一次「我还差几句没读」——比逐句上报省带宽，也足够让房主的阅读门在 2.5s 内放行
    const timer = window.setInterval(() => {
      void mp.sendAction({ type: "reading", payload: { content: String(localUnreadRef.current) } });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [isMpPlaying, isGuestPlaying, mp]);

  /**
   * 中间对话区只显示「本机读到的位置」之前的内容（读一句才显示一句）——
   * 联机时房主引擎/朋友都可能跑在前面，不截断的话会把还没轮到你读的台词一股脑全铺出来。
   * 正在读的这一句也算已显示（要逐字打出来）；之后的先留在后台。
   */
  const revealedRawCount = useMemo(() => {
    if (!isMpPlaying) return undefined;
    if (!pendingMessage) return gameState.messages.length; // 已追平 → 全部都是读过的
    let seen = 0;
    for (let i = 0; i < gameState.messages.length; i++) {
      if (!isReadableDialogue(gameState.messages[i])) continue;
      if (seen === readPointer) return i + 1;
      seen++;
    }
    return gameState.messages.length;
  }, [isMpPlaying, pendingMessage, readPointer, gameState.messages]);

  /**
   * 本机的「当前台词」：把待读的那一条包装成与引擎同构的 DialogueState，复用同一套打字机 + 语音。
   * ⚠️ deps 只用「值」（条数 + 内容）而不用消息对象 —— 联机这边的局面每 0.5s 走一次 JSON 往返，
   * 对象引用每轮都会变；若按引用做依赖，这条 memo 会 0.5s 重建一次，语音会被反复入队/重播。
   */
  const pointerDialogue = useMemo(() => {
    if (!isMpPlaying) return null;
    // 已追平（开局时还没读到东西、或自己已读完、日志上还没有更后面的内容）：
    // **不显示任何占位台词** —— 站长实测反馈「开局就显示『已读到最新』」很怪。
    // 此时 DialogArea 会回落到「历史里最后一条玩家发言」，或干脆不显示对话框（开局只有系统消息时）。
    // 顺带用 suppressManualContinue 关掉「点击/回车继续」的提示，避免「点了没反应」的观感。
    if (!pendingMessage) return null;
    const speaker = pendingMessage.isSystem
      ? getI18n().t("speakers.system")
      : (pendingMessage.playerName || "");
    return { speaker, text: String(pendingMessage.content || ""), isStreaming: true };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isMpPlaying,
    readPointer,
    pendingMessage?.isSystem,
    pendingMessage?.playerName,
    pendingMessage?.content,
  ]);

  /**
   * 喵杀修复（2026-10-18 · 站长实测）：联机的**非发言类白天环节**（投票 / 警徽投票 / 结算…）
   * 对话框要显示「本阶段提示语」，而不是挂着最后一位发言者的话。
   * 站长实测现象：读完最后一句后点了「开始警徽评选」，对话框却变成「最后一句评选人发言」——
   * 因为读完后指针没有待读台词，就回落成「历史里最后一条玩家发言」了；他要求这条提示保持到投完。
   * 现在：读完后若处在这类环节，改用「本阶段最后一条系统提示」（它本来也在对话记录里，双方都可见）。
   */
  const mpPromptDialogue = useMemo(() => {
    if (!isMpPlaying) return null;
    if (pendingMessage) return null;
    if (MP_SPEECH_PHASES.includes(gameState.phase)) return null;
    if (gameState.phase.includes("NIGHT")) return null;
    const lastSys = [...gameState.messages]
      .reverse()
      .find((m) => m.isSystem && String(m.content || "").trim() && !String(m.content || "").startsWith("["));
    if (!lastSys) return null;
    return { speaker: getI18n().t("speakers.host"), text: String(lastSys.content), isStreaming: true };
  }, [isMpPlaying, pendingMessage, gameState.phase, gameState.messages]);

  /** 单机：还是引擎里的实时台词；联机：发言类阶段用本地阅读指针，非发言类白天环节用阶段提示语。 */
  const effectiveDialogue = isMpPlaying
    ? (pendingMessage ? pointerDialogue : mpPromptDialogue)
    : currentDialogue;

  /**
   * 玩家卡片高亮跟随「本机正在读的台词」，而不是房主后台的 currentSpeakerSeat。
   * 否则后台泵推进到 8 号时，正在看 6 号台词的玩家会看到高亮一直往后跳。
   */
  const displaySpeakerSeat = useMemo(() => {
    if (humanTurnSeat !== null) return humanTurnSeat;
    if (!isMpPlaying) return gameState.currentSpeakerSeat;
    const speaker = effectiveDialogue?.speaker;
    if (!speaker) return null;
    return gameState.players.find((p) => p.displayName === speaker)?.seat ?? null;
  }, [
    humanTurnSeat,
    isMpPlaying,
    gameState.currentSpeakerSeat,
    gameState.players,
    effectiveDialogue?.speaker,
  ]);

  const shownNotice = isGuestPlaying
    ? (mp.room?.data.notice ?? mpStatusNotice)
    : (gateNotice ?? mpStatusNotice);

  /**
   * 本机点「继续」/按回车：
   * ① 还有没读的台词 → 推进**自己这一条**（本地立刻有反馈：打字机 + 语音随之切换）；
   * ② 已经追平已生成的内容 → 房主由自己推动引擎（例如投票结算后的「确认继续」必须房主点一下），
   *    客人则把推进请求回传给房主。
   */
  const advanceReading = useCallback(() => {
    if (pendingMessage) {
      // 清掉还没播完/排队的旧语音（可能连着快进），再推进自己的阅读指针
      audioManager.clearQueue();
      setReadPointer((c) => c + 1);
      return;
    }
    if (isGuestPlaying) {
      // 喵杀修复（2026-10-18 · 站长实测）：客人已追平自己的阅读进度后，
      // 不再驱动房主引擎。否则客人一按继续，可能把房主的遗言/票型确认直接跳过，
      // 两人互相抢推进，表现为「对话框时有时无、不知道谁卡了」。
      // 这里只上报「我已读完」，真正的阶段推进由房主或当前行动者完成。
      void mp.sendAction({ type: "reading", payload: { content: "0" } });
      return;
    }
    void (async () => {
      const r = await advanceSpeech();
      if (r?.shouldAdvanceToNextSpeaker || waitingForNextRound) {
        await handleNextRound();
      }
    })();
  }, [pendingMessage, isGuestPlaying, mp, advanceSpeech, waitingForNextRound, handleNextRound]);
  const {
    state: tutorialState,
    isLoaded: isTutorialLoaded,
    canAutoPrompt,
    setAutoPromptEnabled,
    markSeenNightIntro,
    markSeenDayIntro,
    markSeenRole,
  } = useTutorial();

  const { analysisData, isLoading: isAnalysisLoading, clearAnalysis } = useGameAnalysis();
  const [showAnalysis, setShowAnalysis] = useState(false);

  const [visualIsNight, setVisualIsNight] = useState(isNight);
  const visualIsNightRef = useRef(isNight);
  const [isMobile, setIsMobile] = useState(false);
  const [dayNightBlinkPhase, setDayNightBlinkPhase] = useState<null | "closing" | "opening">(null);
  const dayNightBlinkTokenRef = useRef(0);
  const dayNightBlinkTimeoutsRef = useRef<number[]>([]);
  const pendingNightBlinkRef = useRef(false);
  const lastNightCueIdRef = useRef<string | null>(null);

  useEffect(() => {
    visualIsNightRef.current = visualIsNight;
  }, [visualIsNight]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const referral = params.get("ref")?.trim();
    if (referral) {
      localStorage.setItem(REFERRAL_STORAGE_KEY, referral);
    }
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 768px)");
    const update = () => setIsMobile(media.matches);
    update();
    if (media.addEventListener) {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", visualIsNight ? "dark" : "light");
  }, [visualIsNight]);

  const clearDayNightBlinkTimers = useCallback(() => {
    dayNightBlinkTimeoutsRef.current.forEach((t) => window.clearTimeout(t));
    dayNightBlinkTimeoutsRef.current = [];
  }, []);

  const scheduleDayNightBlink = useCallback((targetIsNight: boolean, delayMs = 0) => {
    if (visualIsNightRef.current === targetIsNight) return;

    clearDayNightBlinkTimers();
    const token = ++dayNightBlinkTokenRef.current;

    const beginBlink = () => {
      if (dayNightBlinkTokenRef.current !== token) return;
      setDayNightBlinkPhase("closing");

      const { closeMs, holdMs, openMs } = DAY_NIGHT_BLINK;
      const t1 = window.setTimeout(() => {
        if (dayNightBlinkTokenRef.current !== token) return;
        setVisualIsNight(targetIsNight);
        const tHold = window.setTimeout(() => {
          if (dayNightBlinkTokenRef.current !== token) return;
          setDayNightBlinkPhase("opening");
          const t2 = window.setTimeout(() => {
            if (dayNightBlinkTokenRef.current !== token) return;
            setDayNightBlinkPhase(null);
          }, openMs);
          dayNightBlinkTimeoutsRef.current.push(t2);
        }, holdMs);
        dayNightBlinkTimeoutsRef.current.push(tHold);
      }, closeMs);
      dayNightBlinkTimeoutsRef.current.push(t1);
    };

    if (delayMs > 0) {
      const tStart = window.setTimeout(beginBlink, delayMs);
      dayNightBlinkTimeoutsRef.current.push(tStart);
    } else {
      beginBlink();
    }
  }, [clearDayNightBlinkTimers]);

  useEffect(() => {
    if (isNight === visualIsNightRef.current) return;

    if (isNight) {
      // Mark that we need to blink to night
      pendingNightBlinkRef.current = true;
      return;
    }

    // Transition to day immediately
    pendingNightBlinkRef.current = false;
    lastNightCueIdRef.current = null;
    scheduleDayNightBlink(false, 0);
  }, [isNight, scheduleDayNightBlink]);

  useEffect(() => {
    return () => {
      clearDayNightBlinkTimers();
    };
  }, [clearDayNightBlinkTimers]);

  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const bgmUnlockedRef = useRef(false);
  const bgmFadeAnimationRef = useRef<number | null>(null);
  const bgmLoopFadeRef = useRef(false);
  const bgmManualFadeRef = useRef(false);
  const showTableRef = useRef(showTable);
  const isNightRef = useRef(isNight);
  const bgmVolumeRef = useRef(bgmVolume);
  const isSoundEnabledRef = useRef(isSoundEnabled);
  const LOOP_FADE_DURATION_MS = 1200;
  const resolveAudioSrc = useCallback((src: string) => {
    if (typeof window === "undefined") return src;
    try {
      return new URL(src, window.location.href).href;
    } catch {
      return src;
    }
  }, []);
  useEffect(() => {
    showTableRef.current = showTable;
  }, [showTable]);
  useEffect(() => {
    isNightRef.current = isNight;
  }, [isNight]);
  useEffect(() => {
    bgmVolumeRef.current = bgmVolume;
  }, [bgmVolume]);
  useEffect(() => {
    isSoundEnabledRef.current = isSoundEnabled;
  }, [isSoundEnabled]);

  // Fade in/out helper function
  const fadeAudio = useCallback((
    audio: HTMLAudioElement,
    targetVolume: number,
    duration: number = 1000,
    onComplete?: () => void
  ) => {
    // Cancel any existing fade animation
    if (bgmFadeAnimationRef.current !== null) {
      cancelAnimationFrame(bgmFadeAnimationRef.current);
    }

    const startVolume = audio.volume;
    const startTime = performance.now();
    const volumeDiff = targetVolume - startVolume;

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // Use ease-in-out curve for smoother transition
      const easedProgress = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      
      audio.volume = startVolume + volumeDiff * easedProgress;

      if (progress < 1) {
        bgmFadeAnimationRef.current = requestAnimationFrame(animate);
      } else {
        bgmFadeAnimationRef.current = null;
        onComplete?.();
      }
    };

    bgmFadeAnimationRef.current = requestAnimationFrame(animate);
  }, []);

  const attachLoopFade = useCallback((audio: HTMLAudioElement) => {
    const handleTimeUpdate = () => {
      if (bgmManualFadeRef.current) return;
      if (!showTableRef.current || !isSoundEnabledRef.current) return;
      if (bgmLoopFadeRef.current) return;
      const duration = audio.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      const remaining = duration - audio.currentTime;
      if (remaining > LOOP_FADE_DURATION_MS / 1000) return;

      bgmLoopFadeRef.current = true;
      fadeAudio(audio, 0, LOOP_FADE_DURATION_MS, () => {
        if (!bgmAudioRef.current) return;
        if (!showTableRef.current || !isSoundEnabledRef.current) {
          bgmLoopFadeRef.current = false;
          return;
        }
        const targetVolume = bgmVolumeRef.current;
        audio.currentTime = 0;
        audio.volume = 0;
        void audio.play().catch(() => {});
        fadeAudio(audio, targetVolume, LOOP_FADE_DURATION_MS, () => {
          bgmLoopFadeRef.current = false;
        });
      });
    };
    audio.addEventListener("timeupdate", handleTimeUpdate);
    return () => audio.removeEventListener("timeupdate", handleTimeUpdate);
  }, [fadeAudio, LOOP_FADE_DURATION_MS]);

  useEffect(() => {
    const audio = new Audio();
    audio.loop = false;
    audio.volume = isSoundEnabledRef.current ? bgmVolumeRef.current : 0;
    bgmAudioRef.current = audio;
    const cleanupLoopFade = attachLoopFade(audio);
    return () => {
      if (bgmFadeAnimationRef.current !== null) {
        cancelAnimationFrame(bgmFadeAnimationRef.current);
      }
      cleanupLoopFade();
      audio.pause();
      bgmAudioRef.current = null;
    };
  }, [attachLoopFade]);

  useEffect(() => {
    const unlock = () => {
      if (bgmUnlockedRef.current) return;
      if (!isSoundEnabledRef.current) return;
      bgmUnlockedRef.current = true;
      const audio = bgmAudioRef.current;
      if (!audio) return;

      const desiredSrc = isNightRef.current ? nightBgm : dayBgm;
      const desiredResolved = resolveAudioSrc(desiredSrc);
      const currentResolved = audio.currentSrc || resolveAudioSrc(audio.src);
      if (currentResolved !== desiredResolved) {
        audio.src = desiredSrc;
        audio.load();
      }

      audio.volume = bgmVolumeRef.current;
      // 必须在用户手势内触发一次 play 才能解锁后续自动播放
      void audio.play().catch(() => {});

      // 如果还没进入游戏界面，立刻暂停，避免欢迎页响起
      if (!showTableRef.current) {
        audio.pause();
      }
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, [resolveAudioSrc]);

  useEffect(() => {
    const audio = bgmAudioRef.current;
    if (!audio) return;

    const desiredVolume = isSoundEnabled ? bgmVolume : 0;

    if (!showTable || !isSoundEnabled) {
      // Fade out when hiding table or muting
      bgmManualFadeRef.current = true;
      fadeAudio(audio, 0, 800, () => {
        audio.pause();
        bgmManualFadeRef.current = false;
      });
      return;
    }

    const desiredSrc = isNight ? nightBgm : dayBgm;
    const desiredResolved = resolveAudioSrc(desiredSrc);
    const currentResolved = audio.currentSrc || resolveAudioSrc(audio.src);
    const isSwitching = currentResolved && currentResolved !== desiredResolved;
    
    if (isSwitching) {
      // Fade out current music, then switch and fade in new music
      bgmManualFadeRef.current = true;
      fadeAudio(audio, 0, 1000, () => {
        if (!bgmAudioRef.current) return;
        const currentAudio = bgmAudioRef.current;
        currentAudio.src = desiredSrc;
        currentAudio.load();
        bgmLoopFadeRef.current = false;
        
        if (bgmUnlockedRef.current) {
          void currentAudio.play().catch(() => {});
          // Fade in new music
          currentAudio.volume = 0;
          fadeAudio(currentAudio, desiredVolume, 1200, () => {
            bgmManualFadeRef.current = false;
          });
        } else {
          bgmManualFadeRef.current = false;
        }
      });
    } else {
      // Just ensure it's playing with correct volume
      if (currentResolved !== desiredResolved) {
        audio.src = desiredSrc;
        audio.load();
        bgmLoopFadeRef.current = false;
      }
      if (bgmUnlockedRef.current) {
        if (audio.paused) {
          audio.volume = 0;
          void audio.play().catch(() => {});
          bgmManualFadeRef.current = true;
          fadeAudio(audio, desiredVolume, 1200, () => {
            bgmManualFadeRef.current = false;
          });
        } else if (audio.volume !== desiredVolume) {
          bgmManualFadeRef.current = true;
          fadeAudio(audio, desiredVolume, 800, () => {
            bgmManualFadeRef.current = false;
          });
        }
      }
    }
  }, [isNight, showTable, fadeAudio, bgmVolume, isSoundEnabled, resolveAudioSrc]);

  useEffect(() => {
    audioManager.setEnabled(shouldUseAiVoice);
  }, [shouldUseAiVoice]);

  // UI 状态
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null);
  const [isNotebookOpen, setIsNotebookOpen] = useState(false);
  const [isDevConsoleOpen, setIsDevConsoleOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isRulesOpen, setIsRulesOpen] = useState(false);
  // 喵杀：语音语速（默认 1.25×，仅影响人声，不影响 BGM）
  const [speechRate, setSpeechRate] = useSpeechRate();
  const [detailPlayer, setDetailPlayer] = useState<Player | null>(null);
  const [isRoleRevealOpen, setIsRoleRevealOpen] = useState(false);
  const [hasShownRoleReveal, setHasShownRoleReveal] = useState(false);
  const [activeTutorial, setActiveTutorial] = useState<TutorialPayload | null>(null);
  const [isTutorialOpen, setIsTutorialOpen] = useState(false);
  const [nightActionOverlay, setNightActionOverlay] = useState<{
    type: NightActionOverlayType;
    id: number;
    target?: { seat: number; name: string; avatarUrl?: string };
  } | null>(null);
  const nightActionOverlayTimerRef = useRef<number | null>(null);
  const showDevTools =
    process.env.NODE_ENV !== "production" && (process.env.NEXT_PUBLIC_SHOW_DEVTOOLS ?? "true") === "true";
  const lastNightActionRef = useRef<{
    wolfTarget?: number;
    witchSave?: boolean;
    witchPoison?: number;
    seerTarget?: number;
    hunterShotKey?: string | null;
  }>({});
  
  // 检查玩家是否准备就绪（用于召集阶段显示加载状态）
  const isReady = useMemo(() => {
    return gameState.players.every((p) => p.displayName?.trim());
  }, [gameState.players]);

  // 阶段切换时清理选择状态
  useEffect(() => {
    const t = window.setTimeout(() => {
      setSelectedSeat(null);
    }, 0);
    return () => window.clearTimeout(t);
  }, [gameState.phase]);

  const [ritualCue, setRitualCue] = useState<{ id: string; title: string; subtitle?: string } | null>(null);
  const [lastRitualMessageId, setLastRitualMessageId] = useState<string | null>(null);
  const ritualCueQueueRef = useRef<Array<{ id: string; title: string; subtitle?: string }>>([]);
  const lastAdvanceTimeRef = useRef(0);
  const canShowRole = hasShownRoleReveal || isGuestPlaying;
  const selectionTone = useMemo(() => {
    if (!humanPlayer) return undefined;
    switch (gameState.phase) {
      case "NIGHT_WOLF_ACTION":
        return isWolfRole(humanPlayer.role) ? "wolf" : undefined;
      case "NIGHT_SEER_ACTION":
        return humanPlayer.role === "Seer" ? "seer" : undefined;
      case "NIGHT_GUARD_ACTION":
        return humanPlayer.role === "Guard" ? "guard" : undefined;
      case "NIGHT_WITCH_ACTION":
        return humanPlayer.role === "Witch" ? "witch" : undefined;
      case "HUNTER_SHOOT":
        return humanPlayer.role === "Hunter" ? "hunter" : undefined;
      case "DAY_BADGE_ELECTION":
      case "BADGE_TRANSFER":
        return "badge";
      case "DAY_VOTE":
        return "vote";
      default:
        return undefined;
    }
  }, [gameState.phase, humanPlayer]);

  useEffect(() => {
    const lastSystem = [...gameState.messages].reverse().find((m) => m.isSystem);
    if (!lastSystem) return;
    if (lastSystem.id && lastSystem.id === lastRitualMessageId) return;
    const cue = getRitualCueFromSystemMessage(lastSystem.content);
    if (!cue) return;

    queueMicrotask(() => {
      setLastRitualMessageId(lastSystem.id || null);
      const next = { id: lastSystem.id || String(Date.now()), title: cue.title, subtitle: cue.subtitle };
      if (ritualCue) {
        ritualCueQueueRef.current.push(next);
        return;
      }
      setRitualCue(next);
    });
  }, [gameState.messages, lastRitualMessageId, ritualCue]);

  // Trigger night blink when we see the nightfall ritual cue
  useEffect(() => {
    if (!ritualCue || !isNight) return;
    if (!pendingNightBlinkRef.current) return;
    if (!showTable || isRoleRevealOpen) return;
    
    const text = ritualCue.title.trim();
    if (!NIGHTFALL_CUE_REGEX.test(text)) return;
    if (lastNightCueIdRef.current === ritualCue.id) return;

    lastNightCueIdRef.current = ritualCue.id;
    pendingNightBlinkRef.current = false;
    scheduleDayNightBlink(true, Math.round(RITUAL_CUE_DURATION_SECONDS * 1000));
  }, [ritualCue, isNight, scheduleDayNightBlink, showTable, isRoleRevealOpen]);

  // Fallback: directly monitor messages for nightfall cue
  useEffect(() => {
    if (!isNight || !pendingNightBlinkRef.current) return;
    if (!ritualCue || !showTable || isRoleRevealOpen) return;
    
    const lastSystemMsg = [...gameState.messages].reverse().find(m => m.isSystem);
    if (!lastSystemMsg) return;
    
    const text = lastSystemMsg.content.trim();
    if (!NIGHTFALL_CUE_REGEX.test(text)) return;
    
    const cueId = ritualCue.id;
    if (lastNightCueIdRef.current === cueId) return;
    
    // Found nightfall message and haven't processed it yet
    lastNightCueIdRef.current = cueId;
    pendingNightBlinkRef.current = false;
    
    // Schedule the blink after a short delay to ensure ritual cue is shown
    const timer = window.setTimeout(() => {
      scheduleDayNightBlink(true, Math.round(RITUAL_CUE_DURATION_SECONDS * 1000));
    }, 100);
    
    return () => window.clearTimeout(timer);
  }, [gameState.messages, isNight, scheduleDayNightBlink, ritualCue, showTable, isRoleRevealOpen]);

  // Typewriter effect
  const typewriterSpeed = useMemo(() => {
    const text = effectiveDialogue?.text || "";
    if (!effectiveDialogue?.isStreaming) return 25;
    if (!text.trim()) return 25;
    if (text.includes("正在组织语言") || text.includes("生成语音")) return 25;

    const player = gameState.players.find((p) => p.displayName === effectiveDialogue.speaker);
    const voiceId = resolveVoiceId(
      player?.agentProfile?.persona?.voiceId,
      player?.agentProfile?.persona?.gender,
      player?.agentProfile?.persona?.age
    );
    const taskId = makeAudioTaskId(voiceId, text);
    const durationMs = audioManager.getCachedDurationMs(taskId);
    if (!durationMs || durationMs <= 0) return 25;

    const raw = durationMs / Math.max(1, text.length);
    return Math.min(60, Math.max(10, Math.round(raw)));
  }, [effectiveDialogue, gameState.players]);

  const { displayedText, isTyping } = useTypewriter({
    text: effectiveDialogue?.text || "",
    speed: typewriterSpeed,
    enabled: !!effectiveDialogue?.isStreaming,
  });

  // Enter/Right key to advance AI speech or move to next round
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isRoleRevealOpen) return;

      // 检查焦点是否在输入元素内（input, textarea, contenteditable）
      const activeEl = document.activeElement;
      const isInInput = activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl?.getAttribute("contenteditable") === "true" ||
        activeEl?.closest("[contenteditable='true']") !== null;

      // 如果笔记本打开，不拦截 Enter 键（让笔记本正常换行）
      if (isNotebookOpen && e.key === "Enter") return;

      // 如果焦点在输入元素内，不拦截左右方向键（让光标正常移动）
      if (isInInput && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;

      // 如果焦点在输入元素内，不拦截 Enter 键（让输入框正常处理）
      if (isInInput && e.key === "Enter") return;

      // Enter or Right arrow to advance
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "ArrowRight") {
        // 联机对局：键盘推进的是**自己那条阅读指针**（原先只有点对话框才把动作发给房主，
        // 按回车在本机毫无反应 —— 站长报的就是这个）。
        if (isMpPlaying) {
          if (pendingMessage || waitingForNextRound) {
            e.preventDefault();
            advanceReading();
          }
          return;
        }

        // 当AI在发言时（有currentDialogue），按键推进下一句
        if (effectiveDialogue) {
          e.preventDefault();
          audioManager.stopCurrent();
          Promise.resolve(advanceSpeech()).then((r) => {
            if (r?.shouldAdvanceToNextSpeaker) {
              handleNextRound();
            }
          });
          return;
        }
        
        // 等待下一轮时，按键进入下一轮
        if (waitingForNextRound) {
          e.preventDefault();
          handleNextRound();
        }
      }
    };
    
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [effectiveDialogue, waitingForNextRound, advanceSpeech, handleNextRound, isRoleRevealOpen, isNotebookOpen, isMpPlaying, pendingMessage, advanceReading]);

  const handleAdvanceDialogue = useCallback(async () => {
    if (isRoleRevealOpen) return;
    const now = Date.now();
    if (now - lastAdvanceTimeRef.current < 300) return;
    lastAdvanceTimeRef.current = now;

    // 喵杀（十七轮）：联机对局里「点继续」= 推进自己那条阅读指针（本地立即生效）；
    // 只有追平了已生成的内容，才由房主自己推动引擎、或客人把请求回传给房主。详见 advanceReading。
    if (isMpPlaying) {
      advanceReading();
      return;
    }

    if (effectiveDialogue) {
      const r = await advanceSpeech();
      if (r?.shouldAdvanceToNextSpeaker) {
        await handleNextRound();
      }
      return;
    }

    if (waitingForNextRound) {
      await handleNextRound();
    }
  }, [advanceSpeech, effectiveDialogue, handleNextRound, isRoleRevealOpen, waitingForNextRound, isMpPlaying, advanceReading]);

  useEffect(() => {
    if (!showTable) return;
    if (!humanPlayer) return;
    if (hasShownRoleReveal) return;
    if (gameState.phase !== "NIGHT_START") return;
    if (!visualIsNight) return;
    if (dayNightBlinkPhase) return;
    const t = window.setTimeout(() => {
      setIsRoleRevealOpen(true);
      setHasShownRoleReveal(true);
    }, 380);
    return () => window.clearTimeout(t);
  }, [showTable, humanPlayer, hasShownRoleReveal, gameState.phase, visualIsNight, dayNightBlinkPhase]);

  const openTutorial = useCallback(
    (payload: TutorialPayload, options?: { force?: boolean }) => {
      if (!options?.force && !canAutoPrompt) return;
      setActiveTutorial(payload);
      setIsTutorialOpen(true);
    },
    [canAutoPrompt]
  );

  const handleTutorialOpenChange = useCallback(
    (open: boolean) => {
      setIsTutorialOpen(open);
      if (!open && activeTutorial) {
        if (activeTutorial.kind === "night_intro") {
          markSeenNightIntro();
        } else if (activeTutorial.kind === "day_intro") {
          markSeenDayIntro();
        } else if (activeTutorial.kind === "role" && activeTutorial.role) {
          markSeenRole(activeTutorial.role);
        }
        setActiveTutorial(null);
      }
    },
    [activeTutorial, markSeenDayIntro, markSeenNightIntro, markSeenRole]
  );

  const activeRoleForPhase = useMemo<Role | null>(() => {
    switch (gameState.phase) {
      case "NIGHT_WOLF_ACTION":
        return "Werewolf";
      case "NIGHT_SEER_ACTION":
        return "Seer";
      case "NIGHT_WITCH_ACTION":
        return "Witch";
      case "NIGHT_GUARD_ACTION":
        return "Guard";
      case "HUNTER_SHOOT":
        return "Hunter";
      default:
        return null;
    }
  }, [gameState.phase]);

  const isRoleActionForHuman = useMemo(() => {
    if (!humanPlayer || !activeRoleForPhase) return false;
    if (!humanPlayer.alive) return false;
    if (humanPlayer.role !== activeRoleForPhase) return false;
    return PHASE_CONFIGS[gameState.phase].requiresHumanInput(humanPlayer, gameState);
  }, [activeRoleForPhase, gameState, humanPlayer]);

  useEffect(() => {
    if (!showTable) return;
    if (!isTutorialLoaded) return;
    if (!tutorialState.enabled) return;
    if (isRoleRevealOpen) return;
    if (isTutorialOpen) return;
    if (!humanPlayer) return;
    if (!hasShownRoleReveal && gameState.phase === "NIGHT_START") return;

    if (!tutorialState.seenNightIntro && gameState.phase.includes("NIGHT") && visualIsNight) {
      openTutorial({ kind: "night_intro", phase: gameState.phase });
      return;
    }

    if (!tutorialState.seenDayIntro && gameState.phase.startsWith("DAY") && !visualIsNight) {
      openTutorial({ kind: "day_intro", phase: gameState.phase });
      return;
    }

    if (isRoleActionForHuman && !tutorialState.seenRoles[humanPlayer.role]) {
      openTutorial({ kind: "role", role: humanPlayer.role, phase: gameState.phase });
    }
  }, [
    gameState.phase,
    humanPlayer,
    isRoleActionForHuman,
    isRoleRevealOpen,
    isTutorialLoaded,
    isTutorialOpen,
    openTutorial,
    showTable,
    tutorialState.enabled,
    tutorialState.seenDayIntro,
    tutorialState.seenNightIntro,
    tutorialState.seenRoles,
    visualIsNight,
  ]);

  const tutorialHelpLabel = useMemo(() => {
    if (isRoleActionForHuman && humanPlayer) {
      return `${getRoleLabel(humanPlayer.role)}是什么？`;
    }
    if (gameState.phase === "DAY_VOTE" || gameState.phase === "DAY_BADGE_ELECTION") {
      return "怎么投票？";
    }
    return "玩法说明";
  }, [gameState.phase, humanPlayer, isRoleActionForHuman]);

  const showTutorialHelp = useMemo(() => {
    return (
      isRoleActionForHuman ||
      gameState.phase === "DAY_VOTE" ||
      gameState.phase === "DAY_BADGE_ELECTION"
    );
  }, [gameState.phase, isRoleActionForHuman]);

  const handleTutorialHelpOpen = useCallback(() => {
    if (isRoleActionForHuman && humanPlayer) {
      openTutorial({ kind: "role", role: humanPlayer.role, phase: gameState.phase }, { force: true });
      return;
    }
    openTutorial({ kind: "day_intro", phase: gameState.phase }, { force: true });
  }, [gameState.phase, humanPlayer, isRoleActionForHuman, openTutorial]);

  // API Key 检查（现在由服务端管理，此检查已不再需要）


  useEffect(() => {
    scrollToBottom();
  }, [gameState.messages, scrollToBottom]);

  useEffect(() => {
    if (showTable) return;
    queueMicrotask(() => {
      setIsRoleRevealOpen(false);
      setHasShownRoleReveal(false);
    });
  }, [showTable]);

  useEffect(() => {
    if (showTable) return;
    setActiveTutorial(null);
    setIsTutorialOpen(false);
  }, [showTable]);

  const triggerNightOverlay = useCallback((type: NightActionOverlayType, targetSeat?: number) => {
    if (!showTable) return;
    if (isRoleRevealOpen) return;
    const target =
      typeof targetSeat === "number"
        ? gameState.players.find((p) => p.seat === targetSeat)
        : null;
    const targetPayload = target
      ? {
          seat: target.seat,
          name: target.displayName,
          avatarUrl: avatarUrl(target.avatarSeed ?? target.displayName),
        }
      : undefined;
    setNightActionOverlay({ type, id: Date.now(), target: targetPayload });
    if (nightActionOverlayTimerRef.current !== null) {
      window.clearTimeout(nightActionOverlayTimerRef.current);
    }
    nightActionOverlayTimerRef.current = window.setTimeout(() => {
      setNightActionOverlay(null);
    }, 1500);
  }, [gameState.players, isRoleRevealOpen, showTable]);

  useEffect(() => {
    if (!showTable) {
      lastNightActionRef.current = {};
      setNightActionOverlay(null);
      return;
    }

    const { wolfTarget, witchSave, witchPoison, seerTarget } = gameState.nightActions;
    const last = lastNightActionRef.current;
    const role = humanPlayer?.role;
    const isHumanAlive = humanPlayer?.alive;
    const canSeeWolf = isWolfRole(role) && isHumanAlive;
    const canSeeWitch = role === "Witch" && isHumanAlive;
    const canSeeSeer = role === "Seer" && isHumanAlive;
    const canSeeHunter = role === "Hunter";

    if (canSeeWolf && typeof wolfTarget === "number" && wolfTarget !== last.wolfTarget) {
      triggerNightOverlay("wolf", wolfTarget);
    }

    if (canSeeWitch && witchSave && witchSave !== last.witchSave) {
      triggerNightOverlay("witch-save", wolfTarget);
    }

    if (canSeeWitch && typeof witchPoison === "number" && witchPoison !== last.witchPoison) {
      triggerNightOverlay("witch-poison", witchPoison);
    }

    if (canSeeSeer && typeof seerTarget === "number" && seerTarget !== last.seerTarget) {
      triggerNightOverlay("seer", seerTarget);
    }

    const hunterShot =
      gameState.nightHistory?.[gameState.day]?.hunterShot ||
      gameState.dayHistory?.[gameState.day]?.hunterShot;
    const hunterShotKey = hunterShot
      ? `${gameState.day}-${hunterShot.hunterSeat}-${hunterShot.targetSeat}`
      : null;
    if (canSeeHunter && hunterShot && hunterShotKey && hunterShotKey !== last.hunterShotKey) {
      triggerNightOverlay("hunter", hunterShot.targetSeat);
    }

    lastNightActionRef.current = {
      wolfTarget,
      witchSave,
      witchPoison,
      seerTarget,
      hunterShotKey,
    };
  }, [
    gameState.day,
    gameState.dayHistory,
    gameState.nightActions,
    gameState.nightHistory,
    humanPlayer,
    showTable,
    triggerNightOverlay,
  ]);

  // ============ 交互逻辑 ============

  // 判断是否可以点击座位（使用状态机配置）
  const canClickSeat = useCallback((player: Player): boolean => {
    if (isRoleRevealOpen) return false;
    if (!humanPlayer) return false;
    if (
      gameState.phase === "NIGHT_WITCH_ACTION" &&
      humanPlayer.role === "Witch" &&
      gameState.roleAbilities.witchPoisonUsed
    ) {
      return false;
    }
    const config = PHASE_CONFIGS[gameState.phase];
    return config.canSelectPlayer(humanPlayer, player, gameState);
  }, [humanPlayer, gameState, isRoleRevealOpen]);

  const handleSeatClick = useCallback((player: Player) => {
    if (isRoleRevealOpen) return;
    if (
      humanPlayer &&
      gameState.phase === "NIGHT_WITCH_ACTION" &&
      humanPlayer.role === "Witch" &&
      gameState.roleAbilities.witchPoisonUsed
    ) {
      toast("毒药已用过了", {
        description: "今晚只能选择救人，或直接跳过。",
      });
      return;
    }
    if (!canClickSeat(player)) return;
    setSelectedSeat(prev => prev === player.seat ? null : player.seat);
  }, [canClickSeat, isRoleRevealOpen, humanPlayer, gameState.phase, gameState.roleAbilities.witchPoisonUsed]);

  const confirmSelectedSeat = useCallback(async () => {
    if (isRoleRevealOpen) return;
    
    const phase = gameState.phase;
    
    // 特殊处理：撕毁警徽（当在警徽移交阶段且没有选择目标时）
    if (phase === "BADGE_TRANSFER" && selectedSeat === null && humanPlayer && gameState.badge.holderSeat === humanPlayer.seat) {
      await effectiveBadgeTransfer(0); // 0表示撕毁警徽
      return;
    }
    
    if (selectedSeat === null) return;
    
    // 保存选中的座位号，然后立即清除选择状态，避免确认对话框重新渲染
    const targetSeat = selectedSeat;
    setSelectedSeat(null);
    
    if (phase === "DAY_VOTE" || phase === "DAY_BADGE_ELECTION") {
      await effectiveVote(targetSeat);
    } else if (phase === "BADGE_TRANSFER") {
      await effectiveBadgeTransfer(targetSeat);
    } else if (
      (phase === "DAY_SPEECH" || phase === "DAY_PK_SPEECH") &&
      humanPlayer?.role === "WhiteWolfKing"
    ) {
      // 喵杀（2026-10-17）：人类白狼王在白天发言阶段点选目标 → 自爆（先宣言再炸）
      await effectiveWWKBoom(targetSeat);
    } else if (
      phase === "NIGHT_SEER_ACTION" ||
      phase === "NIGHT_WOLF_ACTION" ||
      phase === "NIGHT_GUARD_ACTION" ||
      phase === "HUNTER_SHOOT"
    ) {
      await effectiveNightAction(targetSeat);
    }
  }, [selectedSeat, gameState.phase, effectiveVote, effectiveBadgeTransfer, effectiveWWKBoom, effectiveNightAction, isRoleRevealOpen, humanPlayer, gameState.badge.holderSeat]);

  const handleNightActionConfirm = useCallback(async (targetSeat: number, actionType?: "save" | "poison" | "pass") => {
    if (isRoleRevealOpen) return;
    await effectiveNightAction(targetSeat, actionType);
    setSelectedSeat(null);
  }, [effectiveNightAction, isRoleRevealOpen]);

  // 玩家列表（包含人类玩家）
  const allPlayers = useMemo(() => {
    return gameState.players;
  }, [gameState.players]);

  const leftPlayers = useMemo(() => allPlayers.slice(0, Math.ceil(allPlayers.length / 2)), [allPlayers]);
  const rightPlayers = useMemo(() => allPlayers.slice(Math.ceil(allPlayers.length / 2)), [allPlayers]);

  // 获取阶段描述
  const getPhaseDescription = useCallback(() => {
    const { t } = getI18n();
    const config = PHASE_CONFIGS[gameState.phase];
    if (config.humanDescription) {
      return config.humanDescription(humanPlayer, gameState);
    }
    // 翻译 i18n key
    return t(config.description as Parameters<typeof t>[0]);
  }, [gameState, humanPlayer]);

  const needsHumanAction = useMemo(() => {
    return PHASE_CONFIGS[gameState.phase].requiresHumanInput(humanPlayer, gameState);
  }, [gameState.phase, humanPlayer, gameState]);

  const showWaitingIndicator = isWaitingForAI && !needsHumanAction;

  const hasSelectableTargets = useMemo(() => {
    return allPlayers.some((player) => canClickSeat(player));
  }, [allPlayers, canClickSeat]);

  const isSelectionPhase = useMemo(() => {
    const actionType = PHASE_CONFIGS[gameState.phase].actionType;
    if (actionType === "vote" || actionType === "night_action") return needsHumanAction;
    if (actionType === "special") return needsHumanAction && hasSelectableTargets;
    return false;
  }, [gameState.phase, needsHumanAction, hasSelectableTargets]);

  const renderPhaseIcon = () => {
    switch (gameState.phase) {
      case "NIGHT_SEER_ACTION":
        return <Eye size={14} />;
      case "NIGHT_WOLF_ACTION":
        return <Skull size={14} />;
      case "NIGHT_GUARD_ACTION":
        return <Shield size={14} />;
      case "NIGHT_WITCH_ACTION":
        return <Drop size={14} />;
      case "HUNTER_SHOOT":
        return <Crosshair size={14} />;
      case "DAY_SPEECH":
        return <SpeechIcon size={14} />;
      case "DAY_BADGE_SIGNUP":
        return <Users size={14} />;
      case "DAY_BADGE_ELECTION":
        return <Users size={14} />;
      case "DAY_VOTE":
        return <Users size={14} />;
      default:
        return visualIsNight ? <NightIcon size={14} /> : <DayIcon size={14} />;
    }
  };

  // ============ 技能演出（第十二轮）============
  // 单点监听 gameState：① 猎人开枪 ② 白狼王自爆 ③ 白痴翻牌 → 音效 + 全屏动效。
  // 这三个事件当回合都是「公开时刻」，不会泄露任何私密信息；夜间不公开阶段不触发。
  const [skillFx, setSkillFx] = useState<{ kind: "gun" | "boom" | "reveal" | "badge"; id: number } | null>(null);
  const prevSkillStateRef = useRef<typeof gameState | null>(null);

  useEffect(() => {
    const prev = prevSkillStateRef.current;
    prevSkillStateRef.current = gameState;
    // 首帧 / 重开 / 未上桌 不触发
    if (!prev || prev.gameId !== gameState.gameId || !showTable) return;

    const collectShots = (s: typeof gameState): Set<string> => {
      const keys = new Set<string>();
      for (const [day, h] of Object.entries(s.dayHistory || {})) {
        if (h?.hunterShot) keys.add(`d${day}:${h.hunterShot.hunterSeat}:${h.hunterShot.targetSeat}`);
      }
      for (const [day, h] of Object.entries(s.nightHistory || {})) {
        if (h?.hunterShot) keys.add(`n${day}:${h.hunterShot.hunterSeat}:${h.hunterShot.targetSeat}`);
      }
      return keys;
    };

    let kind: "gun" | "boom" | "reveal" | "badge" | null = null;
    const prevShots = collectShots(prev);
    const hasNewShot = [...collectShots(gameState)].some((k) => !prevShots.has(k));

    if (hasNewShot && !gameState.phase.includes("NIGHT")) {
      kind = "gun";
    } else if (!prev.roleAbilities.whiteWolfKingBoomUsed && gameState.roleAbilities.whiteWolfKingBoomUsed) {
      kind = "boom";
    } else if (!prev.roleAbilities.idiotRevealed && gameState.roleAbilities.idiotRevealed) {
      kind = "reveal";
    } else if (
      (prev.badge?.holderSeat ?? null) !== (gameState.badge?.holderSeat ?? null) &&
      gameState.badge?.holderSeat != null
    ) {
      // 喵杀（2026-10-17）：警长竞选演出 —— 警徽从「无」变成「某人」、或移交给他人时，放金色庆典
      kind = "badge";
    }
    if (!kind) return;

    if (isSoundEnabled && bgmVolume > 0) {
      const vol = Math.min(1, bgmVolume * 1.6);
      if (kind === "gun") playGunshot(vol);
      else if (kind === "boom") playExplosion(vol);
      else playReveal(vol);
    }
    setSkillFx({ kind, id: Date.now() });
  }, [gameState, showTable, isSoundEnabled, bgmVolume]);

  // FX 层自动收起（时长与 CSS 动画一致，避免 ::before/::after 的 animationend 提前清场）
  useEffect(() => {
    if (!skillFx) return;
    const dur = skillFx.kind === "boom" ? 1050 : skillFx.kind === "gun" ? 750 : skillFx.kind === "badge" ? 1350 : 900;
    const timer = window.setTimeout(() => setSkillFx(null), dur);
    return () => window.clearTimeout(timer);
  }, [skillFx]);

  // ============ 渲染 ==========

  // 欢迎阶段：未开始游戏时显示欢迎屏
  const isWelcomeStage = !gameStarted;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-transparent">
      <GameBackground isNight={visualIsNight} isBlinking={!!dayNightBlinkPhase} />

      {/* 喵杀联机 · 房间大厅（等朋友准备 → 房主开场） */}
      {inLobby && mp.room && (
        <MultiplayerLobby
          room={mp.room}
          error={mp.error}
          onStart={handleHostStart}
          onLeave={async () => {
            await mp.leaveRoom();
            restartGame();
          }}
          onSetReady={mp.setReady}
        />
      )}

      {/* 喵杀联机 · 对局内状态条（**房主与客人共用**）：房间码 / 是否掉线 / 离开房间。
          客人额外有「后台已到 X号 / 跳到最新」（房主本身就是引擎，不需要阅读指针那套提示）。 */}
      {isMpPlaying && mp.room && (
        <div className="fixed left-3 bottom-3 z-[95] flex items-center gap-2 rounded-full border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-[11px] text-[var(--text-secondary)] shadow-lg">
          <span>
            联机中{mp.role === "host" ? "（房主）" : ""} · 我的座位
            <span className="mx-1 font-mono text-[var(--color-gold)]">{mp.seat + 1}</span>
            号 · 房间码
            <span className="mx-1 font-mono text-[var(--color-gold)]">{mp.room.code}</span>
          </span>
          {mp.room.data.hostAway ? (
            <span className="rounded-full border border-[var(--color-gold)]/60 px-2 py-0.5 font-semibold text-[var(--color-gold)]">
              房主切屏中，稍候喵（不是掉线）
            </span>
          ) : mp.hostOffline ? (
            <span className="rounded-full border border-[var(--color-blood)]/60 px-2 py-0.5 font-semibold text-[var(--color-blood)]">
              与房主同步中断，等待中喵
            </span>
          ) : null}
          {isGuestPlaying && pendingMessage && gameState.currentSpeakerSeat !== displaySpeakerSeat ? (
            <span className="rounded-full border border-[var(--color-gold)]/40 px-2 py-0.5 text-[var(--color-gold)]">
              后台已到 {gameState.currentSpeakerSeat !== null ? gameState.currentSpeakerSeat + 1 : "?"}号
            </span>
          ) : null}
          {isGuestPlaying && readableMessages.length > readPointer ? (
            <button
              type="button"
              onClick={() => {
                audioManager.clearQueue();
                setReadPointer(readableMessages.length);
              }}
              className="rounded-full border border-[var(--color-gold)]/50 px-2 py-0.5 text-[var(--color-gold)] hover:bg-[var(--color-gold)]/10"
            >
              跳到最新
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              void (async () => {
                await mp.leaveRoom();
                // 房主离开 = 房间已被删除、本局作废 → 一并回主页；客人只需退出房间
                if (!isGuestPlaying) restartGame();
              })()
            }
            className="rounded-full border border-[var(--border-color)] px-2 py-0.5 hover:border-[var(--color-blood)] hover:text-[var(--color-blood)]"
          >
            离开房间
          </button>
        </div>
      )}

      {/* 喵杀（十七轮）：投票门提示 —— 让「为什么还没投票」看得见。
          喵杀修复（2026-10-18 · 站长实测）：**房主与客人两边都显示**（客人读房主下发的 notice）。 */}
      {isMpPlaying && shownNotice && (
        <div className="fixed left-1/2 top-16 z-[96] max-w-[92vw] -translate-x-1/2 rounded-2xl border border-[var(--color-gold)]/70 bg-[var(--bg-card)] px-3 py-1.5 text-center text-[11px] font-semibold leading-snug text-[var(--color-gold)] shadow-lg">
          {shownNotice}
        </div>
      )}

      <motion.div
        className="wc-blink-underlay"
        initial={false}
        animate={{
          opacity: dayNightBlinkPhase === "closing" ? 0.9 : dayNightBlinkPhase === "opening" ? 0.45 : 0,
        }}
        transition={
          dayNightBlinkPhase === "closing"
            ? { duration: DAY_NIGHT_BLINK.closeMs / 1000, ease: [0.22, 0.72, 0.24, 1] }
            : dayNightBlinkPhase === "opening"
              ? { duration: DAY_NIGHT_BLINK.openMs / 1000, ease: [0.16, 0.84, 0.44, 1] }
              : { duration: 0.2 }
        }
      />

      <motion.div
        className="wc-eyelid-overlay"
        style={{
          ["--wc-eye-feather" as any]: 16,
        }}
        initial={false}
        animate={{
          opacity: dayNightBlinkPhase ? 1 : 0,
          ["--wc-lid" as any]: dayNightBlinkPhase === "closing" ? 1 : 0,
        }}
        transition={
          dayNightBlinkPhase === "closing"
            ? { duration: DAY_NIGHT_BLINK.closeMs / 1000, ease: [0.22, 0.72, 0.24, 1] }
            : dayNightBlinkPhase === "opening"
              ? { duration: DAY_NIGHT_BLINK.openMs / 1000, ease: [0.16, 0.84, 0.44, 1] }
              : { duration: 0.2 }
        }
      />

      <AnimatePresence mode="wait" initial={false}>
        {isWelcomeStage ? (
          <motion.div
            key="welcome-stage"
            initial={{ opacity: 0, y: 10, filter: "blur(10px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -10, filter: "blur(10px)" }}
            transition={{ duration: 0.45, ease: "easeOut" }}
            className="h-full w-full"
          >
            <WelcomeScreen
              humanName={humanName}
              setHumanName={setHumanName}
              onStart={(options) => startGame(options ?? {})}
              onAbort={restartGame}
              isLoading={isLoading}
              bgmVolume={bgmVolume}
              isSoundEnabled={isSoundEnabled}
              isAiVoiceEnabled={isAiVoiceEnabled}
              onBgmVolumeChange={setBgmVolume}
              onSoundEnabledChange={setSoundEnabled}
              onAiVoiceEnabledChange={setAiVoiceEnabled}
              onCreateRoom={(seats, options) =>
                mp.createRoom(humanName, seats, {
                  difficulty: options.difficulty,
                  houseRules: options.houseRules,
                })
              }
              onJoinRoom={(code) => mp.joinRoom(code, humanName)}
              inviteCode={inviteCode}
              lastCode={getSavedRoomCode()}
            />
          </motion.div>
        ) : (
          <motion.div
            key="game-stage"
            initial={{ opacity: 0, y: 10, filter: "blur(10px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -10, filter: "blur(10px)" }}
            transition={{ duration: 0.45, ease: "easeOut" }}
            className="h-full w-full flex flex-col overflow-hidden"
          >
            <AnimatePresence>
              {ritualCue && !isRoleRevealOpen && showTable && (
                <motion.div
                  key={`ritual-${ritualCue.id}`}
                  className="fixed inset-0 z-[55] pointer-events-none flex items-center justify-center"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.22 }}
                >
                  <motion.div
                    initial={{ opacity: 0, y: 12, scale: 0.995, filter: "blur(10px)" }}
                    animate={{
                      opacity: [0, 1, 1, 0],
                      y: [12, 0, 0, -10],
                      scale: [0.995, 1, 1, 0.995],
                      filter: ["blur(10px)", "blur(0px)", "blur(0px)", "blur(12px)"],
                    }}
                    transition={{ duration: RITUAL_CUE_DURATION_SECONDS, times: [0, 0.15, 0.82, 1], ease: "easeInOut" }}
                    onAnimationComplete={() => {
                      const finishedId = ritualCue.id;
                      setRitualCue(null);
                      window.setTimeout(() => {
                        const queued = ritualCueQueueRef.current;
                        const next = queued.shift();
                        if (next) {
                          setRitualCue((current) => (current ? current : next));
                          return;
                        }
                        setLastRitualMessageId((current) => (current ?? finishedId));
                      }, 0);
                    }}
                    className="relative px-10 py-6 text-center"
                  >
                    <div
                      className="absolute inset-0 -z-10"
                      style={{
                        background:
                          "radial-gradient(circle at 50% 50%, rgba(184,134,11,0.18) 0%, rgba(184,134,11,0.10) 35%, rgba(0,0,0,0) 70%)",
                        filter: "blur(0.5px)",
                      }}
                    />

                    <motion.div
                      className="mx-auto h-px w-40"
                      initial={{ opacity: 0, scaleX: 0.75 }}
                      animate={{ opacity: 1, scaleX: 1 }}
                      transition={{ duration: 0.5, ease: "easeOut" }}
                      style={{ background: "linear-gradient(90deg, transparent, rgba(184,134,11,0.55), transparent)" }}
                    />

                    <div
                      className="mt-4 text-2xl md:text-3xl font-black tracking-tight font-serif text-[var(--text-primary)]"
                      style={{
                        textShadow:
                          "0 2px 14px rgba(0,0,0,0.35), 0 0 22px rgba(184,134,11,0.22)",
                      }}
                    >
                      {ritualCue.title}
                    </div>

                    {ritualCue.subtitle && (
                      <div
                        className="mt-2 text-sm text-[var(--text-secondary)]"
                        style={{ textShadow: "0 2px 10px rgba(0,0,0,0.30)" }}
                      >
                        {ritualCue.subtitle}
                      </div>
                    )}

                    <motion.div
                      className="mx-auto mt-4 h-px w-40"
                      initial={{ opacity: 0, scaleX: 0.75 }}
                      animate={{ opacity: 1, scaleX: 1 }}
                      transition={{ duration: 0.5, ease: "easeOut" }}
                      style={{ background: "linear-gradient(90deg, transparent, rgba(184,134,11,0.35), transparent)" }}
                    />
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            {humanPlayer && (
              <RoleRevealOverlay
                open={isRoleRevealOpen}
                player={humanPlayer}
                phase={gameState.phase}
                onContinue={async () => {
                  setIsRoleRevealOpen(false);
                  // 联机客人：看牌只是本地一步，不驱动引擎（整局由房主推进）
                  if (isGuestPlaying) return;
                  await continueAfterRoleReveal();
                }}
              />
            )}

            <NightActionOverlay overlay={nightActionOverlay} />

            <TutorialOverlay
              open={isTutorialOpen}
              tutorial={activeTutorial}
              onOpenChange={handleTutorialOpenChange}
              autoPromptEnabled={tutorialState.enabled}
              onAutoPromptChange={setAutoPromptEnabled}
            />

            {showTable && (
              <div className="wc-topbar wc-topbar--responsive shrink-0 transition-all duration-300">
                <div className="wc-topbar__title">
                  <PawPrint size={22} weight="fill" className="text-[var(--color-blood)]" />
                  <span>{BRAND.nameEn}</span>
                </div>

                <div className="wc-topbar__info">
                  <div className="wc-topbar__item">
                    <span className="text-xs uppercase tracking-wider opacity-60">Day</span>
                    <span className="font-serif text-lg font-bold">{String(gameState.day).padStart(2, '0')}</span>
                  </div>
                  <div className="wc-topbar__item">
                    <span className="text-xs uppercase tracking-wider opacity-60">Alive</span>
                    <span className="font-serif text-lg font-bold">{gameState.players.filter((p) => p.alive).length}/{gameState.players.length}</span>
                  </div>
                  {gameState.badge.holderSeat !== null && (
                    <div className="wc-topbar__item">
                      <span className="text-xs uppercase tracking-wider opacity-60">警徽</span>
                      <span className="font-serif text-lg font-bold text-[var(--color-gold)]">{gameState.badge.holderSeat + 1}号</span>
                    </div>
                  )}
                  <div className="wc-phase-badge">
                    <span className="opacity-90">{renderPhaseIcon()}</span>
                    <span>{getPhaseDescription()}</span>
                    {showWaitingIndicator && (
                      <span className="flex items-center gap-1 ml-1">
                        <motion.span animate={{ scale: [1, 1.25, 1] }} transition={{ repeat: Infinity, duration: 0.7, delay: 0 }} className="w-1.5 h-1.5 rounded-full bg-current" />
                        <motion.span animate={{ scale: [1, 1.25, 1] }} transition={{ repeat: Infinity, duration: 0.7, delay: 0.15 }} className="w-1.5 h-1.5 rounded-full bg-current" />
                        <motion.span animate={{ scale: [1, 1.25, 1] }} transition={{ repeat: Infinity, duration: 0.7, delay: 0.3 }} className="w-1.5 h-1.5 rounded-full bg-current" />
                      </span>
                    )}
                    {needsHumanAction && (
                      <span className="flex items-center gap-1.5 font-semibold text-xs px-2 py-0.5 rounded-full ml-1 bg-[var(--color-gold)]/20 text-[var(--color-gold)]">
                        <span className="w-1.5 h-1.5 bg-current rounded-full animate-pulse" />
                        轮到你
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="wc-topbar__item wc-topbar__item--role">
                    <span className="text-xs uppercase tracking-wider opacity-60">身份</span>
                    <span className="font-bold text-[var(--color-gold)]">
                      {canShowRole ? getRoleLabel(humanPlayer?.role) : "待揭晓"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsRulesOpen(true)}
                    title="资料 · 玩法与神职能力"
                    aria-label="资料"
                    className="inline-flex items-center gap-2 rounded-md border-2 border-[var(--border-color)] bg-[var(--bg-card)] px-2 py-1.5 sm:px-2.5 sm:py-1 text-xs text-[var(--text-primary)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-bg)]"
                  >
                    <BookOpen size={16} className="shrink-0" />
                    <span className="hidden sm:inline">资料</span>
                  </button>
                  {/* 喵杀新增：语音语速选择（资料旁边），默认 1.25×，只影响人声 */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        title="语音语速（只影响人声，不影响背景音乐）"
                        aria-label="语音语速"
                        className="inline-flex items-center gap-2 rounded-md border-2 border-[var(--border-color)] bg-[var(--bg-card)] px-2 py-1.5 sm:px-2.5 sm:py-1 text-xs text-[var(--text-primary)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-bg)]"
                      >
                        <SpeakerHigh size={16} className="shrink-0" />
                        <span className="hidden sm:inline">语速</span>
                        <span className="tabular-nums">{speechRate}×</span>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {SPEECH_RATE_OPTIONS.map((r) => (
                        <DropdownMenuCheckboxItem
                          key={r}
                          checked={speechRate === r}
                          onCheckedChange={() => setSpeechRate(r)}
                          onSelect={(e) => e.preventDefault()}
                          className="tabular-nums"
                        >
                          {r}×{r === DEFAULT_SPEECH_RATE ? "（默认）" : ""}
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    type="button"
                    onClick={() => setIsSettingsOpen(true)}
                    title="声音设置"
                    aria-label="声音设置"
                    className="inline-flex items-center gap-2 rounded-md border-2 border-[var(--border-color)] bg-[var(--bg-card)] px-2 py-1.5 sm:px-2.5 sm:py-1 text-xs text-[var(--text-primary)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-bg)]"
                  >
                    <GearSix size={16} className="shrink-0" />
                    <span className="hidden sm:inline">设置</span>
                  </button>
                </div>
              </div>
            )}

            <div className="flex flex-1 overflow-hidden">
              <div className="flex-1 flex flex-col bg-transparent min-h-0 overflow-hidden">
                <AnimatePresence mode="wait" initial={false}>
                  {(
                    <motion.div
                      key="table-screen"
                      initial={{ opacity: 0, y: 10, filter: "blur(10px)" }}
                      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                      exit={{ opacity: 0, y: -10, filter: "blur(10px)" }}
                      transition={{ duration: 0.45, ease: "easeOut" }}
                      className="flex-1 flex flex-col min-h-0 overflow-hidden"
                    >
                {/* 主布局 - 严格对齐 style-unification-preview.html */}
                <div className="flex-1 flex gap-4 lg:gap-6 lg:px-6 lg:py-6 overflow-hidden w-full justify-center min-h-0">
                  {/* 左侧玩家卡片 */}
                  <div className="hidden md:flex w-[220px] lg:w-[240px] xl:w-[260px] 2xl:w-[300px] flex-col gap-3 shrink-0 overflow-y-auto overflow-x-visible scrollbar-hide pt-2 pb-2 px-1 -mx-1">
                    <AnimatePresence>
                      {leftPlayers.map((player, index) => {
                        const checkResult =
                          humanPlayer?.role === "Seer"
                            ? gameState.nightActions.seerHistory?.find((h) => h.targetSeat === player.seat)
                            : undefined;
                        const seerResult = checkResult ? (checkResult.isWolf ? "wolf" : "good") : null;
                        const isBadgeCandidate = (gameState.phase === "DAY_BADGE_ELECTION" || gameState.phase === "DAY_BADGE_SPEECH") && 
                          (gameState.badge.candidates || []).includes(player.seat);

                        return (
                          <PlayerCardCompact
                            key={player.playerId}
                            player={player}
                            isSpeaking={displaySpeakerSeat === player.seat}
                            canClick={canClickSeat(player)}
                            isSelected={selectedSeat === player.seat}
                            onClick={() => handleSeatClick(player)}
                            onDetailClick={isSelectionPhase ? undefined : () => setDetailPlayer(player)}
                            animationDelay={index * 0.05}
                            isNight={visualIsNight}
                            isGenshinMode={gameState?.isGenshinMode ?? isGenshinMode}
                            humanPlayer={humanPlayer}
                            seerCheckResult={seerResult}
                            isBadgeHolder={gameState.badge.holderSeat === player.seat}
                            isBadgeCandidate={isBadgeCandidate}
                            showRoleBadge={canShowRole}
                            showModel={gameState.phase === "GAME_END"}
                            selectionTone={selectionTone}
                          />
                        );
                      })}
                    </AnimatePresence>
                  </div>

                  {/* 中间区域：对话区 */}
                  <div className="flex-1 flex flex-col min-w-0 min-h-0 h-full max-w-[980px] lg:max-w-[1100px] xl:max-w-[1200px] 2xl:max-w-[1280px] overflow-hidden">
                    <DialogArea
                      gameState={gameState}
                      humanPlayer={humanPlayer}
                      isNight={visualIsNight}
                      isSoundEnabled={isSoundEnabled}
                      isAiVoiceEnabled={shouldUseAiVoice}
                      currentDialogue={effectiveDialogue}
                      displayedText={displayedText}
                      isTyping={isTyping}
                      onAdvanceDialogue={handleAdvanceDialogue}
                      isHumanTurn={humanTurnSeat !== null}
                      waitingForNextRound={waitingForNextRound}
                      // 联机已读到最新时不再提示「点击/回车继续」（点了确实没什么可推的）
                      // 客人尤其如此：客人不再驱动房主引擎，显示「继续」会造成「点了没反应」的错觉
                      suppressManualContinue={
                        isMpPlaying &&
                        !pendingMessage &&
                        (!waitingForNextRound || isGuestPlaying)
                      }
                      // 中间对话区只显示本机读到的部分：读一句才显示一句，未读的不铺出来
                      revealUpToCount={revealedRawCount}
                      tutorialHelpLabel={tutorialHelpLabel}
                      showTutorialHelp={showTutorialHelp}
                      onTutorialOpen={handleTutorialHelpOpen}
                      inputText={inputText}
                      onInputChange={setInputText}
                      onSendMessage={effectiveSpeech}
                      onFinishSpeaking={effectiveFinishSpeaking}
                      selectedSeat={selectedSeat}
                      isWaitingForAI={isWaitingForAI}
                      onConfirmAction={confirmSelectedSeat}
                      onCancelSelection={() => setSelectedSeat(null)}
                      onNightAction={handleNightActionConfirm}
                      onBadgeSignup={effectiveBadgeSignup}
                      onRestart={() => { setShowAnalysis(false); clearAnalysis(); restartGame(); }}
                      onShowAnalysis={gameState.phase === "GAME_END" ? () => setShowAnalysis(true) : undefined}
                      isAnalysisLoading={isAnalysisLoading}
                    />

                    {/* 移动端玩家条 */}
                    <div className="wc-mobile-player-bar md:hidden">
                      <div className="wc-mobile-player-bar__track">
                        {allPlayers.map((player, index) => {
                          const checkResult =
                            humanPlayer?.role === "Seer"
                              ? gameState.nightActions.seerHistory?.find((h) => h.targetSeat === player.seat)
                              : undefined;
                          const seerResult = checkResult ? (checkResult.isWolf ? "wolf" : "good") : null;
                          const isBadgeCandidate = (gameState.phase === "DAY_BADGE_ELECTION" || gameState.phase === "DAY_BADGE_SPEECH") &&
                            (gameState.badge.candidates || []).includes(player.seat);

                          return (
                            <PlayerCardCompact
                              key={player.playerId}
                              player={player}
                              isSpeaking={displaySpeakerSeat === player.seat}
                              canClick={canClickSeat(player)}
                              isSelected={selectedSeat === player.seat}
                              onClick={() => handleSeatClick(player)}
                              onDetailClick={isSelectionPhase ? undefined : () => setDetailPlayer(player)}
                              animationDelay={index * 0.02}
                              isNight={visualIsNight}
                              isGenshinMode={gameState?.isGenshinMode ?? isGenshinMode}
                              humanPlayer={humanPlayer}
                              seerCheckResult={seerResult}
                              isBadgeHolder={gameState.badge.holderSeat === player.seat}
                              isBadgeCandidate={isBadgeCandidate}
                              variant="mobile"
                              showRoleBadge={canShowRole}
                              selectionTone={selectionTone}
                            />
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* 右侧玩家卡片 */}
                  <div className="hidden md:flex w-[220px] lg:w-[240px] xl:w-[260px] 2xl:w-[300px] flex-col gap-3 shrink-0 overflow-y-auto overflow-x-visible scrollbar-hide pt-2 pb-2 px-1 -mx-1">
                    <AnimatePresence>
                      {rightPlayers.map((player, index) => {
                        const checkResult =
                          humanPlayer?.role === "Seer"
                            ? gameState.nightActions.seerHistory?.find((h) => h.targetSeat === player.seat)
                            : undefined;
                        const seerResult = checkResult ? (checkResult.isWolf ? "wolf" : "good") : null;
                        const isBadgeCandidate = (gameState.phase === "DAY_BADGE_ELECTION" || gameState.phase === "DAY_BADGE_SPEECH") && 
                          (gameState.badge.candidates || []).includes(player.seat);

                        return (
                          <PlayerCardCompact
                            key={player.playerId}
                            player={player}
                            isSpeaking={displaySpeakerSeat === player.seat}
                            canClick={canClickSeat(player)}
                            isSelected={selectedSeat === player.seat}
                            onClick={() => handleSeatClick(player)}
                            onDetailClick={isSelectionPhase ? undefined : () => setDetailPlayer(player)}
                            animationDelay={index * 0.05}
                            isNight={visualIsNight}
                            isGenshinMode={gameState?.isGenshinMode ?? isGenshinMode}
                            humanPlayer={humanPlayer}
                            seerCheckResult={seerResult}
                            isBadgeHolder={gameState.badge.holderSeat === player.seat}
                            isBadgeCandidate={isBadgeCandidate}
                            showRoleBadge={canShowRole}
                            showModel={gameState.phase === "GAME_END"}
                            selectionTone={selectionTone}
                          />
                        );
                      })}
                    </AnimatePresence>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )}
</AnimatePresence>

      {/* 笔记本悬浮按钮 - 参考 style-unification-preview.html */}
      <button
        onClick={() => setIsNotebookOpen((v) => !v)}
        className="wc-notebook-fab"
        title={isNotebookOpen ? "关闭笔记" : "打开笔记"}
        type="button"
      >
        {isNotebookOpen ? <X size={24} /> : <NotePencil size={24} />}
      </button>

      <AnimatePresence>
        {isNotebookOpen && (
          <motion.div
            key="notebook-panel"
            initial={isMobile ? { opacity: 0, y: 24 } : { opacity: 0, x: 24, y: 12, scale: 0.98 }}
            animate={isMobile ? { opacity: 1, y: 0 } : { opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={isMobile ? { opacity: 0, y: 24 } : { opacity: 0, x: 24, y: 12, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="wc-notebook-panel fixed bottom-20 right-5 z-50 w-[360px] h-[480px] max-h-[70vh]"
          >
            <div className="h-full rounded-t-2xl md:rounded-lg overflow-hidden border shadow-2xl glass-panel glass-panel--strong">
              <Notebook />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 玩家详情弹窗 */}
      <PlayerDetailModal
        player={detailPlayer}
        isOpen={detailPlayer !== null}
        onClose={() => setDetailPlayer(null)}
        humanPlayer={humanPlayer}
        isGenshinMode={gameState?.isGenshinMode ?? isGenshinMode}
      />

      <SettingsModal
        open={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        bgmVolume={bgmVolume}
        isSoundEnabled={isSoundEnabled}
        isAiVoiceEnabled={isAiVoiceEnabled}
        gameState={gameState}
        onBgmVolumeChange={setBgmVolume}
        onSoundEnabledChange={setSoundEnabled}
        onAiVoiceEnabledChange={setAiVoiceEnabled}
        onAbortGame={restartGame}
      />

      <RulesModal open={isRulesOpen} onOpenChange={setIsRulesOpen} />

      {/* 开发者模式 - 只在游戏开始后显示 */}
      {showTable && showDevTools && (
        <>
          <DevModeButton onClick={() => setIsDevConsoleOpen(true)} />
          <DevConsole isOpen={isDevConsoleOpen} onClose={() => setIsDevConsoleOpen(false)} />
        </>
      )}

      {/* 游戏复盘分析页面 */}
      {showAnalysis && analysisData && (
        <div className="fixed inset-0 z-[100] overflow-y-auto bg-[#0a0a0f]">
          <PostGameAnalysisPage
            data={analysisData}
            onReturn={() => setShowAnalysis(false)}
          />
        </div>
      )}

      {/* 技能演出全屏 FX 层（pointer-events:none；key 带 id 以便连续同类技能能重播动画） */}
      {skillFx && (
        <div key={`${skillFx.kind}-${skillFx.id}`} className="wc-skill-fx" aria-hidden="true">
          <div
            className={
              skillFx.kind === "gun"
                ? "wc-fx-gun-layer"
                : skillFx.kind === "boom"
                  ? "wc-fx-boom-layer"
                  : skillFx.kind === "badge"
                    ? "wc-fx-badge-layer"
                    : "wc-fx-reveal-layer"
            }
          />
        </div>
      )}
      {/* 联机 · 房主刷新恢复提示（2026-10-17） */}
      {hostNeedsRecovery && (
        <div className="fixed inset-x-0 top-0 z-[70] flex justify-center p-3">
          <div className="flex max-w-md items-center gap-3 rounded-lg border border-amber-400/40 bg-amber-500/15 px-4 py-3 text-sm text-amber-100 backdrop-blur">
            <span className="flex-1">
              房主页面被刷新，正在进行的这一局已无法继续喵（本地引擎状态已丢失）。
            </span>
            <button
              type="button"
              onClick={() => {
                void mp.resetToLobby();
              }}
              className="shrink-0 rounded-md border border-amber-300/50 bg-amber-400/20 px-3 py-1.5 text-xs font-medium hover:bg-amber-400/30"
            >
              本局作废 · 回到大厅
            </button>
          </div>
        </div>
      )}
      {/* 诊断用：任何未捕获报错都在屏幕上显示原文（把「黑屏」变成「看得见的报错」） */}
      {fatalError && (
        <div className="fixed inset-0 z-[9999] overflow-y-auto bg-[rgba(8,6,10,0.96)] p-4">
          <div className="mx-auto max-w-[720px] rounded-xl border-2 border-[var(--color-blood)] bg-[#140a0e] p-4 text-[13px] text-[#ffd9de]">
            <div className="mb-2 flex items-center justify-between">
              <b className="font-serif text-base">喵杀出错了喵 —— 请把下面这段发给开发者</b>
              <button
                type="button"
                onClick={() => setFatalError(null)}
                className="rounded border border-[var(--color-blood)]/60 px-2 py-0.5 text-xs"
              >
                关掉
              </button>
            </div>
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-3 font-mono text-[12px] leading-relaxed">
              {fatalError}
            </pre>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  try {
                    void navigator.clipboard?.writeText(fatalError);
                  } catch {
                    /* ignore */
                  }
                }}
                className="rounded border border-[var(--color-blood)]/60 px-2 py-1 text-xs"
              >
                复制报错
              </button>
              <span className="text-xs opacity-70">（也可以直接截图这一段）</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
