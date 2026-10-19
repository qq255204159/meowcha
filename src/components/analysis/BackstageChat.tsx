"use client";

/**
 * 喵杀 · 幕后夜聊（2026-10-19 重做）
 * ---------------------------------------------------------------
 * 事实前提（读代码核实过）：
 *   · 狼队夜间**没有独立的「夜聊」环节** —— ai-logger 里虽定义了 `wolf_chat` 类型，
 *     但全项目没有任何 log() 调用点，所以抓不到真实夜聊。
 *   · 刀口由**一只狼代表决定、其余狼一致同意**（NightPhase.ts：`firstWolf` 选目标），
 *     所以本作不存在「狼队分票」。
 * 因此这里**按本局真实刀口反推**，生成一段有趣、可信的夜间小剧场（仅结算页展示）。
 * 文案由 (天, 刀口座位) 做种子 —— 同一局每次进入都稳定不跳，且多夜对局会不断换台词。
 */
import { useMemo } from "react";
import { motion } from "framer-motion";
import { Moon } from "lucide-react";
import type { GameAnalysisData } from "@/types/analysis";
import { ROLE_NAMES } from "./constants";

interface ChatLine {
  seat: number;
  name: string;
  text: string;
}

interface NightChat {
  day: number;
  targetSeat?: number;
  targetName?: string;
  lines: ChatLine[];
  note: string;
}

/** 稳定伪随机（同种子同结果） */
function seeded(seed: number) {
  let s = Math.floor(seed) % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function pick<T>(arr: T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length) % arr.length];
}

const GOD_ROLES = ["Seer", "Witch", "Hunter", "Guard"];

/** 开场：由「拍板的那只狼」抛出刀口 —— 15+ 套，多夜不重样 */
const OPENERS: ((s: number) => string)[] = [
  (s) => `今晚敲 ${s}号 家的门喵～`,
  (s) => `我想刀 ${s}号，他白天那张嘴太碍事了喵`,
  (s) => `${s}号 归票归得那么积极，先送他走喵`,
  (s) => `${s}号 看着就不顺眼，今晚归他了喵`,
  (s) => `我盯 ${s}号 一整晚了，就他喵`,
  (s) => `今晚先拿 ${s}号 开刀，试试手感喵`,
  (s) => `${s}号 白天居然敢怼我，哼，刀他喵`,
  (s) => `刀 ${s}号，我赌他手里有牌喵`,
  (s) => `${s}号 那眼神就不像好人，刀了刀了喵`,
  (s) => `就 ${s}号 吧，他坐得离我太近了喵`,
  (s) => `${s}号 老替别人说话，太像神职了喵`,
  (s) => `今晚刀 ${s}号，谁赞成谁反对？没人说话，那就他喵`,
  (s) => `我提议 ${s}号，他白天一直在带节奏喵`,
  (s) => `刀 ${s}号，让他明天安静点喵`,
  (s) => `${s}号 性价比最高，先收了他喵`,
  (s) => `别犹豫了，${s}号，一刀的事喵`,
];

/** 附和：其他狼的回应 —— 15+ 套 */
const AGREES: ((s: number) => string)[] = [
  (s) => `${s}号 那副样子，我早看他不爽了喵`,
  (s) => `行，就 ${s}号 吧，我赌他手里有东西喵`,
  (s) => `听你的，${s}号 这刀我来补喵`,
  (s) => `${s}号 白天跳来跳去，看着烦喵`,
  (s) => `同意，${s}号 没了最省心喵`,
  (s) => `那就 ${s}号 吧，反正我也想刀他喵`,
  (s) => `好耶，${s}号 今晚没了喵`,
  (s) => `${s}号 一直盯着我们这边看，刀他不亏喵`,
  (s) => `我也觉得 ${s}号 有问题，就他喵`,
  (s) => `成交，${s}号，愿他今晚睡个好觉喵`,
  (s) => `${s}号 白天差点把我卖了，记仇喵`,
  (s) => `嗯，${s}号 死得其所喵`,
  (s) => `随你，${s}号 我无所谓，反正明天我继续装好人喵`,
  (s) => `刀 ${s}号 的话我可不敢跟着投他，别让我接话喵`,
  (s) => `就 ${s}号 了，散会喵`,
];

/** 第三只狼插嘴 / 夜聊碎碎念 —— 6+ 套 */
const INTERJECTS: ((s: number) => string)[] = [
  (s) => `你们俩别吵了，刀 ${s}号 我举双手喵`,
  () => `小声点，隔壁还没闭眼喵`,
  (s) => `${s}号 要是女巫就赚大了喵`,
  () => `我倒觉得该刀别人，不过听你们的喵`,
  () => `先记着这笔账，白天我还要装无辜喵`,
  (s) => `刀完 ${s}号 早点睡，明天还得演戏喵`,
];

