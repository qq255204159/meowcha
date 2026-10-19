"use client";

import { forwardRef, useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Crown, Scroll } from "lucide-react";
import type { GameAnalysisData } from "@/types/analysis";
import { ROLE_NAMES } from "./constants";
import { buildSimpleAvatarUrl } from "@/lib/avatar-config";
import { BRAND } from "@/lib/brand";

export type PosterMode = "radar" | "portrait";

interface SharePosterProps {
  data: GameAnalysisData;
  mode?: PosterMode;
  overrideTag?: string | null;
}

// 分享海报上的站点信息（**部署时请用环境变量覆盖**；不覆盖则显示下面的示例占位地址）。
const SITE_URL = process.env.NEXT_PUBLIC_SITE_DISPLAY_URL ?? "your-domain.example/meowcha";
const SITE_FULL_URL = process.env.NEXT_PUBLIC_SITE_URL ?? `https://${SITE_URL}`;

// 喵杀（十二·五轮）：原 ROLE_PORTRAITS（/职业/*.png）与重复的 ROLE_CN_NAMES 已移除。
// ROLE_PORTRAITS 缺 basePath 会破图，且其唯一的消费变量 portraitUrl 本就没被渲染；
// 角色中文名统一用 ./constants 的 ROLE_NAMES（海报正文已在使用）。

const DEFAULT_TAG_PHOTO = "";

const VILLAGER_TAGS = ["明察秋毫", "随波逐流", "全场划水"];
const WOLF_TAGS = ["嗜血猎手", "长夜难明", "完美猎杀", "演技大师", "绝命赌徒", "绝地反击", "孤狼啸月", "出师未捷"];

function getTagPhotoUrl(_role: string, _tag: string): string {
  return "";
}

// 纸页版配色（与复盘页 .analysis-page 同一套）
const INK = "#2e2517";
const INK_SOFT = "#5c4a33";
const INK_MUTED = "#8a7757";
const GOLD = "#9a7a3c";
const PAPER_TOP = "#f8f1e0";
const PAPER_BOTTOM = "#eee1c6";

interface RadarChartProps {
  stats: GameAnalysisData["personalStats"]["radarStats"];
  isWolf: boolean;
}

function RadarChart({ stats, isWolf }: RadarChartProps) {
  const labels = isWolf
    ? ["逻辑", "发言", "存活", "隐匿", "冲票"]
    : ["逻辑", "发言", "存活", "技能", "投票"];
  const values = [stats.logic, stats.speech, stats.survival, stats.skillOrHide, stats.voteOrTicket];

  const size = 200;
  const center = size / 2;
  const radius = 50;
  const goldColor = GOLD;

  const getPoint = (index: number, value: number) => {
    const angle = (Math.PI * 2 * index) / 5 - Math.PI / 2;
    const r = (radius * value) / 100;
    return { x: center + Math.cos(angle) * r, y: center + Math.sin(angle) * r };
  };

  const getLabelPoint = (index: number) => {
    const angle = (Math.PI * 2 * index) / 5 - Math.PI / 2;
    const r = radius + 28;
    return { x: center + Math.cos(angle) * r, y: center + Math.sin(angle) * r };
  };

  const gridLevels = [1, 2, 3, 4, 5];
  const dataPoints = values.map((v, i) => getPoint(i, v));
  const dataPath = dataPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ") + " Z";

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {gridLevels.map((level) => {
        const points = Array.from({ length: 5 }, (_, i) => {
          const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
          const r = (radius * level) / 5;
          return `${center + Math.cos(angle) * r},${center + Math.sin(angle) * r}`;
        }).join(" ");
        return <polygon key={level} points={points} fill="none" stroke={goldColor} strokeOpacity={0.22} strokeWidth={0.5} />;
      })}

      {Array.from({ length: 5 }, (_, i) => {
        const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
        return (
          <line key={i} x1={center} y1={center} x2={center + Math.cos(angle) * radius} y2={center + Math.sin(angle) * radius} stroke={goldColor} strokeOpacity={0.22} strokeWidth={0.5} />
        );
      })}

      <defs>
        <linearGradient id="radarGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={goldColor} stopOpacity={0.42} />
          <stop offset="100%" stopColor={goldColor} stopOpacity={0.08} />
        </linearGradient>
      </defs>
      <path d={dataPath} fill="url(#radarGradient)" stroke={goldColor} strokeWidth={1.5} />

      {dataPoints.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.5} fill="#fffaf0" stroke={goldColor} strokeWidth={1.5} />
      ))}

      {labels.map((label, i) => {
        const p = getLabelPoint(i);
        const anchor = i === 0 ? "middle" : i < 3 ? "start" : "end";
        const dy = i === 0 ? -4 : i === 2 || i === 3 ? 4 : 0;
        return (
          <text key={i} x={p.x} y={p.y + dy} textAnchor={anchor} dominantBaseline="middle" fill={INK_SOFT} fontSize={11} fontWeight="500">
            {label}
          </text>
        );
      })}
    </svg>
  );
}

