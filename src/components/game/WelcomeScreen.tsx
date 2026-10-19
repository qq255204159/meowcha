"use client";

import { motion, AnimatePresence } from "framer-motion";
import { FingerprintSimple, PawPrint, Sparkle, Wrench, GearSix, UserCircle, GithubLogo, DotsThreeOutlineVertical, Users, BookOpen } from "@phosphor-icons/react";
import { WerewolfIcon } from "@/components/icons/FlatIcons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { DevPreset, DifficultyLevel, HouseRules, Role, StartGameOptions } from "@/types/game";
import { DevModeButton } from "@/components/DevTools";
import { GameSetupModal } from "@/components/game/GameSetupModal";
import { AuthModal } from "@/components/game/AuthModal";
import { SharePanel } from "@/components/game/SharePanel";
import { AccountModal } from "@/components/game/AccountModal";
import { ResetPasswordModal } from "@/components/game/ResetPasswordModal";
import { UserProfileModal } from "@/components/game/UserProfileModal";
import { useCredits } from "@/hooks/useCredits";
import { RulesModal } from "@/components/game/RulesModal";
import { MultiplayerEntryDialog } from "@/components/game/MultiplayerEntryDialog";
import { isApiConfigured } from "@/lib/api-config";
import { BRAND } from "@/lib/brand";
import { loadHouseRules, saveHouseRules } from "@/lib/house-rules";
import { getRoleConfiguration } from "@/lib/game-master";
import { isWolfRole } from "@/types/game";

// 2026-10-17：各人数局配比统一到 game-master 的 ROLE_COMPOSITIONS（唯一真源，避免 UI 与发牌不一致）
function buildDefaultRoles(playerCount: number): Role[] {
  return getRoleConfiguration(playerCount);
}

function getRoleCountConfig(playerCount: number) {
  const roles = getRoleConfiguration(playerCount);
  return {
    wolfCount: roles.filter((r) => isWolfRole(r)).length,
    guardCount: roles.filter((r) => r === "Guard").length,
    seerCount: roles.filter((r) => r === "Seer").length,
    witchCount: roles.filter((r) => r === "Witch").length,
    hunterCount: roles.filter((r) => r === "Hunter").length,
    // 白痴在自定义校验里与村民同组（可互换），故合并计数
    villagerCount: roles.filter((r) => r === "Villager" || r === "Idiot").length,
  };
}

interface WelcomeScreenProps {
  humanName: string;
  setHumanName: (name: string) => void;
  onStart: (options?: StartGameOptions) => void | Promise<void>;
  onAbort?: () => void;
  isLoading: boolean;
  bgmVolume: number;
  isSoundEnabled: boolean;
  isAiVoiceEnabled: boolean;
  onBgmVolumeChange: (value: number) => void;
  onSoundEnabledChange: (value: boolean) => void;
  onAiVoiceEnabledChange: (value: boolean) => void;
  /** 喵杀联机：建房（返回是否成功） */
  onCreateRoom?: (seats: number, options: { difficulty: DifficultyLevel; houseRules: HouseRules }) => Promise<boolean>;
  /** 喵杀联机：凭邀请码入房 */
  onJoinRoom?: (code: string) => Promise<boolean>;
  /** 邀请链接带进来的房间码 */
  inviteCode?: string;
  /** 上次建房的邀请码 */
  lastCode?: string;
  /** 联机服务状态 */
  mpBusy?: boolean;
}