function buildNightChats(data: GameAnalysisData): NightChat[] {
  const out: NightChat[] = [];
  const players = data.players || [];

  for (const day of data.timeline || []) {
    const kill = (day.nightEvents || []).find((e) => e.type === "kill");
    const wolves = players.filter(
      (p) => p.alignment === "wolf" && (p.deathDay === undefined || p.deathDay >= day.day)
    );
    if (wolves.length === 0) continue;

    const targetSeat = kill ? Number(String(kill.target).replace(/[^0-9]/g, "")) - 1 : undefined;
    const okTarget = typeof targetSeat === "number" && Number.isFinite(targetSeat);
    const rnd = seeded(day.day * 9973 + (okTarget ? (targetSeat as number) * 131 + 7 : 11));

    if (!kill || !okTarget) {
      out.push({
        day: day.day,
        lines: wolves.slice(0, 2).map((w) => ({
          seat: w.seat,
          name: w.name,
          text: pick(["今晚先按兵不动，看看风向喵", "别急着动刀，稳住才有得玩喵"], rnd),
        })),
        note: "这一夜狼队没有出刀（平安夜）。",
      });
      continue;
    }

    const seatNum = (targetSeat as number) + 1;
    const target = players.find((p) => p.seat === targetSeat);

    // 第 1 条：拍板狼抛刀口；第 2 条：另一只狼插嘴/附和；第 3 条（若有第三只狼）：附和
    const lines: ChatLine[] = [];
    lines.push({ seat: wolves[0].seat, name: wolves[0].name, text: pick(OPENERS, rnd)(seatNum) });
    if (wolves[1]) {
      const useInterject = wolves.length >= 3 && rnd() < 0.45;
      lines.push({
        seat: wolves[1].seat,
        name: wolves[1].name,
        text: useInterject ? pick(INTERJECTS, rnd)(seatNum) : pick(AGREES, rnd)(seatNum),
      });
    }
    if (wolves[2]) {
      lines.push({ seat: wolves[2].seat, name: wolves[2].name, text: pick(AGREES, rnd)(seatNum) });
    }

    let note: string;
    if (kill.blocked) {
      note = `结算视角：这一刀扎在守卫的护盾上，${seatNum}号 其实没死。`;
    } else if (target && GOD_ROLES.includes(target.role)) {
      note = `结算视角：${seatNum}号 正是 ${ROLE_NAMES[target.role]} —— 狼队这一刀精准扎在了神职上。`;
    } else if (target && target.role === "WhiteWolfKing") {
      note = `结算视角：${seatNum}号 是狼队自己人（白狼王），这刀是自刀骗药。`;
    } else {
      note = `结算视角：${seatNum}号 是普通牌面，狼队这一刀冲着压缩好人人数去的。`;
    }

    out.push({ day: day.day, targetSeat, targetName: target?.name, lines, note });
  }

  return out;
}

export function BackstageChat({ data }: { data: GameAnalysisData }) {
  const chats = useMemo(() => buildNightChats(data), [data]);
  if (chats.length === 0) return null;

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <Moon className="h-4 w-4 text-[var(--color-blood)]" />
        <h4 className="text-xs tracking-[0.3em] text-[var(--color-gold)]/80">幕后 · 狼队夜聊</h4>
      </div>

      <div className="space-y-3">
        {chats.map((c, idx) => (
          <motion.div
            key={c.day}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: Math.min(idx * 0.05, 0.35) }}
            className="analysis-nightcard px-4 py-3.5"
          >
            <div className="mb-2.5 flex items-center gap-2">
              <span className="rounded bg-[var(--color-blood)]/15 px-2 py-1 text-xs font-bold text-[var(--color-blood)]">
                第 {c.day} 夜
              </span>
              {c.targetName !== undefined && (
                <span className="text-sm text-[var(--text-muted)]">
                  刀口：{c.targetSeat! + 1}号 {c.targetName}
                </span>
              )}
            </div>

            <div className="space-y-2">
              {c.lines.map((l, i) => (
                <div key={i} className="analysis-bubble analysis-bubble--wolf px-3.5 py-2.5">
                  <span className="mr-2 text-sm font-bold text-[var(--color-blood)]">
                    {l.seat + 1}号 {l.name}
                  </span>
                  <span className="text-sm leading-relaxed text-[var(--text-secondary)]">{l.text}</span>
                </div>
              ))}
            </div>

            <p className="mt-2.5 text-sm leading-relaxed text-[var(--text-muted)]">{c.note}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
