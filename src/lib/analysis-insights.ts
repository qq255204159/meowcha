import type { Alignment, Role } from "@/types/game";
import type { GameAnalysisData, PlayerSnapshot } from "@/types/analysis";
import { ROLE_NAMES } from "@/components/analysis/constants";

/**
 * 喵杀（第十二·五轮）· 复盘洞察
 * -------------------------------------------------------------
 * 纯粹从 `GameAnalysisData` 现成字段里「再榨一层」信息，为复盘页产出：
 *   · 破局点（胜负手）：本局对最终赢家帮助最大的那一击
 *   · 关键回合前三：若干「镜头」
 *   · 猫猫利弊榜：每个玩家的亮点 / 槽点
 * ⚠️ 数据口径（务必一致，来自 game-analysis.ts）：
 *   · `PlayerSnapshot.seat` 是 **0 基**；
 *   · `DayEvent.target` / `NightEvent.target` 是 **1 基 + 「号」** 的字符串（如 "7号"）；
 *   · `VoteRecord.voterSeat/targetSeat` 是 **1 基** 数字；
 *   · `NightEvent.source` 是中文角色名（"狼人/女巫/预言家/守卫"），`check.result` 为 "狼人"/"好人"。
 */

const GOD_ROLES: ReadonlySet<Role> = new Set<Role>(["Seer", "Witch", "Guard", "Hunter"]);

export interface InsightChip {
  tone: "good" | "bad" | "info";
  text: string;
}

export interface KeyMoment {
  day: number;
  title: string;
  detail: string;
  favored: Alignment | "neutral";
  weight: number;
}

export interface TurningPoint {
  day: number;
  title: string;
  detail: string;
  favored: Alignment;
  comment: string;
}

export interface PlayerReport {
  playerId: string;
  seat: number;
  name: string;
  role: Role;
  alignment: Alignment;
  isHuman: boolean;
  alive: boolean;
  deathText: string;
  verdict: "高光" | "稳健" | "争议" | "划水";
  chips: InsightChip[];
}

export interface AnalysisInsights {
  winner: Alignment;
  turning: TurningPoint | null;
  keyMoments: KeyMoment[];
  reports: PlayerReport[];
  oneLiner: string;
}

const roleLabel = (r: Role): string => ROLE_NAMES[r] ?? r;
const isGod = (r: Role): boolean => GOD_ROLES.has(r);

