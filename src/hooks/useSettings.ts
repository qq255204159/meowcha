"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "meowcha.settings.audio";

export interface AudioSettings {
  bgmVolume: number;
  isSoundEnabled: boolean;
  isAiVoiceEnabled: boolean;
  isGenshinMode: boolean;
}

const defaultSettings: AudioSettings = {
  bgmVolume: 0.35,
  isSoundEnabled: true,
  isAiVoiceEnabled: true,
  isGenshinMode: false,
};

const clampVolume = (value: number) => Math.min(1, Math.max(0, value));

const normalizeSettings = (value: Partial<AudioSettings>): AudioSettings => {
  return {
    bgmVolume: clampVolume(
      typeof value.bgmVolume === "number" ? value.bgmVolume : defaultSettings.bgmVolume
    ),
    isSoundEnabled:
      typeof value.isSoundEnabled === "boolean" ? value.isSoundEnabled : defaultSettings.isSoundEnabled,
    isAiVoiceEnabled:
      typeof value.isAiVoiceEnabled === "boolean" ? value.isAiVoiceEnabled : defaultSettings.isAiVoiceEnabled,
    // 2026-10-16 站长要求移除「大模型原神模式」开关：此处恒为 false ——
    // 即便旧存储（meowcha.settings.audio）里留了 true 也不再恢复，配合界面移除彻底关闭该模式
    isGenshinMode: false,
  };
};

export function useSettings() {
  const [settings, setSettings] = useState<AudioSettings>(defaultSettings);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      setIsLoaded(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<AudioSettings>;
      setSettings(normalizeSettings(parsed));
    } catch {
      setSettings(defaultSettings);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings, isLoaded]);

  const setBgmVolume = useCallback((value: number) => {
    setSettings((prev) => ({ ...prev, bgmVolume: clampVolume(value) }));
  }, []);

  const setSoundEnabled = useCallback((value: boolean) => {
    setSettings((prev) => ({ ...prev, isSoundEnabled: value }));
  }, []);

  const setAiVoiceEnabled = useCallback((value: boolean) => {
    setSettings((prev) => ({ ...prev, isAiVoiceEnabled: value }));
  }, []);

  const setGenshinMode = useCallback((value: boolean) => {
    setSettings((prev) => ({ ...prev, isGenshinMode: value }));
  }, []);

  return {
    settings,
    isLoaded,
    setBgmVolume,
    setSoundEnabled,
    setAiVoiceEnabled,
    setGenshinMode,
  };
}
