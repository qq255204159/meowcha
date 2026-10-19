/**
 * 旁白语音播放器（单例模式）
 * 用于在游戏流程中播放预生成的旁白语音
 */

import { getNarratorAudioPath, type NarratorTextKey } from "./narrator-voice";
import { getLocale } from "@/i18n/locale-store";
import type { AppLocale } from "./voice-constants";
import { applySpeechRate } from "./speech-rate";

/**
 * 旁白「广播」钩子（联机 · 房主侧用）。
 * 喵杀修复（2026-10-19 · 站长实测）：客人端本地**不跑引擎**，所以引擎里那些
 * `playNarrator(...)`（天黑、睁眼、天亮、死讯、竞选、开枪前的宣告…）在朋友那边一句都听不到。
 * 房主在每次播放旁白时通过这个钩子把「口令」记下来、随房间数据下发，客人据此播同一句。
 * 单机 / 未联机时不设钩子，行为完全不变。
 */
type NarratorRelay = (key: NarratorTextKey) => void;
let narratorRelay: NarratorRelay | null = null;

export function setNarratorRelay(fn: NarratorRelay | null): void {
  narratorRelay = fn;
}

class NarratorAudioPlayer {
  private static instance: NarratorAudioPlayer | null = null;
  private audio: HTMLAudioElement | null = null;
  private enabled: boolean = true;
  private volume: number = 1.0;
  private isPlaying: boolean = false;

  private constructor() {}

  static getInstance(): NarratorAudioPlayer {
    if (!NarratorAudioPlayer.instance) {
      NarratorAudioPlayer.instance = new NarratorAudioPlayer();
    }
    return NarratorAudioPlayer.instance;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.stop();
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.audio) {
      this.audio.volume = this.volume;
    }
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  stop(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio = null;
    }
    this.isPlaying = false;
  }

  /**
   * 播放旁白语音
   * @param key 旁白文本键名
   * @param localeOverride 可选：强制指定语言，不传则自动检测
   * @returns Promise，播放完成后 resolve
   */
  async play(key: NarratorTextKey, localeOverride?: AppLocale): Promise<void> {
    if (!this.enabled) return;
    if (typeof window === "undefined") return;

    // 联机 · 房主：先把口令广播出去（朋友那边据此播放同一句旁白），再放本机的
    narratorRelay?.(key);

    // 停止当前播放
    this.stop();

    // 获取当前语言设置
    const locale: AppLocale = localeOverride ?? (getLocale() as AppLocale);
    const audioPath = getNarratorAudioPath(key);
    console.log(`[NarratorAudioPlayer] Playing: ${key} (${locale}) from ${audioPath}`);

    return new Promise((resolve) => {
      const audio = new Audio(audioPath);
      audio.volume = this.volume;
      audio.preload = "auto";
      // 喵杀：旁白也走同一语速设置
      applySpeechRate(audio);
      this.audio = audio;

      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        audio.onended = null;
        audio.onerror = null;
        audio.onloadeddata = null;
        this.isPlaying = false;
      };

      audio.onended = () => {
        console.log(`[NarratorAudioPlayer] Ended: ${key}`);
        cleanup();
        resolve();
      };

      audio.onerror = (e) => {
        console.warn(`[NarratorAudioPlayer] Error loading: ${key}`, e);
        cleanup();
        resolve();
      };

      // 直接尝试播放，不等待 canplaythrough
      audio.load();
      this.isPlaying = true;
      audio.play()
        .then(() => {
          console.log(`[NarratorAudioPlayer] Started: ${key}`);
        })
        .catch((err) => {
          console.warn(`[NarratorAudioPlayer] Failed to play: ${key}`, err);
          cleanup();
          resolve();
        });

      // 超时保护
      setTimeout(() => {
        if (!resolved) {
          console.warn(`[NarratorAudioPlayer] Timeout: ${key}`);
          cleanup();
          resolve();
        }
      }, 10000);
    });
  }

  /**
   * 播放旁白语音（不等待完成）
   * @param key 旁白文本键名
   */
  playAsync(key: NarratorTextKey): void {
    this.play(key).catch(() => {});
  }
}

// 导出单例获取函数
export const getNarratorPlayer = (): NarratorAudioPlayer => {
  return NarratorAudioPlayer.getInstance();
};

// 便捷函数：播放旁白（等待完成）
export const playNarrator = async (key: NarratorTextKey, locale?: AppLocale): Promise<void> => {
  return getNarratorPlayer().play(key, locale);
};

// 便捷函数：播放旁白（不等待）
export const playNarratorAsync = (key: NarratorTextKey, locale?: AppLocale): void => {
  getNarratorPlayer().play(key, locale).catch(() => {});
};

// 便捷函数：停止旁白
export const stopNarrator = (): void => {
  getNarratorPlayer().stop();
};
