"use client";

/**
 * 喵杀（第十二轮）· 程序化音效
 * ------------------------------------------------------------------
 * 技能演出用音效。全部用 Web Audio API 现场合成，不引入任何音频文件
 * （静态导出 + 子路径部署，外链/大文件都不合适）。
 *   · playGunshot    猎人开枪：爆响 + 低频冲击 + 远处余响
 *   · playExplosion  白狼王自爆：轰鸣 + 超低频下潜
 *   · playReveal     白痴翻牌：翻牌 whoosh + 上行揭示音
 * 所有调用都做「静音 / 不支持」兜底，失败不抛错。
 */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AC = w.AudioContext ?? w.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }
  return ctx;
}

function master(c: AudioContext, volume: number): GainNode {
  const g = c.createGain();
  g.gain.value = Math.max(0, Math.min(1, volume));
  g.connect(c.destination);
  return g;
}

function noiseBuffer(c: AudioContext, seconds: number): AudioBuffer {
  const len = Math.max(1, Math.floor(c.sampleRate * seconds));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** 猎人开枪 */
export function playGunshot(volume = 1): void {
  const c = getCtx();
  if (!c) return;
  const t0 = c.currentTime;
  const out = master(c, volume);

  // 1) 枪口爆响：白噪 + 低通快速下扫
  const crack = c.createBufferSource();
  crack.buffer = noiseBuffer(c, 0.25);
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(4200, t0);
  lp.frequency.exponentialRampToValueAtTime(400, t0 + 0.22);
  const cg = c.createGain();
  cg.gain.setValueAtTime(0.0001, t0);
  cg.gain.exponentialRampToValueAtTime(0.9, t0 + 0.006);
  cg.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.24);
  crack.connect(lp);
  lp.connect(cg);
  cg.connect(out);
  crack.start(t0);
  crack.stop(t0 + 0.26);

  // 2) 低频冲击（胸腔感）
  const thump = c.createOscillator();
  thump.type = "triangle";
  thump.frequency.setValueAtTime(180, t0);
  thump.frequency.exponentialRampToValueAtTime(60, t0 + 0.18);
  const tg = c.createGain();
  tg.gain.setValueAtTime(0.0001, t0);
  tg.gain.exponentialRampToValueAtTime(0.5, t0 + 0.008);
  tg.gain.exponentialRampToValueAtTime(0.0006, t0 + 0.2);
  thump.connect(tg);
  tg.connect(out);
  thump.start(t0);
  thump.stop(t0 + 0.22);

  // 3) 远处余响
  const tail = c.createBufferSource();
  tail.buffer = noiseBuffer(c, 0.6);
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 900;
  bp.Q.value = 0.8;
  const rg = c.createGain();
  rg.gain.setValueAtTime(0.0001, t0 + 0.05);
  rg.gain.exponentialRampToValueAtTime(0.14, t0 + 0.09);
  rg.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.58);
  tail.connect(bp);
  bp.connect(rg);
  rg.connect(out);
  tail.start(t0 + 0.05);
  tail.stop(t0 + 0.62);
}

/** 白狼王自爆 */
export function playExplosion(volume = 1): void {
  const c = getCtx();
  if (!c) return;
  const t0 = c.currentTime;
  const out = master(c, volume);

  const body = c.createBufferSource();
  body.buffer = noiseBuffer(c, 1.1);
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(1800, t0);
  lp.frequency.exponentialRampToValueAtTime(120, t0 + 0.9);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.85, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0006, t0 + 1.0);
  body.connect(lp);
  lp.connect(g);
  g.connect(out);
  body.start(t0);
  body.stop(t0 + 1.05);

  const sub = c.createOscillator();
  sub.type = "sine";
  sub.frequency.setValueAtTime(150, t0);
  sub.frequency.exponentialRampToValueAtTime(35, t0 + 0.7);
  const sg = c.createGain();
  sg.gain.setValueAtTime(0.0001, t0);
  sg.gain.exponentialRampToValueAtTime(0.6, t0 + 0.03);
  sg.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.75);
  sub.connect(sg);
  sg.connect(out);
  sub.start(t0);
  sub.stop(t0 + 0.8);
}

/** 白痴翻牌（翻牌 whoosh + 上行揭示音） */
export function playReveal(volume = 1): void {
  const c = getCtx();
  if (!c) return;
  const t0 = c.currentTime;
  const out = master(c, volume);

  const whoosh = c.createBufferSource();
  whoosh.buffer = noiseBuffer(c, 0.22);
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(500, t0);
  bp.frequency.exponentialRampToValueAtTime(2600, t0 + 0.2);
  bp.Q.value = 1.1;
  const wg = c.createGain();
  wg.gain.setValueAtTime(0.0001, t0);
  wg.gain.exponentialRampToValueAtTime(0.28, t0 + 0.03);
  wg.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.22);
  whoosh.connect(bp);
  bp.connect(wg);
  wg.connect(out);
  whoosh.start(t0);
  whoosh.stop(t0 + 0.24);

  const notes: Array<[number, number]> = [
    [880, 0.0],
    [1318.5, 0.1],
  ];
  for (const [freq, at] of notes) {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const ng = c.createGain();
    const start = t0 + at;
    ng.gain.setValueAtTime(0.0001, start);
    ng.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
    ng.gain.exponentialRampToValueAtTime(0.0004, start + 0.34);
    osc.connect(ng);
    ng.connect(out);
    osc.start(start);
    osc.stop(start + 0.36);
  }
}