export const SharePoster = forwardRef<HTMLDivElement, SharePosterProps>(
  function SharePoster({ data, mode = "radar", overrideTag }, ref) {
    const { personalStats, result, duration, playerCount } = data;
    const isVillageWin = result === "village_win";
    const isWinner =
      (isVillageWin && personalStats.alignment === "village") ||
      (!isVillageWin && personalStats.alignment === "wolf");
    const isWolf = personalStats.alignment === "wolf";
    const primaryTag = overrideTag || personalStats.tags[0] || "待评估";
    const avatarUrl = buildSimpleAvatarUrl(personalStats.avatar);
    const { radarStats } = personalStats;
    const [tagPhotoSrc, setTagPhotoSrc] = useState(() => getTagPhotoUrl(personalStats.role, primaryTag));
    
    useEffect(() => {
      setTagPhotoSrc(getTagPhotoUrl(personalStats.role, primaryTag));
    }, [personalStats.role, primaryTag]);
    
    const handleTagPhotoError = () => {
      if (tagPhotoSrc !== DEFAULT_TAG_PHOTO) {
        setTagPhotoSrc(DEFAULT_TAG_PHOTO);
      }
    };

    const formatDuration = (seconds: number): string => {
      // 时长缺失/为 0 时不要显示 0:00（站长反馈），用占位符
      if (!Number.isFinite(seconds) || seconds <= 0) return "—";
      const mins = Math.floor(seconds / 60);
      const secs = Math.round(seconds % 60);
      return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    return (
      <div
        ref={ref}
        className="w-[360px] min-h-[640px] text-[#2e2517] relative flex flex-col border border-[#967444]/30"
        style={{
          fontFamily: "'Noto Serif SC', serif",
          backgroundColor: "#f3ead7",
          backgroundImage:
            "radial-gradient(760px 420px at 12% -8%, rgba(255,253,247,0.95), transparent 62%), radial-gradient(620px 380px at 92% 8%, rgba(224,199,156,0.42), transparent 64%), repeating-linear-gradient(105deg, rgba(150,116,68,0.035) 0 2px, transparent 2px 10px), linear-gradient(180deg, " +
            PAPER_TOP +
            " 0%, " +
            PAPER_BOTTOM +
            " 100%)",
        }}
      >
        {/* Header */}
        <div className="px-4 pt-4 pb-2 flex items-center justify-between border-b border-[#9a7a3c]/25">
          <div className="flex items-center space-x-1.5">
            <Scroll className="w-4 h-4 text-[#9a7a3c]" />
            <span className="text-[#9a7a3c] font-bold text-sm tracking-wider">{BRAND.nameEnHuman}</span>
          </div>
          <div
            className={`inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap ${
              isWinner
                ? "bg-[#9a7a3c]/15 text-[#8c6f33] border border-[#9a7a3c]/40"
                : "bg-[#8a7757]/10 text-[#6b5a42] border border-[#8a7757]/25"
            }`}
          >
            <Crown className="w-3 h-3" />
            {isVillageWin ? "好人获胜" : "狼人获胜"}
          </div>
        </div>

        {/* Player Info Row */}
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="w-12 h-12 rounded-full border-2 border-[#9a7a3c]/40 p-0.5 bg-[#e6dac0] overflow-hidden flex-shrink-0">
            <img src={avatarUrl} alt="Avatar" className="w-full h-full rounded-full object-cover" crossOrigin="anonymous" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold truncate">{personalStats.userName}</h2>
            <div className="flex items-center space-x-1.5 mt-1 text-[10px] text-[#8a7757]">
              <span className="px-1.5 py-0.5 border border-[#967444]/25 rounded bg-[#fffaf0]/70 whitespace-nowrap">{ROLE_NAMES[personalStats.role]}</span>
              <span className="px-1.5 py-0.5 border border-[#967444]/25 rounded bg-[#fffaf0]/70 whitespace-nowrap">{formatDuration(duration)}</span>
              <span className="px-1.5 py-0.5 border border-[#967444]/25 rounded bg-[#fffaf0]/70 whitespace-nowrap">{playerCount}人局</span>
            </div>
          </div>
        </div>

        {/* Stats Row */}
        <div className="px-4 pb-2">
          <div className="flex gap-2">
            <div className="flex-1 bg-[#fffaf0]/80 rounded-lg py-2 px-3 border border-[#9a7a3c]/15 text-center">
              <div className="text-xl font-bold text-[#9a7a3c]">{personalStats.totalScore}</div>
              <div className="text-[9px] text-[#8a7757] tracking-wider">综合评分</div>
            </div>
            <div className="flex-1 bg-[#fffaf0]/80 rounded-lg py-2 px-3 border border-[#9a7a3c]/15 text-center">
              <div className="text-sm font-bold text-[#9a7a3c] leading-6">{primaryTag}</div>
              <div className="text-[9px] text-[#8a7757] tracking-wider">获得称号</div>
            </div>
          </div>
        </div>

        {/* Content Section - Radar or Portrait */}
        {mode === "radar" ? (
          <div className="flex-1 px-4 py-1 flex flex-col">
            <div className="bg-[#fffaf0]/70 rounded-lg p-2 border border-[#9a7a3c]/15 flex-1 flex flex-col justify-center">
              <div className="flex items-center justify-center">
                <RadarChart stats={radarStats} isWolf={isWolf} />
              </div>
              <div className="grid grid-cols-5 gap-1 text-center">
                <div>
                  <div className="text-sm font-bold text-[#9a7a3c]">{radarStats.logic}</div>
                  <div className="text-[8px] text-[#8a7757]">逻辑</div>
                </div>
                <div>
                  <div className="text-sm font-bold text-[#9a7a3c]">{radarStats.speech}</div>
                  <div className="text-[8px] text-[#8a7757]">发言</div>
                </div>
                <div>
                  <div className="text-sm font-bold text-[#9a7a3c]">{radarStats.survival}</div>
                  <div className="text-[8px] text-[#8a7757]">存活</div>
                </div>
                <div>
                  <div className="text-sm font-bold text-[#9a7a3c]">{radarStats.skillOrHide}</div>
                  <div className="text-[8px] text-[#8a7757]">{isWolf ? "隐匿" : "技能"}</div>
                </div>
                <div>
                  <div className="text-sm font-bold text-[#9a7a3c]">{radarStats.voteOrTicket}</div>
                  <div className="text-[8px] text-[#8a7757]">{isWolf ? "冲票" : "投票"}</div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 px-4 py-1 flex flex-col">
            <div className="rounded-lg border border-[#9a7a3c]/15 flex-1 flex flex-col overflow-hidden bg-[#fffaf0]/60">
              <div className="flex-1 relative overflow-hidden">
                {tagPhotoSrc && (
                  <img
                    src={tagPhotoSrc}
                    alt="称号立绘"
                    className="absolute inset-0 w-full h-full object-cover object-center"
                    onError={handleTagPhotoError}
                  />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-[#f3ead7] via-[#f3ead7]/55 to-transparent" />
                <div className="absolute inset-0 flex flex-col items-center justify-end pb-4">
                  <div className="text-[10px] text-[#9a7a3c]/80 tracking-widest mb-1">本局称号</div>
                  <div className="text-2xl font-bold text-[#9a7a3c] tracking-wider drop-shadow-sm">{primaryTag}</div>
                  {personalStats.tags.length > 1 && (
                    <div className="flex flex-wrap gap-1.5 justify-center mt-2">
                      {personalStats.tags.slice(1).map((tag, idx) => (
                        <span key={idx} className="px-2 py-0.5 text-[9px] text-[#9a7a3c] border border-[#9a7a3c]/30 rounded-full bg-[#fffaf0]/85">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="p-3">
                <div className="grid grid-cols-5 gap-1 text-center">
                  <div>
                    <div className="text-sm font-bold text-[#9a7a3c]">{radarStats.logic}</div>
                    <div className="text-[8px] text-[#8a7757]">逻辑</div>
                  </div>
                  <div>
                    <div className="text-sm font-bold text-[#9a7a3c]">{radarStats.speech}</div>
                    <div className="text-[8px] text-[#8a7757]">发言</div>
                  </div>
                  <div>
                    <div className="text-sm font-bold text-[#9a7a3c]">{radarStats.survival}</div>
                    <div className="text-[8px] text-[#8a7757]">存活</div>
                  </div>
                  <div>
                    <div className="text-sm font-bold text-[#9a7a3c]">{radarStats.skillOrHide}</div>
                    <div className="text-[8px] text-[#8a7757]">{isWolf ? "隐匿" : "技能"}</div>
                  </div>
                  <div>
                    <div className="text-sm font-bold text-[#9a7a3c]">{radarStats.voteOrTicket}</div>
                    <div className="text-[8px] text-[#8a7757]">{isWolf ? "冲票" : "投票"}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Highlight Quote */}
        {personalStats.highlightQuote && (
          <div className="px-4 pb-2">
            <div className="bg-[#9a7a3c]/10 rounded-lg p-3 border border-[#9a7a3c]/20">
              <div className="text-[11px] text-[#9a7a3c] tracking-wider font-bold mb-1.5">金句时刻</div>
              <p className="text-[12px] text-[#2e2517]/85 italic leading-relaxed line-clamp-2">“{personalStats.highlightQuote}”</p>
            </div>
          </div>
        )}

        {/* Footer with QR Code */}
        <div className="px-4 py-4 bg-[#efe3ca] border-t border-[#9a7a3c]/15 mt-auto">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[#9a7a3c] font-bold tracking-wider text-sm">{SITE_URL}</div>
              <div className="text-[9px] text-[#8a7757] mt-0.5">扫码加入{BRAND.name}</div>
            </div>
            <div className="bg-[#fffaf0] p-1.5 rounded border border-[#967444]/25">
              <QRCodeSVG value={SITE_FULL_URL} size={52} level="M" bgColor="#fffaf0" fgColor={INK} />
            </div>
          </div>
        </div>
      </div>
    );
  }
);
