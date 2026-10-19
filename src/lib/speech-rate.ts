"use client";

/**
 * 喵杀 · 语音语速
 *
 * 单一真源：前端播放层统一从这里取语速（TTS 语音 + 旁白播报都走它），
 * 用 HTMLAudioElement.playbackRate 实现 → 不依赖后端、不需要重新合成。
 * ⚠️ 只影响「人声」，BGM（page.tsx 的 bgmAudioRef）不走这里，保持原速。
 *
 * 默认 1.25×（站长反馈原先偏慢）。
 */

import { useSyncExternalStore } from "react";

export const SPEECH_RATE_STORAGE_KEY = "meowcha_speech_rate";

export const SPEECH_RATE_OPTIONS = [1, 1.25, 1.5, 2, 2.5] as const;
export type SpeechRate = (typeof SPEECH_RATE_OPTIONS)[number];

export const DEFAULT_SPEECH_RATE: SpeechRate = 1.25;

let cached: SpeechRate | null = null;
const listeners = new Set<() => void>();

function coerce(value: unknown): SpeechRate {
  const n = Number(value);
  return (SPEECH_RATE_OPTIONS as readonly number[]).includes(n)
    ? (n as SpeechRate)
    : DEFAULT_SPEECH_RATE;
}

/** 读取当前语速（内存缓存 + localStorage 持久化） */
export function getSpeechRate(): SpeechRate {
  if (cached !== null) return cached;
  let v: SpeechRate = DEFAULT_SPEECH_RATE;
  try {
    if (typeof window !== "undefined") {
      const raw = window.localStorage.getItem(SPEECH_RATE_STORAGE_KEY);
      if (raw !== null) v = coerce(raw);
    }
  } catch {
    /* 隐私模式等场景下读写失败 → 用默认值 */
  }
  cached = v;
  return v;
}

/** 设置语速并持久化 + 通知订阅者 */
export function setSpeechRate(rate: number): void {
  const v = coerce(rate);
  cached = v;
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SPEECH_RATE_STORAGE_KEY, String(v));
    }
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

/** 供 useSyncExternalStore 使用 */
export function subscribeSpeechRate(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 把当前语速应用到某个 audio 元素（null 安全） */
export function applySpeechRate(audio: HTMLAudioElement | null | undefined): void {
  if (!audio) return;
  const rate = getSpeechRate();
  try {
    // 保持音高不变（默认即为 true，这里显式设置以防个别浏览器差异）
    (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    audio.playbackRate = rate;
  } catch {
    /* ignore */
  }
}

/** 组件里读写语速 */
export function useSpeechRate(): [SpeechRate, (rate: number) => void] {
  const rate = useSyncExternalStore(
    subscribeSpeechRate,
    getSpeechRate,
    () => DEFAULT_SPEECH_RATE
  );
  return [rate, setSpeechRate];
}
