import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useCallback, useMemo } from "react";
import type { GameState } from "@/types/game";

interface SoundSettingsSectionProps {
  bgmVolume: number;
  isSoundEnabled: boolean;
  isAiVoiceEnabled: boolean;
  onBgmVolumeChange: (value: number) => void;
  onSoundEnabledChange: (value: boolean) => void;
  onAiVoiceEnabledChange: (value: boolean) => void;
}

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bgmVolume: number;
  isSoundEnabled: boolean;
  isAiVoiceEnabled: boolean;
  gameState: GameState;
  onBgmVolumeChange: (value: number) => void;
  onSoundEnabledChange: (value: boolean) => void;
  onAiVoiceEnabledChange: (value: boolean) => void;
  /** 退出对局：放弃本局并返回狼人杀主页（2026-10-16 新增） */
  onAbortGame: () => void;
}

export function SoundSettingsSection({
  bgmVolume,
  isSoundEnabled,
  isAiVoiceEnabled,
  onBgmVolumeChange,
  onSoundEnabledChange,
  onAiVoiceEnabledChange,
}: SoundSettingsSectionProps) {
  const volumePercent = Math.round(bgmVolume * 100);

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex items-center justify-between text-sm text-[var(--text-primary)]">
          <span>背景音量</span>
          <span className="text-[var(--text-secondary)]">{volumePercent}%</span>
        </div>
        <Slider
          min={0}
          max={100}
          step={1}
          value={volumePercent}
          onValueChange={(value) => onBgmVolumeChange(value / 100)}
          disabled={!isSoundEnabled}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-[var(--text-primary)]">总开关</div>
          <div className="text-xs text-[var(--text-muted)]">关闭后将静音所有音效</div>
        </div>
        <Switch checked={isSoundEnabled} onCheckedChange={onSoundEnabledChange} />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-[var(--text-primary)]">角色配音</div>
          <div className="text-xs text-[var(--text-muted)]">控制 AI 角色语音播放</div>
        </div>
        <Switch
          checked={isAiVoiceEnabled}
          onCheckedChange={onAiVoiceEnabledChange}
          disabled={!isSoundEnabled}
        />
      </div>
    </div>
  );
}

export function SettingsModal({
  open,
  onOpenChange,
  bgmVolume,
  isSoundEnabled,
  isAiVoiceEnabled,
  gameState,
  onBgmVolumeChange,
  onSoundEnabledChange,
  onAiVoiceEnabledChange,
  onAbortGame,
}: SettingsModalProps) {
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";

  const logJsonText = useMemo(() => {
    const exportedAt = new Date().toISOString();
    const env = typeof window === "undefined" ? undefined : {
      url: window.location.href,
      userAgent: window.navigator.userAgent,
      language: window.navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };

    const payload = {
      meta: {
        app: "meowcha",
        appVersion,
        exportedAt,
      },
      env,
      settings: {
        bgmVolume,
        isSoundEnabled,
        isAiVoiceEnabled,
      },
      gameState,
    };

    return JSON.stringify(payload, null, 2);
  }, [appVersion, bgmVolume, gameState, isAiVoiceEnabled, isSoundEnabled]);

  const handleCopyLog = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(logJsonText);
      toast("已复制日志 JSON");
    } catch {
      toast("复制失败", { description: "当前环境不支持剪贴板或权限被拒绝" });
    }
  }, [logJsonText]);

  const handleDownloadLog = useCallback(() => {
    try {
      const blob = new Blob([logJsonText], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safeGameId = (gameState.gameId || "").replace(/[^a-zA-Z0-9_-]/g, "");
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.href = url;
      a.download = `meowcha-log-${safeGameId || "game"}-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("已导出日志文件");
    } catch {
      toast("导出失败");
    }
  }, [gameState.gameId, logJsonText]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-serif text-[var(--text-primary)]">设置</DialogTitle>
          <DialogDescription className="text-[var(--text-muted)]">调整偏好并导出日志</DialogDescription>
        </DialogHeader>

        {/* 说明：AI 模型（LLM）配置在**主页**的「设置」弹窗里（见 GameSetupModal 的 ApiConfigSection）；
            对局内的这个设置只保留声音与日志，避免玩家在局中误改配置 */}
        <div className="space-y-6">
          <SoundSettingsSection
            bgmVolume={bgmVolume}
            isSoundEnabled={isSoundEnabled}
            isAiVoiceEnabled={isAiVoiceEnabled}
            onBgmVolumeChange={onBgmVolumeChange}
            onSoundEnabledChange={onSoundEnabledChange}
            onAiVoiceEnabledChange={onAiVoiceEnabledChange}
          />

          <div className="rounded-lg border-2 border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 space-y-3">
            <div>
              <div className="text-sm font-medium text-[var(--text-primary)]">日志</div>
              <div className="text-xs text-[var(--text-muted)]">遇到问题时，可导出 JSON 日志便于定位</div>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => { void handleCopyLog(); }} className="flex-1">
                复制 JSON
              </Button>
              <Button type="button" variant="default" onClick={handleDownloadLog} className="flex-1">
                导出文件
              </Button>
            </div>
          </div>

          {/* 退出对局（2026-10-16 新增）：放弃本局并返回狼人杀主页 */}
          <div className="rounded-lg border-2 border-red-500/30 bg-[var(--bg-card)] p-3 space-y-2">
            <div>
              <div className="text-sm font-medium text-red-400">退出对局</div>
              <div className="text-xs text-[var(--text-muted)]">
                立即结束本局并返回狼人杀主页（返回后本局进度将被放弃，无法恢复）
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full border-red-500/40 text-red-400 hover:bg-red-500/10"
              onClick={() => {
                if (
                  typeof window !== "undefined" &&
                  !window.confirm(
                    "确定要退出对局吗？\n\n本局进度将被放弃且无法恢复，随后返回狼人杀主页。"
                  )
                ) {
                  return;
                }
                onOpenChange(false);
                onAbortGame();
              }}
            >
              退出本局并返回主页
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
