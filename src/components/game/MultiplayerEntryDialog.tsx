"use client";

/**
 * 喵杀 · 开局方式选择（点印章后弹出的「一个步骤」）
 * 左：开始游戏喵（单人 + AI 补位）　右：邀请朋友喵（建房 → 拿邀请码 → 等朋友准备）
 * 底部：凭邀请码入房（朋友也可直接点邀请链接自动进房，这里是手动兜底）
 *
 * 2026-10-17：难度 / 人数 / 规则配置 由主页「设置」弹窗迁移到这里，
 * 替代原来的「本局总座位」选择器 —— 单人局与邀请朋友局都会带入这三项设置，
 * 「人数」同时就是本局总座位数（真人 + AI 补全）。
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { Cat, UsersThree, ArrowRight, Copy, Check, SlidersHorizontal } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HouseRulesModal } from "@/components/game/HouseRulesModal";
import { copyText } from "@/lib/meowroom/client";
import type { DifficultyLevel, HouseRules } from "@/types/game";

const DIFFICULTY_OPTIONS: Array<{ value: DifficultyLevel; label: string; description: string }> = [
  { value: "easy", label: "新手局", description: "轻松氛围，适合初次体验" },
  { value: "normal", label: "标准局", description: "均衡推理，逻辑与表演平衡" },
  { value: "hard", label: "高阶局", description: "深度对抗，推理更复杂" },
];

const PLAYER_COUNT_OPTIONS: Array<{ value: number; label: string; description: string; roles: string }> = [
  { value: 6, label: "6人局", description: "2狼 2神 2民", roles: "神职：预言家、女巫" },
  { value: 8, label: "8人局", description: "2狼 3神 3民", roles: "神职：预言家、女巫、猎人" },
  { value: 10, label: "10人局", description: "3狼 4神 3民", roles: "神职：预言家、女巫、猎人、白痴" },
  { value: 12, label: "12人局", description: "4狼 4神 4民（默认）", roles: "狼队含白狼王；神职：预言家、女巫、猎人、守卫" },
];

export interface MultiplayerEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 单人开局 */
  onSolo: () => void;
  /** 建房并进入大厅（seats = 本局总座位数） */
  onCreateRoom: (seats: number) => Promise<boolean> | boolean;
  /** 凭邀请码入房 */
  onJoinRoom: (code: string) => Promise<boolean> | boolean;
  /** 上次存下的邀请码（若有） */
  lastCode?: string;
  /** 邀请链接带进来的房间码（有值时高亮「进入房间」） */
  initialCode?: string;
  busy?: boolean;
  /** 开局参数（单人局与邀请朋友局共用） */
  difficulty: DifficultyLevel;
  onDifficultyChange: (value: DifficultyLevel) => void;
  playerCount: number;
  onPlayerCountChange: (value: number) => void;
  houseRules: HouseRules;
  onHouseRulesChange: (rules: HouseRules) => void;
}

