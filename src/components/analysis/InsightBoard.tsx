"use client";

import { useMemo } from "react";
import { Sparkles, PawPrint, Skull, Crosshair, TrendingUp, TrendingDown } from "lucide-react";
import type { GameAnalysisData } from "@/types/analysis";
import { buildInsights, type InsightChip, type PlayerReport } from "@/lib/analysis-insights";
import { ROLE_NAMES } from "./constants";

interface InsightBoardProps {
  data: GameAnalysisData;
  onSelectPlayer?: (playerId: string) => void;
}

const VERDICT_STYLE: Record<PlayerReport["verdict"], string> = {
  高光: "bg-[var(--color-gold)]/20 text-[var(--color-gold)] border-[var(--color-gold)]/40",
  稳健: "bg-[#2f855a]/20 text-[#5bbf86] border-[#2f855a]/40",
  争议: "bg-[#c53030]/20 text-[#e06a6a] border-[#c53030]/40",
  划水: "bg-white/5 text-[var(--text-muted)] border-white/10",
};

const CHIP_STYLE: Record<InsightChip["tone"], string> = {
  good: "bg-[#2f855a]/15 text-[#5bbf86] border-[#2f855a]/30",
  bad: "bg-[#c53030]/15 text-[#e06a6a] border-[#c53030]/30",
  info: "bg-white/5 text-[var(--text-secondary)] border-white/10",
};

const SIDE_TEXT: Record<string, string> = {
  village: "好人",
  wolf: "狼人",
  neutral: "中立",
};

export function InsightBoard({ data, onSelectPlayer }: InsightBoardProps) {
  const insights = useMemo(() => buildInsights(data), [data]);
  const { turning, keyMoments, reports, oneLiner, winner } = insights;

  return (
    <section className="space-y-6">
      {/* 一句话总结 */}
      <div className="analysis-card rounded-xl px-5 py-4 flex items-center gap-3">
        <PawPrint className="w-5 h-5 text-[var(--color-gold)]/70 shrink-0" />
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{oneLiner}</p>
      </div>

      {/* 破局点（胜负手） */}
      {turning && (
        <div className="analysis-card rounded-xl p-5 relative overflow-hidden">
          <div className="absolute -top-10 -right-10 w-32 h-32 rounded-full bg-[var(--color-gold)]/10 blur-2xl pointer-events-none" />
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-[var(--color-gold)]" />
            <span className="text-[10px] tracking-[0.3em] text-[var(--color-gold)]/70">本局胜负手</span>
          </div>

          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mb-2">
            <span className="text-xs px-2 py-0.5 rounded bg-[var(--color-gold)]/15 text-[var(--color-gold)] border border-[var(--color-gold)]/30">
              第 {turning.day} 天
            </span>
            <h3 className="text-base font-bold text-[var(--text-primary)]">
              {turning.favored === "wolf" ? "狼队" : "好人"}的关键一手
            </h3>
          </div>

          <p className="text-sm font-bold text-[var(--text-primary)] mb-1">{turning.title}</p>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{turning.comment}</p>
        </div>
      )}

      {/* 三个转折镜头 */}
      {keyMoments.length > 0 && (
        <div>
          <h4 className="text-[10px] tracking-[0.3em] text-[var(--color-gold)]/50 mb-3">
            三个转折镜头
          </h4>
          <div className="space-y-2.5">
            {keyMoments.map((m, idx) => {
              const up = m.favored === "village" || m.favored === "neutral";
              const Icon = m.favored === "neutral" ? Crosshair : up ? TrendingUp : TrendingDown;
              return (
                <div key={idx} className="analysis-card rounded-lg px-4 py-3 flex items-start gap-3">
                  <div className="mt-0.5 shrink-0">
                    <Icon className={`w-4 h-4 ${m.favored === "wolf" ? "text-[var(--color-blood)]" : "text-[var(--color-gold)]"}`} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] text-[var(--text-muted)] shrink-0">第{m.day}天</span>
                      <span className="text-xs font-bold text-[var(--text-primary)]">{m.title}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">（利好{SIDE_TEXT[m.favored]}）</span>
                    </div>
                    <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">{m.detail}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 猫猫利弊榜 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Skull className="w-3.5 h-3.5 text-[var(--color-gold)]/50" />
          <h4 className="text-[10px] tracking-[0.3em] text-[var(--color-gold)]/50">
            猫猫点评 · 利与弊
          </h4>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {reports.map((p) => (
            <button
              key={p.playerId}
              type="button"
              onClick={() => onSelectPlayer?.(p.playerId)}
              className="analysis-card rounded-lg p-3.5 text-left hover:bg-white/5 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                    p.alignment === "wolf"
                      ? "bg-[var(--color-blood)]/20 text-[var(--color-blood)] border-[var(--color-blood)]/40"
                      : "bg-[var(--color-gold)]/15 text-[var(--color-gold)] border-[var(--color-gold)]/30"
                  }`}
                >
                  {p.seat + 1}号
                </span>
                <span className="text-xs font-bold text-[var(--text-primary)] truncate">
                  {p.name}
                </span>
                <span className={`ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded border ${VERDICT_STYLE[p.verdict]}`}>
                  {p.verdict}
                </span>
              </div>

              <div className="text-[10px] text-[var(--text-muted)] mb-2">
                {ROLE_NAMES[p.role]} · {p.alignment === "wolf" ? "狼人阵营" : "好人阵营"}
                {p.isHuman ? " · 你" : ""} · {p.deathText}
                {winner === (p.alignment === "wolf" ? "wolf" : "village") ? " · 胜方" : ""}
              </div>

              {p.chips.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {p.chips.map((c, i) => (
                    <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded border ${CHIP_STYLE[c.tone]}`}>
                      {c.text}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