export function WelcomeScreen({
  humanName,
  setHumanName,
  onStart,
  onAbort,
  isLoading,
  bgmVolume,
  isSoundEnabled,
  isAiVoiceEnabled,
  onBgmVolumeChange,
  onSoundEnabledChange,
  onAiVoiceEnabledChange,
  onCreateRoom,
  onJoinRoom,
  inviteCode,
  lastCode,
  mpBusy,
}: WelcomeScreenProps) {
  const {
    user,
    credits,
    referralCode,
    totalReferrals,
    loading: creditsLoading,
    signOut,
    isPasswordRecovery,
    clearPasswordRecovery,
  } = useCredits();
  const [isSetupOpen, setIsSetupOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isModeOpen, setIsModeOpen] = useState(false);
  // 过场遮罩「卡住」看门狗：开局要逐个召集 AI 猫（要调模型），万一慢/失败，
  // 原来会一直停在黑屏遮罩上且没有任何按钮 —— 这里显示已等待秒数 + 一个返回按钮。
  const [transitionElapsed, setTransitionElapsed] = useState(0);
  useEffect(() => {
    if (!isTransitioning) {
      setTransitionElapsed(0);
      return;
    }
    const timer = window.setInterval(() => setTransitionElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isTransitioning]);

  // 开局失败兜底：过场遮罩只在「正在开局」时该留着。一旦 isLoading 已经落回 false
  // 而遮罩还挂着，说明 startGame 抛错了（最常见的元凶是「一次性生成全部 AI 角色」那步
  // 模型返回坏 JSON）—— 原来这里会永远停在黑屏遮罩上、一个按钮都没有。
  useEffect(() => {
    if (!isTransitioning) return;
    if (isLoading) return;
    // 800ms 是盖章→onStart 的固定过场时长，给它留足余量再判断
    const timer = window.setTimeout(() => {
      setIsTransitioning(false);
      toast("开局失败了喵", { description: "请再点一次印章重试；如果反复失败，把控制台报错发给开发者。" });
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [isTransitioning, isLoading]);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const sealButtonRef = useRef<HTMLButtonElement | null>(null);
  const isStartingRef = useRef(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isUserProfileOpen, setIsUserProfileOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isRulesOpen, setIsRulesOpen] = useState(false);
  const [difficulty, setDifficulty] = useState<DifficultyLevel>("normal");
  const [playerCount, setPlayerCount] = useState(12);
  const [houseRules, setHouseRulesState] = useState<HouseRules>(() => loadHouseRules());
  const setHouseRules = (r: HouseRules) => {
    setHouseRulesState(r);
    saveHouseRules(r);
  };

  // 调试面板状态
  const [isDevModeEnabled, setIsDevModeEnabled] = useState(false);
  const [isDevConsoleOpen, setIsDevConsoleOpen] = useState(false);
  const [devTab, setDevTab] = useState<"preset" | "roles">("preset");
  const [devPreset, setDevPreset] = useState<DevPreset | "">("");
  const showDevTools =
    process.env.NODE_ENV !== "production" && (process.env.NEXT_PUBLIC_SHOW_DEVTOOLS ?? "true") === "true";

  const roleOptions: Role[] = ["Villager", "Werewolf", "Seer", "Witch", "Hunter", "Guard", "WhiteWolfKing", "Idiot"];
  const roleLabels: Record<Role, string> = {
    Villager: "村民",
    Werewolf: "狼人",
    Seer: "预言家",
    Witch: "女巫",
    Hunter: "猎人",
    Guard: "守卫",
    WhiteWolfKing: "白狼王",
    Idiot: "白痴",
  };

  const [fixedRoles, setFixedRoles] = useState<(Role | "")[]>(() => buildDefaultRoles(12));

  useEffect(() => {
    setFixedRoles(buildDefaultRoles(playerCount));
  }, [playerCount]);


  const roleConfigValid = useMemo(() => {
    if (fixedRoles.length !== playerCount) return false;
    if (fixedRoles.some((r) => !r)) return false;

    const counts: Record<Role, number> = {
      Villager: 0,
      Werewolf: 0,
      Seer: 0,
      Witch: 0,
      Hunter: 0,
      Guard: 0,
      WhiteWolfKing: 0,
      Idiot: 0,
    };
    for (const r of fixedRoles) {
      counts[r as Role] += 1;
    }

    const expected = getRoleCountConfig(playerCount);
    const totalWolves = counts.Werewolf + counts.WhiteWolfKing;
    const totalVillagers = counts.Villager + counts.Idiot;
    return (
      totalWolves === expected.wolfCount &&
      counts.Seer === expected.seerCount &&
      counts.Witch === expected.witchCount &&
      counts.Hunter === expected.hunterCount &&
      counts.Guard === expected.guardCount &&
      totalVillagers === expected.villagerCount
    );
  }, [fixedRoles, playerCount]);

  const roleConfigHint = useMemo(() => {
    const expected = getRoleCountConfig(playerCount);
    const godLabel = [
      "预",
      "女",
      expected.hunterCount > 0 ? "猎" : "",
      expected.guardCount > 0 ? "守" : "",
    ].filter(Boolean).join("");
    return `需满足：${expected.wolfCount}狼 ${godLabel} ${expected.villagerCount}民`;
  }, [playerCount]);

  const canConfirm = useMemo(() => {
    return !!humanName.trim() && !isLoading && !isTransitioning && !creditsLoading;
  }, [humanName, isLoading, isTransitioning, creditsLoading]);

  const difficultyLabel = useMemo(() => {
    const labels: Record<DifficultyLevel, string> = {
      easy: "新手局",
      normal: "标准局",
      hard: "高阶局",
    };
    return labels[difficulty];
  }, [difficulty]);

  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;

    if (typeof window === "undefined") return;
    if ("ontouchstart" in window) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let rafId: number | null = null;
    let lastX = 0;
    let lastY = 0;

    const update = () => {
      rafId = null;
      const xAxis = (window.innerWidth / 2 - lastX) / 60;
      const yAxis = (window.innerHeight / 2 - lastY) / 60;
      paper.style.setProperty("--wc-tilt-x", `${xAxis}`);
      paper.style.setProperty("--wc-tilt-y", `${yAxis}`);
    };

    const onMove = (e: MouseEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(update);
    };

    const onLeave = () => {
      paper.style.setProperty("--wc-tilt-x", "0");
      paper.style.setProperty("--wc-tilt-y", "0");
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, []);

  const createParticles = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    for (let i = 0; i < 18; i += 1) {
      const particle = document.createElement("div");
      particle.className = "wc-particle";
      document.body.appendChild(particle);

      const size = Math.random() * 7 + 2;
      particle.style.width = `${size}px`;
      particle.style.height = `${size}px`;
      particle.style.left = `${centerX}px`;
      particle.style.top = `${centerY}px`;

      const angle = Math.random() * Math.PI * 2;
      const velocity = Math.random() * 90 + 40;
      const tx = Math.cos(angle) * velocity;
      const ty = Math.sin(angle) * velocity - 90;

      particle.animate(
        [
          { transform: "translate(0, 0) scale(1)", opacity: 1 },
          { transform: `translate(${tx}px, ${ty}px) scale(0)`, opacity: 0 },
        ],
        {
          duration: 900 + Math.random() * 450,
          easing: "cubic-bezier(0, .9, .57, 1)",
          fill: "forwards",
        }
      );

      window.setTimeout(() => particle.remove(), 1600);
    }
  };

  const handleConfirm = async () => {
    if (!canConfirm) return;
    if (isStartingRef.current) return;

    // 检查 AI 模型配置：玩家填写 > 服务器默认；两边都没有则 AI 猫无法发言
    if (!isApiConfigured()) {
      setIsSetupOpen(true);
      toast("还没有可用的 AI 模型配置", {
        description: "服务器没有提供默认配置，请在「设置 → AI 模型」里填写 API Key，否则 AI 猫不会说话喵。",
      });
      return;
    }

    // [已禁用] 登录检查
    // if (!user) {
    //   setIsAuthOpen(true);
    //   toast("请先登录或注册");
    //   return;
    // }

    // [已禁用] 额度检查
    // if (credits !== null && credits <= 0) {
    //   setIsShareOpen(true);
    //   toast("额度不足", { description: "分享邀请可获得更多额度。" });
    //   return;
    // }

    isStartingRef.current = true;

    const seal = sealButtonRef.current;
    if (seal) createParticles(seal);

    // 喵杀联机（2026-10-16）：盖完章不再直奔开局，先给一次「怎么开局」的选择
    // —— 直接单人开局 / 建房邀朋友 / 凭邀请码进朋友的房间
    setIsModeOpen(true);
    isStartingRef.current = false;
  };

  /** 单人开局：沿用原来的盖章过场 */
  const handleSoloStart = () => {
    setIsModeOpen(false);
    setIsTransitioning(true);
    window.setTimeout(() => {
      const roles = devTab === "roles" && roleConfigValid ? (fixedRoles as Role[]) : undefined;
      const preset = devTab === "preset" && devPreset ? (devPreset as DevPreset) : undefined;
      void onStart({ fixedRoles: roles, devPreset: preset, difficulty, playerCount, houseRules });
    }, 800);
  };

  return (
    <>
    <div className="wc-contract-screen selection:bg-[var(--color-accent)] selection:text-white">
      <div className="wc-contract-fog" aria-hidden="true" />
      <div className="wc-contract-vignette" aria-hidden="true" />

      <GameSetupModal
        open={isSetupOpen}
        onOpenChange={setIsSetupOpen}
        bgmVolume={bgmVolume}
        isSoundEnabled={isSoundEnabled}
        isAiVoiceEnabled={isAiVoiceEnabled}
        onBgmVolumeChange={onBgmVolumeChange}
        onSoundEnabledChange={onSoundEnabledChange}
        onAiVoiceEnabledChange={onAiVoiceEnabledChange}
      />
      {/* [已禁用] 登录弹窗 */}
      {/* <AuthModal open={isAuthOpen} onOpenChange={setIsAuthOpen} /> */}
      <AccountModal open={isAccountOpen} onOpenChange={setIsAccountOpen} />
      <UserProfileModal
        open={isUserProfileOpen}
        onOpenChange={setIsUserProfileOpen}
        email={user?.email}
        credits={credits ?? undefined}
        referralCode={referralCode}
        totalReferrals={totalReferrals}
        onChangePassword={() => setIsAccountOpen(true)}
        onShareInvite={() => setIsShareOpen(true)}
        onSignOut={signOut}
      />
      <ResetPasswordModal 
        open={isPasswordRecovery} 
        onOpenChange={(open) => !open && clearPasswordRecovery()}
        onSuccess={clearPasswordRecovery}
      />
      <SharePanel
        open={isShareOpen}
        onOpenChange={setIsShareOpen}
        referralCode={referralCode}
        totalReferrals={totalReferrals}
      />

      <RulesModal open={isRulesOpen} onOpenChange={setIsRulesOpen} />

      {/* 喵杀联机 · 开局方式（单人 / 建房邀朋友 / 凭码入房） */}
      <MultiplayerEntryDialog
        open={isModeOpen}
        onOpenChange={setIsModeOpen}
        onSolo={handleSoloStart}
        onCreateRoom={async (seats) => {
          if (!onCreateRoom) return false;
          const ok = await onCreateRoom(seats, { difficulty, houseRules });
          if (!ok) toast("建房失败，稍后再试喵");
          return ok;
        }}
        onJoinRoom={async (code) => {
          if (!onJoinRoom) return false;
          const ok = await onJoinRoom(code);
          if (!ok) toast("进不去这个房间喵");
          return ok;
        }}
        lastCode={lastCode}
        initialCode={inviteCode}
        busy={mpBusy}
        difficulty={difficulty}
        onDifficultyChange={setDifficulty}
        playerCount={playerCount}
        onPlayerCountChange={setPlayerCount}
        houseRules={houseRules}
        onHouseRulesChange={setHouseRules}
      />

      <Dialog open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>快捷操作</DialogTitle>
            <DialogDescription>在这里快速进入设置与账号信息。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Button
              type="button"
              variant="outline"
              className="justify-start"
              onClick={() => {
                setIsMobileMenuOpen(false);
                setIsSetupOpen(true);
              }}
            >
              <GearSix size={16} />
              设置
            </Button>
            {user ? (
              <Button
                type="button"
                variant="outline"
                className="justify-start"
                onClick={() => {
                  setIsMobileMenuOpen(false);
                  setIsUserProfileOpen(true);
                }}
              >
                <UserCircle size={16} />
                账号信息
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <div className="wc-welcome-actions absolute top-5 right-5 z-20 flex items-center gap-2">
        {/* 资料（玩法与神职能力）· 2026-10-16 新增 · 放在 hidden sm:flex 之外，移动端也可见 */}
        <Button
          type="button"
          variant="outline"
          onClick={() => setIsRulesOpen(true)}
          className="h-8 text-xs gap-2"
        >
          <BookOpen size={16} />
          资料
        </Button>

        <div className="hidden sm:flex items-center gap-2">
          {user ? (
            <button
              type="button"
              onClick={() => setIsUserProfileOpen(true)}
              className="hidden md:flex items-center gap-2 rounded-md border-2 border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              title="查看账号信息"
            >
              <UserCircle size={16} />
              <span className="truncate max-w-[160px]">{user.email ?? "已登录"}</span>
              <span className="opacity-70">剩余 {creditsLoading ? "..." : (credits ?? 0)} 局</span>
            </button>
          ) : null
          /* [已禁用] 登录按钮
          : (
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsAuthOpen(true)}
              className="h-8 text-xs gap-2"
            >
              <UserCircle size={16} />
              登录/注册
            </Button>
          )
          */}

          {user && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsUserProfileOpen(true)}
              className="h-8 text-xs gap-2 md:hidden"
            >
              <UserCircle size={16} />
              账号信息
            </Button>
          )}

          <Button
            type="button"
            variant="outline"
            onClick={() => setIsSetupOpen(true)}
            className="h-8 text-xs gap-2"
          >
            <GearSix size={16} />
            设置
          </Button>
        </div>

        <div className="flex sm:hidden items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setIsMobileMenuOpen(true)}
            className="h-8 w-8 px-0"
            aria-label="更多操作"
          >
            <DotsThreeOutlineVertical size={18} />
          </Button>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 14, scale: 0.99, filter: "blur(10px)" }}
        animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
        transition={{ duration: 0.65, ease: "easeOut" }}
        className="relative z-10 w-full max-w-[460px] px-6"
      >
        <div ref={paperRef} className="wc-contract-paper">
          <div className="wc-contract-borders" aria-hidden="true" />

          <div className="mt-2 text-center">
            <div className="mx-auto mb-4 h-12 w-12 items-center justify-center text-[var(--color-wolf)] opacity-90 hidden sm:flex">
              <PawPrint weight="fill" size={42} />
            </div>
            <div className="wc-contract-title">{BRAND.nameEn}</div>
            <div className="wc-contract-subtitle">{BRAND.tagline}</div>
          </div>

          <div className="mt-7 text-center wc-contract-body">
            <div className="wc-contract-oath">
              本喵自愿加入这场关于谎言与真相的游戏。
              <br />
              当夜幕降临，喵会藏好自己的小爪印；
              <br />
              当黎明升起，喵将揪出藏在暗处的小猫腻。
            </div>

            <div className="mt-8">
              <div className="wc-contract-label">签署你的名字</div>
              <div className="relative mt-2">
                <input
                  type="text"
                  value={humanName}
                  onChange={(e) => setHumanName(e.target.value)}
                  placeholder="Signature Here..."
                  className="wc-signature-input"
                  autoComplete="off"
                  autoFocus
                  disabled={isLoading || isTransitioning}
                />
                <AnimatePresence>
                  {!!humanName.trim() && (
                    <motion.div
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.8, opacity: 0 }}
                      className="wc-signature-ok"
                    >
                      <Sparkle weight="fill" size={18} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>

          <div className="mt-8 flex flex-col items-center gap-3">
            <div className="wc-seal-hint">
              {canConfirm ? "按下印章以生效" : "签署名字后才可生效"}
            </div>
            <button
              ref={sealButtonRef}
              type="button"
              className="wc-wax-seal"
              onClick={handleConfirm}
              disabled={!canConfirm}
            >
              <FingerprintSimple weight="fill" size={44} className="wc-wax-seal-icon" />
            </button>
          </div>

          <div className="wc-corner-mark" aria-hidden="true">
            <WerewolfIcon size={30} className="text-[var(--color-wolf)] opacity-30" />
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {isTransitioning && (
          <motion.div
            className="wc-transition-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          >
            <motion.div
              className="wc-transition-text"
              initial={{ opacity: 0, y: 10, scale: 1.05, filter: "blur(10px)" }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
              transition={{ delay: 0.18, duration: 0.55, ease: "easeOut" }}
            >
              <div className="wc-transition-title">游戏开始</div>
              <div className="wc-transition-subtitle">
                {isLoading ? `正在召集 AI 猫…已等待 ${transitionElapsed}s` : "The Game Begins"}
              </div>
              {/* 卡住看门狗：等待超过 12 秒就给出可见的出口（原来这里是黑屏且没有任何按钮） */}
              {transitionElapsed > 12 && (
                <div style={{ marginTop: 18, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                  <div style={{ fontSize: 12, opacity: 0.72, maxWidth: 360, lineHeight: 1.6 }}>
                    还在这儿说明开局没走完（通常在召集 AI 角色）。可以再等等，也可以先退回去。
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setIsTransitioning(false);
                      onAbort?.();
                    }}
                    style={{
                      border: "1px solid rgba(255,255,255,.4)",
                      borderRadius: 8,
                      padding: "8px 14px",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    返回首页
                  </button>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>

    {showDevTools && (
      <>
        <DevModeButton
          onClick={() => {
            setIsDevModeEnabled(true);
            setIsDevConsoleOpen(true);
          }}
        />

        <AnimatePresence>
          {isDevConsoleOpen && (
            <motion.div
              initial={{ opacity: 0, x: 300 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 300 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="wc-dev-console fixed right-0 top-0 bottom-0 w-[400px] z-[120] bg-gray-900/95 backdrop-blur-md border-l border-gray-700 shadow-2xl flex flex-col"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 bg-gray-800/50">
                <div className="flex items-center gap-2">
                  <Wrench size={20} className="text-yellow-400" />
                  <span className="font-bold text-white">开发者模式</span>
                </div>
                <button
                  onClick={() => setIsDevConsoleOpen(false)}
                  className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                  type="button"
                >
                  <span className="text-xl leading-none">×</span>
                </button>
              </div>

          <div className="flex border-b border-gray-700">
            <button
              type="button"
              onClick={() => setDevTab("preset")}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors ${
                devTab === "preset"
                  ? "text-yellow-400 border-b-2 border-yellow-400 bg-gray-800/50"
                  : "text-gray-400 hover:text-white hover:bg-gray-800/30"
              }`}
            >
              预设
            </button>
            <button
              type="button"
              onClick={() => setDevTab("roles")}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors ${
                devTab === "roles"
                  ? "text-yellow-400 border-b-2 border-yellow-400 bg-gray-800/50"
                  : "text-gray-400 hover:text-white hover:bg-gray-800/30"
              }`}
            >
              配置
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {devTab === "preset" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-gray-300">预设场景测试</div>
                  <button
                    type="button"
                    onClick={() => setDevPreset("")}
                    className="text-xs text-gray-400 hover:text-white"
                  >
                    清除
                  </button>
                </div>
                <select
                  value={devPreset}
                  onChange={(e) => setDevPreset(e.target.value as DevPreset | "")}
                  className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-yellow-400"
                >
                  <option value="">无</option>
                  <option value="MILK_POISON_TEST">毒奶测试</option>
                  <option value="LAST_WORDS_TEST">遗言测试</option>
                </select>
              </div>
            )}

            {devTab === "roles" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-gray-300">{`身份配置（${playerCount}人局）`}</div>
                  <div className={`text-xs ${roleConfigValid ? "text-green-400" : "text-gray-400"}`}>
                    {roleConfigValid ? "配置完成" : roleConfigHint}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {fixedRoles.map((role, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="w-10 text-xs text-gray-400">{idx + 1}号</span>
                      <select
                        value={role}
                        onChange={(e) => {
                          const next = [...fixedRoles];
                          next[idx] = e.target.value as Role;
                          setFixedRoles(next);
                        }}
                        className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-yellow-400"
                      >
                        {roleOptions.map((r) => (
                          <option key={r} value={r}>
                            {roleLabels[r]}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
    </>
    )}
    </>
  );
}