/** 从 "7号" / "7号 → 8号" 里取第一个座位号（1 基） */
function firstSeat(label?: string): number | null {
  const m = /(\d+)\s*号/.exec(label ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * 从「箭头右侧」取座位号（1 基）。用于猎人开枪 "7号 → 8号" 与白狼王自爆 "7号自爆 → 8号张三"。
 * 注意：不能用「取最后一个 N号」的写法 —— "7号自爆，未带走任何人" 也含座位号，
 * 会被误判成「换到人了」；故只认「→」之后的第一个座位号。
 */
function seatAfterArrow(label?: string): number | null {
  const s = label ?? "";
  const idx = s.lastIndexOf("→");
  if (idx < 0) return null;
  return firstSeat(s.slice(idx + 1));
}

function causeShort(cause?: string): string {
  switch (cause) {
    case "killed": return "夜里被刀";
    case "exiled": return "被票出局";
    case "poisoned": return "被女巫毒杀";
    case "shot": return "被猎人带走";
    case "milk": return "同守同救奶穿";
    case "boom": return "被白狼王自爆带走";
    default: return "出局";
  }
}

function deathNote(p: PlayerSnapshot): string {
  const isWolf = p.alignment === "wolf";
  switch (p.deathCause) {
    case "exiled":
      return isWolf ? "被好人一票票送走，狼队掉了一员。" : "被自己人票了出去，这一票赔惨了。";
    case "killed":
      return isWolf ? "夜里挨了自己人的刀（或是狼队的内部消耗）。" : "夜里被狼刀了。";
    case "poisoned":
      return isWolf ? "被女巫的药送走了。" : "被女巫的药送走了。";
    case "shot":
      return isWolf ? "被猎人一枪带走。" : "被猎人的枪误伤。";
    case "milk":
      return "守卫和女巫撞了车，奶穿了。";
    case "boom":
      return isWolf ? "自爆换人。" : "被白狼王自爆带走。";
    default:
      return "出局。";
  }
}

export function buildInsights(data: GameAnalysisData): AnalysisInsights {
  const winner: Alignment = data.result === "village_win" ? "village" : "wolf";
  const bySeat1 = new Map<number, PlayerSnapshot>();
  for (const p of data.players) bySeat1.set(p.seat + 1, p);

  // ---------- 1) 出局台账：每次出局对哪一方有利、有多重 ----------
  const moments: KeyMoment[] = [];
  for (const p of data.players) {
    if (p.isAlive) continue;
    const favored: Alignment = p.alignment === "wolf" ? "village" : "wolf";
    let weight = p.alignment === "wolf" ? 2 : isGod(p.role) ? 2 : 1;
    if (p.alignment === "village" && p.deathCause === "exiled") weight += 1.2; // 好人互票 = 失误放大
    moments.push({
      day: p.deathDay ?? 1,
      title: `${p.seat + 1}号 ${p.name} · ${roleLabel(p.role)}`,
      detail: deathNote(p),
      favored,
      weight,
    });
  }

  // 补充：技能「镜头」（白狼王自爆 / 猎人开枪 / 白痴翻牌），有独立演出感
  for (const entry of data.timeline) {
    for (const ev of entry.dayEvents) {
      if (ev.type === "hunter_shot") {
        const hunter = firstSeat(ev.target);
        const target = seatAfterArrow(ev.target);
        const tp = target ? bySeat1.get(target) : undefined;
        if (hunter && tp) {
          moments.push({
            day: entry.day,
            title: `${hunter}号猎人的枪 → ${target}号 ${tp.name}`,
            detail: tp.alignment === "wolf" ? "一枪正中狼窝，子弹没白费。" : "枪口偏了，带走的是自己人。",
            favored: tp.alignment === "wolf" ? "village" : "wolf",
            weight: 2.5,
          });
        } else if (hunter) {
          moments.push({ day: entry.day, title: `${hunter}号猎人选择不开枪`, detail: "把枪收了起来，平安落地。", favored: "wolf", weight: 1.2 });
        }
      } else if (ev.type === "white_wolf_king_boom") {
        const boom = firstSeat(ev.target);
        const target = seatAfterArrow(ev.target);
        if (boom) {
          moments.push({
            day: entry.day,
            title: `${boom}号白狼王自爆${target ? ` → 带走 ${target}号` : ""}`,
            detail: target ? "用一颗牙换掉一个好人。" : "自爆但没换到人。",
            favored: "wolf",
            weight: target ? 2.5 : 1.5,
          });
        }
      } else if (ev.type === "idiot_reveal") {
        const seat = firstSeat(ev.target);
        if (seat) {
          moments.push({ day: entry.day, title: `${seat}号白痴翻牌`, detail: "把牌一亮，免疫放逐，稳稳站住。", favored: "village", weight: 1.5 });
        }
      }
    }
  }

  // 用「帮助最终赢家」加权 + 越早越关键 排序
  const scoreOf = (m: KeyMoment) => m.weight * (m.favored === winner ? 1.6 : 0.45) - (m.day - 1) * 0.08;
  const ranked = [...moments].sort((a, b) => scoreOf(b) - scoreOf(a));

  let turning: TurningPoint | null = null;
  const decisive = ranked.find((m) => m.favored === winner) ?? ranked[0];
  if (decisive) {
    const sideName = decisive.favored === "wolf" ? "狼队" : "好人";
    turning = {
      day: decisive.day,
      title: decisive.title,
      detail: decisive.detail,
      favored: decisive.favored === "neutral" ? winner : decisive.favored,
      comment:
        `第 ${decisive.day} 天这一手，基本把天平的砝码压到了${sideName}这边：${decisive.title}。` +
        `${decisive.detail}${winner === decisive.favored ? "事实证明，这就是本局的胜负手。" : "可惜最后被翻了盘。"}`,
    };
  }

  const keyMoments = ranked.slice(0, 3);

  // ---------- 2) 台账：投票 / 夜间技能 ----------
  const voteLog = new Map<number, number[]>();
  const checkEvents: { day: number; isWolf: boolean }[] = [];
  const poisonTargets: number[] = [];
  const saveTargets: number[] = [];
  const hunterShots: { hunterSeat: number; targetSeat: number }[] = [];
  let guardBlocks = 0;

  for (const entry of data.timeline) {
    for (const ev of entry.nightEvents) {
      const t = firstSeat(ev.target);
      if (ev.type === "check" && t) checkEvents.push({ day: entry.day, isWolf: ev.result === "狼人" });
      if (ev.type === "kill" && ev.blocked) guardBlocks += 1;
      if (ev.type === "poison" && t) poisonTargets.push(t);
      if (ev.type === "save" && t) saveTargets.push(t);
    }
    for (const ev of entry.dayEvents) {
      if (ev.type === "exile" && ev.votes) {
        for (const v of ev.votes) {
          const arr = voteLog.get(v.voterSeat) ?? [];
          arr.push(v.targetSeat);
          voteLog.set(v.voterSeat, arr);
        }
      }
      if (ev.type === "hunter_shot") {
        const h = firstSeat(ev.target);
        const t = seatAfterArrow(ev.target);
        if (h && t) hunterShots.push({ hunterSeat: h, targetSeat: t });
      }
    }
  }

  // ---------- 3) 猫猫利弊榜 ----------
  const reports: PlayerReport[] = [...data.players]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => {
      const seat1 = p.seat + 1;
      const chips: InsightChip[] = [];

      // 生死
      if (p.isAlive) {
        chips.push({ tone: "good", text: "活到最后" });
      } else {
        const d = p.deathDay ?? 1;
        // 被票出局 / 奶穿 = 多半有自己的原因；夜里被刀被毒则是身不由己 → 只作中性记录
        const blame = p.deathCause === "exiled" || p.deathCause === "milk";
        chips.push({ tone: blame ? "bad" : "info", text: `第${d}天${causeShort(p.deathCause)}` });
      }

      // 跟票命中（只对好人算命中，狼人投票是战术 → 只报次数）
      const myVotes = voteLog.get(seat1) ?? [];
      if (myVotes.length > 0) {
        if (p.alignment === "village") {
          let hit = 0;
          for (const t of myVotes) {
            const tp = bySeat1.get(t);
            if (tp && tp.alignment === "wolf") hit += 1;
          }
          const rate = Math.round((hit / myVotes.length) * 100);
          chips.push({ tone: rate >= 60 ? "good" : rate <= 33 ? "bad" : "info", text: `跟票命中 ${hit}/${myVotes.length}（${rate}%）` });
        } else {
          chips.push({ tone: "info", text: `本局投了 ${myVotes.length} 票` });
        }
      }

      // 职位专属
      if (p.role === "Seer") {
        const kills = checkEvents.filter((c) => c.isWolf).length;
        if (checkEvents.length > 0) {
          chips.push(kills > 0 ? { tone: "good", text: `验出 ${kills} 只狼` } : { tone: "bad", text: `验了 ${checkEvents.length} 人没抓到狼` });
        }
      } else if (p.role === "Witch") {
        const wolfPoison = poisonTargets.filter((s) => bySeat1.get(s)?.alignment === "wolf").length;
        const goodPoison = poisonTargets.filter((s) => bySeat1.get(s)?.alignment === "village").length;
        if (wolfPoison > 0) chips.push({ tone: "good", text: `毒掉 ${wolfPoison} 只狼` });
        if (goodPoison > 0) chips.push({ tone: "bad", text: `毒错 ${goodPoison} 个好人` });
        const savedWolf = saveTargets.filter((s) => bySeat1.get(s)?.alignment === "wolf").length;
        if (savedWolf > 0) chips.push({ tone: "bad", text: "药喂给了狼" });
        else if (saveTargets.length > 0) chips.push({ tone: "good", text: "用药救了好人" });
      } else if (p.role === "Guard") {
        chips.push(guardBlocks > 0 ? { tone: "good", text: `挡下 ${guardBlocks} 次狼刀` } : { tone: "bad", text: "盾一次都没挡上" });
      } else if (p.role === "Hunter") {
        const mine = hunterShots.find((h) => h.hunterSeat === seat1);
        if (mine) {
          const t = bySeat1.get(mine.targetSeat);
          chips.push(t?.alignment === "wolf" ? { tone: "good", text: "一枪带走一只狼" } : { tone: "bad", text: "枪口走火，带走好人" });
        } else if (!p.isAlive) {
          chips.push({ tone: "bad", text: "到死没开枪" });
        }
      } else if (p.role === "Werewolf" || p.role === "WhiteWolfKing") {
        chips.push(winner === "wolf" ? { tone: "good", text: "狼队拿下本局" } : { tone: "bad", text: "狼队败北" });
      }

      const good = chips.filter((c) => c.tone === "good").length;
      const bad = chips.filter((c) => c.tone === "bad").length;
      let verdict: PlayerReport["verdict"];
      if (good >= 2 && bad === 0) verdict = "高光";
      else if (bad >= 2 || (bad >= 1 && good === 0)) verdict = "争议";
      else if (good >= 1) verdict = "稳健";
      else verdict = "划水";

      return {
        playerId: p.playerId,
        seat: p.seat,
        name: p.name,
        role: p.role,
        alignment: p.alignment,
        isHuman: !!p.isHumanPlayer,
        alive: p.isAlive,
        deathText: p.isAlive ? "存活" : causeShort(p.deathCause),
        verdict,
        chips,
      };
    });

  // ---------- 4) 一句话总结 ----------
  const goodWon = winner === "village";
  const godDeaths = data.players.filter((p) => p.alignment === "village" && isGod(p.role) && !p.isAlive).length;
  const wolfDeaths = data.players.filter((p) => p.alignment === "wolf" && !p.isAlive).length;
  let oneLiner = goodWon
    ? `好人阵营守住了桌子——${wolfDeaths} 只狼被送走，喵队赢下这一局。`
    : `狼队摸黑把灯一盏盏关掉——${godDeaths} 个神职倒下，好人没能翻盘。`;
  if (goodWon && godDeaths >= 2) oneLiner += "（真是赢得惊险）";
  if (!goodWon && wolfDeaths >= 2) oneLiner += "（差点被翻，好在稳住）";

  return { winner, turning, keyMoments, reports, oneLiner };
}
