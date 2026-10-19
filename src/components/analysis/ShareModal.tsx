"use client";

import { useState, useRef, useCallback } from "react";
import { X, Image as ImageIcon, Loader2, BarChart3, User } from "lucide-react";
import { toPng } from "html-to-image";
import type { GameAnalysisData } from "@/types/analysis";
import { SharePoster } from "./SharePoster";

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  data: GameAnalysisData;
  overrideTag?: string | null;
}

export type PosterMode = "radar" | "portrait";

const POSTER_EXPORT_PIXEL_RATIO = 3;
// 纸页版：导出底色与复盘页一致（暖米白纸底）
const POSTER_EXPORT_BACKGROUND_COLOR = "#f3ead7";

async function waitForImagesInElement(element: HTMLElement): Promise<void> {
  const images = Array.from(element.querySelectorAll("img"));
  if (images.length === 0) return;

  await Promise.all(
    images.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            resolve();
            return;
          }

          const cleanup = () => {
            img.removeEventListener("load", handleLoad);
            img.removeEventListener("error", handleError);
          };

          const handleLoad = () => {
            cleanup();
            resolve();
          };

          const handleError = () => {
            cleanup();
            resolve();
          };

          img.addEventListener("load", handleLoad, { once: true });
          img.addEventListener("error", handleError, { once: true });
        })
    )
  );
}

export function ShareModal({ isOpen, onClose, data, overrideTag }: ShareModalProps) {
  const [isGeneratingPoster, setIsGeneratingPoster] = useState(false);
  const [posterMode, setPosterMode] = useState<PosterMode>("radar");
  const posterContainerRef = useRef<HTMLDivElement>(null);

  const handleSavePoster = useCallback(async () => {
    if (!posterContainerRef.current || isGeneratingPoster) return;

    setIsGeneratingPoster(true);
    try {
      await document.fonts?.ready;

      await waitForImagesInElement(posterContainerRef.current);

      const dataUrl = await toPng(posterContainerRef.current, {
        cacheBust: true,
        pixelRatio: POSTER_EXPORT_PIXEL_RATIO,
        backgroundColor: POSTER_EXPORT_BACKGROUND_COLOR,
      });

      const link = document.createElement("a");
      link.download = `meowcha-report-${data.gameId.slice(0, 8)}.png`;
      link.href = dataUrl;
      link.click();
    } catch (error) {
      console.error("Failed to generate poster:", error);
    } finally {
      setIsGeneratingPoster(false);
    }
  }, [data.gameId, isGeneratingPoster]);


  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal：整体限高 + flex 列，让「海报预览」单独滚动，头/按钮固定不动
          （此前预览区只有 overflow-auto 且海报自身写死高度 → 内容被裁且拖不动）
          纸页版：外壳与复盘页同色（暖米白纸底 + 墨金描边 + 暗墨字） */}
      <div className="relative z-10 bg-[#f7efdd] border border-[#967444]/30 rounded-xl shadow-2xl max-w-[420px] w-full mx-4 max-h-[90vh] flex flex-col overflow-hidden text-[#2e2517]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#967444]/20 shrink-0">
          <h2 className="text-lg font-bold text-[#9a7a3c] tracking-wider">
            分享海报
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-[#967444]/10 transition-colors"
          >
            <X className="w-5 h-5 text-[#8a7757]" />
          </button>
        </div>

        {/* Mode Toggle */}
        <div className="px-5 pt-4 flex justify-center shrink-0">
          <div className="inline-flex rounded-lg bg-[#e6dac0]/70 p-1 border border-[#967444]/20">
            <button
              onClick={() => setPosterMode("radar")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                posterMode === "radar"
                  ? "bg-[#9a7a3c]/18 text-[#8c6f33]"
                  : "text-[#8a7757] hover:text-[#5c4a33]"
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              雷达图
            </button>
            <button
              onClick={() => setPosterMode("portrait")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                posterMode === "portrait"
                  ? "bg-[#9a7a3c]/18 text-[#8c6f33]"
                  : "text-[#8a7757] hover:text-[#5c4a33]"
              }`}
            >
              <User className="w-3.5 h-3.5" />
              称号
            </button>
          </div>
        </div>

        {/* Poster Preview（唯一滚动区：flex-1 + min-h-0 + overflow-y-auto） */}
        <div className="flex-1 min-h-0 overflow-y-auto p-5 pt-3 flex justify-center">
          <div
            ref={posterContainerRef}
            className="shadow-2xl rounded-lg border border-[#967444]/20 self-start"
          >
            <SharePoster data={data} mode={posterMode} overrideTag={overrideTag} />
          </div>
        </div>

        {/* Actions */}
        <div className="px-5 py-4 border-t border-[#967444]/20 space-y-3 shrink-0">
          <button
            onClick={handleSavePoster}
            disabled={isGeneratingPoster}
            className="w-full flex items-center justify-center gap-2 bg-[#9a7a3c] text-[#fffaf0] font-bold py-3 rounded-lg hover:bg-[#8c6f33] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isGeneratingPoster ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ImageIcon className="w-4 h-4" />
            )}
            {isGeneratingPoster ? "生成中..." : "保存海报"}
          </button>

        </div>
      </div>
    </div>
  );
}
