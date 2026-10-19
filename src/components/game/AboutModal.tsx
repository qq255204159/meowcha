"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BRAND } from "@/lib/brand";

interface AboutModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AboutModal({ open, onOpenChange }: AboutModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-serif text-[var(--text-primary)]">
            关于 {BRAND.name}
          </DialogTitle>
          <DialogDescription className="text-[var(--text-muted)]">
            {BRAND.nameEn} · AI 驱动的复古童话风狼人杀
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* 项目定位 */}
          <div className="rounded-lg border-2 border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
            <div className="font-medium text-[var(--text-primary)] mb-2">项目定位</div>
            <ul className="space-y-1 text-[var(--text-muted)] text-xs">
              <li>• <strong>AI 驱动</strong> - 由大语言模型扮演村民，与你同桌对局</li>
              <li>• <strong>复古童话风</strong> - 手写契约、羊皮纸与夜晚剪影的沉浸演出</li>
              <li>• <strong>萌猫同桌</strong> - 16 款不同品种的可爱萌猫头像，离线内置</li>
              <li>• <strong>可自定义</strong> - 难度、人数与房规均可开局前调整</li>
            </ul>
          </div>

          {/* 二创说明 */}
          <div className="rounded-lg border-2 border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
            <div className="font-medium text-[var(--text-primary)] mb-2">二创说明</div>
            <ul className="space-y-1 text-[var(--text-muted)] text-xs leading-relaxed">
              <li>
                • {BRAND.name}（{BRAND.nameEn}）是由
                <a
                  className="underline hover:text-[var(--text-primary)]"
                  href={BRAND.authorUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {BRAND.author}
                </a>
                开发的狼人杀玩法<strong>深度二创版本</strong>
              </li>
              <li>
                • 二开自上游开源项目：
                {BRAND.upstream.map((repo) => (
                  <span key={repo}>
                    {" "}
                    <a
                      className="underline hover:text-[var(--text-primary)]"
                      href={`https://github.com/${repo}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {repo}
                    </a>
                  </span>
                ))}
              </li>
              <li>
                • 原玩法与代码以 <strong>{BRAND.license}</strong> 许可开源，本项目遵循同一许可
              </li>
              <li>• 更名、萌猫头像、界面与文案均在本版本中重新设计与创作</li>
            </ul>
          </div>

          {/* 免责声明 */}
          <div className="rounded-lg border-2 border-amber-500/30 bg-amber-500/5 p-3">
            <div className="font-medium text-amber-600 mb-2">免责声明</div>
            <ul className="space-y-1 text-[var(--text-muted)] text-xs leading-relaxed">
              <li>• 本项目仅供技术研究与学习交流</li>
              <li>• 禁止用于任何违法或违反道德的场景</li>
              <li>• AI 生成内容不代表开发者立场</li>
              <li>• 使用者需对自身行为负全责</li>
              <li>• 未成年人应在监护下使用</li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
