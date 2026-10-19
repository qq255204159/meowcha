"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { HouseRules } from "@/types/game";

/**
 * 规则配置（自定义房规）· 2026-10-16 新增
 * 仅在「游戏设置」中、开局前可配置；关闭总开关时整局沿用标准规则。
 * 说明：滚动交给 DialogContent 自身（max-h + overflow-y-auto），不要用 Radix ScrollArea。
 */

interface HouseRulesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rules: HouseRules;
  onChange: (r: HouseRules) => void;
}

function Choice<T extends string | number | boolean>({
  value,
  options,
  disabled,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 px-2.5 text-xs rounded-sm border-2 transition-colors",
            value === o.value
              ? "bg-[var(--color-accent)] border-[var(--color-accent)] text-[var(--text-inverse)]"
              : "bg-[var(--bg-secondary)] border-[var(--border-color)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]",
            disabled && "opacity-40 cursor-not-allowed"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function RuleRow({
  label,
  explain,
  disabled,
  children,
}: {
  label: string;
  explain: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", disabled && "opacity-50")}>
      <div className="text-xs font-medium text-[var(--text-primary)]">{label}</div>
      {children}
      <div className="text-[11px] leading-relaxed text-[var(--text-muted)]">{explain}</div>
    </div>
  );
}

export function HouseRulesModal({ open, onOpenChange, rules, onChange }: HouseRulesModalProps) {
  const off = !rules.enabled;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-serif text-[var(--text-primary)]">规则配置</DialogTitle>
          <DialogDescription className="text-[var(--text-muted)]">
            自定义本局房规 · 仅开局前可配置
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 pb-2">
          <div className="rounded-lg border-2 border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-[var(--text-muted)]">
            关闭时沿用标准规则；开启后可自定义下列规则。
            <b className="text-[var(--text-primary)]">仅在开局前可配置</b>。
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border-2 border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
            <div>
              <div className="text-sm font-medium text-[var(--text-primary)]">启用自定义规则</div>
              <div className="text-xs text-[var(--text-muted)]">关闭时使用标准狼人杀规则</div>
            </div>
            <Switch
              checked={rules.enabled}
              onCheckedChange={(v) => onChange({ ...rules, enabled: v })}
            />
          </div>

          <div className="space-y-4">
            <RuleRow
              label="同守同救"
              disabled={off}
              explain="守卫守护的人与女巫用解药救的人是同一人时，标准规则判定其仍然死亡（俗称「奶穿」）。"
            >
              <Choice
                value={rules.guardSaveOverlap}
                disabled={off}
                onChange={(v) => onChange({ ...rules, guardSaveOverlap: v })}
                options={[
                  { value: "death" as const, label: "必死（标准）" },
                  { value: "survive" as const, label: "可存活" },
                ]}
              />
            </RuleRow>

            <RuleRow
              label="女巫自救"
              disabled={off}
              explain="女巫当晚被狼人刀杀时，能否用解药救自己。"
            >
              <Choice
                value={rules.witchSelfSave}
                disabled={off}
                onChange={(v) => onChange({ ...rules, witchSelfSave: v })}
                options={[
                  { value: "always" as const, label: "全程可自救（标准现状）" },
                  { value: "firstNightOnly" as const, label: "仅首夜可自救" },
                  { value: "never" as const, label: "不可自救" },
                ]}
              />
            </RuleRow>

            <RuleRow
              label="被毒死的猎人"
              disabled={off}
              explain="猎人被女巫毒死时能否发动开枪。其他死法都能开枪。"
            >
              <Choice
                value={rules.poisonedHunterShoots}
                disabled={off}
                onChange={(v) => onChange({ ...rules, poisonedHunterShoots: v })}
                options={[
                  { value: false as const, label: "不能开枪（标准）" },
                  { value: true as const, label: "可以开枪" },
                ]}
              />
            </RuleRow>

            <RuleRow
              label="胜负条件"
              disabled={off}
              explain="屠城＝存活狼数 ≥ 存活好人数即狼胜；屠边＝神职（预言家/女巫/猎人/守卫/白痴）全灭 或 村民全灭，狼即胜。"
            >
              <Choice
                value={rules.winCondition}
                disabled={off}
                onChange={(v) => onChange({ ...rules, winCondition: v })}
                options={[
                  { value: "city" as const, label: "屠城（标准）" },
                  { value: "side" as const, label: "屠边" },
                ]}
              />
            </RuleRow>

            <RuleRow label="警长票权" disabled={off} explain="警长在放逐投票中每票计多少票。">
              <Choice
                value={rules.sheriffVoteWeight}
                disabled={off}
                onChange={(v) => onChange({ ...rules, sheriffVoteWeight: v })}
                options={[
                  { value: 1 as const, label: "1 票" },
                  { value: 1.5 as const, label: "1.5 票（标准）" },
                  { value: 2 as const, label: "2 票" },
                ]}
              />
            </RuleRow>

            <RuleRow
              label="白痴翻牌后"
              disabled={off}
              explain="白痴被放逐翻牌免疫后，是否仍然拥有投票权。"
            >
              <Choice
                value={rules.idiotRevealedLosesVote}
                disabled={off}
                onChange={(v) => onChange({ ...rules, idiotRevealedLosesVote: v })}
                options={[
                  { value: true as const, label: "失去投票权（标准）" },
                  { value: false as const, label: "保留投票权" },
                ]}
              />
            </RuleRow>

            <RuleRow
              label="白狼王自爆"
              disabled={off}
              explain="白狼王白天发言阶段是否可以自爆并带走一名玩家。"
            >
              <Choice
                value={rules.whiteWolfKingCanBoom}
                disabled={off}
                onChange={(v) => onChange({ ...rules, whiteWolfKingCanBoom: v })}
                options={[
                  { value: true as const, label: "允许（标准）" },
                  { value: false as const, label: "禁止" },
                ]}
              />
            </RuleRow>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