export function MultiplayerEntryDialog({
  open,
  onOpenChange,
  onSolo,
  onCreateRoom,
  onJoinRoom,
  lastCode,
  initialCode,
  busy,
  difficulty,
  onDifficultyChange,
  playerCount,
  onPlayerCountChange,
  houseRules,
  onHouseRulesChange,
}: MultiplayerEntryDialogProps) {
  const [code, setCode] = useState(initialCode || "");
  const [working, setWorking] = useState<"" | "solo" | "create" | "join">("");
  const [copied, setCopied] = useState(false);
  const [isRulesOpen, setIsRulesOpen] = useState(false);

  const handleSolo = () => {
    setWorking("solo");
    onSolo();
  };

  const handleCreate = async () => {
    setWorking("create");
    const ok = await onCreateRoom(playerCount);
    setWorking("");
    if (ok) onOpenChange(false);
  };

  const handleJoin = async () => {
    if (!code.trim()) return;
    setWorking("join");
    const ok = await onJoinRoom(code.trim().toUpperCase());
    setWorking("");
    if (ok) onOpenChange(false);
  };

  const copyLast = async () => {
    if (!lastCode) return;
    const ok = await copyText(lastCode);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const disabled = busy || working !== "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px] max-h-[85vh] overflow-y-auto glass-panel glass-panel--strong">
        <DialogHeader>
          <DialogTitle className="font-serif">今夜怎么开局喵？</DialogTitle>
          <DialogDescription>
            {initialCode
              ? `有人喊你进房间 ${initialCode} —— 填个名字就能上桌。`
              : "想一个人跟一群 AI 猫玩，还是喊朋友一起？两种都会给你提示。"}
          </DialogDescription>
        </DialogHeader>

        {initialCode ? (
          <button
            type="button"
            onClick={handleJoin}
            disabled={disabled}
            className="flex w-full items-center justify-between gap-3 rounded-xl border-2 border-[var(--color-accent)] bg-[var(--color-accent-bg)] px-4 py-3 text-left transition-all hover:brightness-110 disabled:opacity-60"
          >
            <span className="flex flex-col">
              <span className="font-serif text-lg font-bold text-[var(--color-accent)]">
                进入朋友的房间喵
              </span>
              <span className="text-xs text-[var(--text-secondary)]">
                房间码 <span className="font-mono">{initialCode}</span> · 点这里直接上桌
              </span>
            </span>
            <ArrowRight size={18} className="shrink-0 text-[var(--color-accent)]" />
          </button>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          {/* 开始游戏喵 */}
          <button
            type="button"
            onClick={handleSolo}
            disabled={disabled}
            title="立刻开局：你和其余座位上的 AI 猫对战"
            className="group relative flex flex-col items-start gap-2 rounded-xl border-2 border-[var(--border-color)] bg-[var(--bg-card)] p-4 text-left transition-all hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-bg)] disabled:opacity-60"
          >
            <span className="flex items-center gap-2 font-serif text-lg font-bold text-[var(--text-primary)]">
              <Cat size={20} weight="fill" className="text-[var(--color-gold)]" />
              开始游戏喵
            </span>
            <span className="text-xs leading-relaxed text-[var(--text-secondary)]">
              马上开局。只有你一位真人，其余座位由 AI 猫补全，按下面设好的难度、人数与规则来。
            </span>
            <span className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-accent)]">
              {working === "solo" ? "开局中…" : "立刻开局"}
              <ArrowRight size={12} />
            </span>
          </button>

          {/* 邀请朋友喵 */}
          <button
            type="button"
            onClick={handleCreate}
            disabled={disabled}
            title="建房并生成邀请码，朋友凭码进房准备，其余座位 AI 补全"
            className="group relative flex flex-col items-start gap-2 rounded-xl border-2 border-[var(--border-color)] bg-[var(--bg-card)] p-4 text-left transition-all hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-bg)] disabled:opacity-60"
          >
            <span className="flex items-center gap-2 font-serif text-lg font-bold text-[var(--text-primary)]">
              <UsersThree size={20} weight="fill" className="text-[var(--color-gold)]" />
              邀请朋友喵
            </span>
            <span className="text-xs leading-relaxed text-[var(--text-secondary)]">
              先建房拿邀请码。朋友进来后全员「准备」，你就能开场；剩下座位交给 AI 猫。
            </span>
            <span className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-accent)]">
              {working === "create" ? "建房中…" : "建房并拿邀请码"}
              <ArrowRight size={12} />
            </span>
          </button>
        </div>

        {/* 开局参数：原在主页「设置」里，2026-10-17 迁到此处（替代旧的「本局总座位」） */}
        <div className="space-y-4 rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-3">
          <div className="text-xs text-[var(--text-secondary)]">
            下面三项对本局生效：单人局直接采用；邀请朋友局会带进房间，房主开场时使用。
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-[var(--text-primary)]">难度</div>
            <Select
              value={difficulty}
              onValueChange={(value) => onDifficultyChange(value as DifficultyLevel)}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择难度" />
              </SelectTrigger>
              <SelectContent>
                {DIFFICULTY_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    label={option.label}
                    description={option.description}
                  />
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-[var(--text-primary)]">人数</div>
              <div className="text-xs text-[var(--text-secondary)]">本局总座位（真人 + AI 补全）</div>
            </div>
            <Select
              value={String(playerCount)}
              onValueChange={(value) => onPlayerCountChange(Number(value))}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择人数" />
              </SelectTrigger>
              <SelectContent>
                {PLAYER_COUNT_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={String(option.value)}
                    label={option.label}
                    description={`${option.description}｜${option.roles}`}
                  />
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-[var(--text-primary)]">规则配置</div>
            <button
              type="button"
              onClick={() => setIsRulesOpen(true)}
              className="w-full inline-flex items-center justify-center gap-2 h-9 px-4 text-sm font-medium rounded-sm border-2 border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <SlidersHorizontal size={16} />
              自定义规则
            </button>
            <div className="text-xs text-[var(--text-muted)]">仅在开局前可配置，默认使用标准规则</div>
          </div>
        </div>

        {/* 凭邀请码入房 */}
        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-3">
          <div className="text-xs text-[var(--text-secondary)]">
            有朋友发来的邀请码？填在这里就行（点开邀请链接会直接自动进房）。
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32))}
              placeholder="邀请码，如 K7QM3XZP"
              className="h-9 flex-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-input,var(--bg-card))] px-3 font-mono text-sm tracking-widest text-[var(--text-primary)] outline-none focus:border-[var(--color-accent)]"
              maxLength={32}
            />
            <button
              type="button"
              onClick={handleJoin}
              disabled={disabled || !code.trim()}
              className="h-9 rounded-md border-2 border-[var(--border-color)] px-3 text-sm font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-bg)] disabled:opacity-50"
            >
              {working === "join" ? "进房中…" : "进入房间"}
            </button>
          </div>
          {lastCode ? (
            <div className="mt-2 flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span>上次建的房：<span className="font-mono text-[var(--color-gold)]">{lastCode}</span></span>
              <button
                type="button"
                onClick={copyLast}
                className="inline-flex items-center gap-1 rounded border border-[var(--border-color)] px-1.5 py-0.5 hover:bg-[var(--bg-hover)]"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? "已复制" : "复制"}
              </button>
            </div>
          ) : null}
        </div>

        {busy ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-xs text-[var(--color-gold)]"
          >
            正在连接房间服务…
          </motion.div>
        ) : null}
      </DialogContent>

      <HouseRulesModal
        open={isRulesOpen}
        onOpenChange={setIsRulesOpen}
        rules={houseRules}
        onChange={onHouseRulesChange}
      />
    </Dialog>
  );
}
