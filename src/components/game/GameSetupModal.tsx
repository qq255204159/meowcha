"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Info } from "@phosphor-icons/react";
import { SoundSettingsSection } from "@/components/game/SettingsModal";
import { AboutModal } from "@/components/game/AboutModal";
import { BRAND } from "@/lib/brand";

interface GameSetupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bgmVolume: number;
  isSoundEnabled: boolean;
  isAiVoiceEnabled: boolean;
  onBgmVolumeChange: (value: number) => void;
  onSoundEnabledChange: (value: boolean) => void;
  onAiVoiceEnabledChange: (value: boolean) => void;
}

/**
 * 主页「设置」弹窗。
 * 2026-10-17 调整：难度 / 人数 / 规则配置 三项已移入「今夜怎么开局喵？」那个选择弹窗
 * （单人局与邀请朋友局都会带入这三项设置），这里只保留声音与关于；
 * 「关于」也按站长要求挪到最下面（配音开关的下面）。
 */
export function GameSetupModal({
  open,
  onOpenChange,
  bgmVolume,
  isSoundEnabled,
  isAiVoiceEnabled,
  onBgmVolumeChange,
  onSoundEnabledChange,
  onAiVoiceEnabledChange,
}: GameSetupModalProps) {
  const [isAboutOpen, setIsAboutOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif text-[var(--text-primary)]">设置</DialogTitle>
          <DialogDescription className="text-[var(--text-muted)]">
            声音、音效与关于
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <div className="text-sm font-medium text-[var(--text-primary)]">声音</div>
            <SoundSettingsSection
              bgmVolume={bgmVolume}
              isSoundEnabled={isSoundEnabled}
              isAiVoiceEnabled={isAiVoiceEnabled}
              onBgmVolumeChange={onBgmVolumeChange}
              onSoundEnabledChange={onSoundEnabledChange}
              onAiVoiceEnabledChange={onAiVoiceEnabledChange}
            />
          </div>

          <div className="space-y-2 border-t border-[var(--border-color)] pt-4">
            <div className="text-sm font-medium text-[var(--text-primary)]">关于</div>
            <button
              type="button"
              onClick={() => setIsAboutOpen(true)}
              className="w-full inline-flex items-center justify-center gap-2 h-9 px-4 text-sm font-medium rounded-sm border-2 border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <Info size={16} />
              关于{BRAND.name}
            </button>
            <div className="text-xs text-[var(--text-muted)]">二创说明、开源出处与免责声明</div>
          </div>
        </div>
      </DialogContent>

      {/* 关于喵杀：2026-10-16 由首页右上角「关于」按钮迁移至此 */}
      <AboutModal open={isAboutOpen} onOpenChange={setIsAboutOpen} />
    </Dialog>
  );
}
