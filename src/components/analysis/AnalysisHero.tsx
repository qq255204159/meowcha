"use client";

/**
 * 喵杀 · 结算页 Hero（2026-10-19）
 * 把「谁赢了 / 本局一句话 / 关键数字 / MVP-SVP」集中成一条有质感的横幅，
 * 让复盘页一进来就有「这一局档案」的感觉。
 */
import { motion } from "framer-motion";
import { PawPrint, Skull, Bomb, Crosshair, CalendarDays, Trophy, Share2 } from "lucide-react";
import type { GameAnalysisData } from "@/types/analysis";
import { buildInsights } from "@/lib/analysis-insights";
import { ROLE_NAMES } from "./constants";

interface AnalysisHeroProps {
  data: GameAnalysisData;
  onShare?: () => void;
}

function countDayEvent(data: GameAnalysisData, type: string): number {
  return (data.timeline || []).reduce(
    (n, t) => n + (t.dayEvents || []).filter((e) => e.type === type).length,
    0
  );
}

export function AnalysisHero({ data, onShare }: AnalysisHeroProps) {
  const wolfWin = data.result === "wolf_win";
  const insights = buildInsights(data);
  const oneLiner = insights.oneLiner;

  const stats = [
    { icon: CalendarDays, label: "天数", value: String(data.timeline?.length ?? 1) },
    { icon: Skull, label: "出局", value: String(data.players.filter((p) => !p.isAlive).length) },
    { icon: Bomb, label: "自爆", value: String(countDayEvent(data, "white_wolf_king_boom")) },
    { icon: Crosshair, label: "开枪", value: String(countDayEvent(data, "hunter_shot")) },
  ];

  const mvp = data.awards?.mvp;
  const svp = data.awards?.svp;

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className={`analysis-card analysis-hero rounded-2xl px-6 py-7 ${wolfWin ? "analysis-hero--wolf" : ""}`}
    >
      <div className="relative flex flex-col items-center text-center">
        <div className="mb-3 flex items-center gap-2">
          <PawPrint className={`h-4 w-4 ${wolfWin ? "text-[var(--color-blood)]" : "text-[var(--color-gold)]"}`} />
          <span className="text-[10px] tracking-[0.4em] text-[var(--color-gold)]/60">BATTLE REPORT · 本局档案</span>
        </div>

        <h2
          className={`text-3xl font-black tracking-wide ${
            wolfWin ? "text-[var(--color-blood)]" : "text-[var(--color-gold)]"
          }`}
          style={{ textShadow: "0 1px 0 rgba(255,255,255,.65)" }}
        >
          {wolfWin ? "狼 队 胜 利" : "好 人 胜 利"}
        </h2>
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
          {wolfWin ? "小猫咪们被骗得团团转喵…" : "喵们成功揪出了藏在暗处的狼喵"}
        </p>

        {oneLiner && (
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[var(--text-secondary)]">{oneLiner}</p>
        )}

        {/* 关键数字 */}
        <div className="mt-6 grid w-full max-w-2xl grid-cols-2 gap-2.5 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="analysis-stat flex items-center gap-2.5 px-3 py-2.5">
              <s.icon className="h-4 w-4 shrink-0 text-[var(--color-gold)]/70" />
              <div className="min-w-0 text-left">
                <div className="text-lg font-bold leading-none text-[var(--text-primary)]">{s.value}</div>
                <div className="mt-0.5 text-[10px] tracking-widest text-[var(--text-muted)]">{s.label}</div>
              </div>
            </div>
          ))}
        </div>

        {/* MVP / SVP */}
        {(mvp || svp) && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            {mvp && (
              <div className="analysis-stat flex items-center gap-2 px-3 py-2">
                <Trophy className="h-4 w-4 text-[var(--color-gold)]" />
                <span className="text-[10px] tracking-widest text-[var(--color-gold)]/70">MVP</span>
                <span className="text-xs font-bold text-[var(--text-primary)]">{mvp.playerName}</span>
                <span className="text-[10px] text-[var(--text-muted)]">{ROLE_NAMES[mvp.role] ?? mvp.role}</span>
              </div>
            )}
            {svp && (
              <div className="analysis-stat flex items-center gap-2 px-3 py-2 opacity-90">
                <Skull className="h-4 w-4 text-[var(--color-blood)]" />
                <span className="text-[10px] tracking-widest text-[var(--color-blood)]/80">SVP</span>
                <span className="text-xs font-bold text-[var(--text-primary)]">{svp.playerName}</span>
                <span className="text-[10px] text-[var(--text-muted)]">{ROLE_NAMES[svp.role] ?? svp.role}</span>
              </div>
            )}
          </div>
        )}

        {onShare && (
          <button
            type="button"
            onClick={onShare}
            className="mt-6 inline-flex items-center gap-2 rounded-full border border-[var(--color-gold)]/40 bg-[var(--color-gold)]/10 px-4 py-1.5 text-xs font-semibold text-[var(--color-gold)] transition-colors hover:bg-[var(--color-gold)]/20"
          >
            <Share2 className="h-3.5 w-3.5" />
            生成战报海报喵
          </button>
        )}
      </div>
    </motion.section>
  );
}
