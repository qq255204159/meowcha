"use client";

import React, { useMemo } from "react";
import { buildAvatarUrl, getCatAvatarOpenPath, getModelLogoUrl } from "@/lib/avatar-config";
import type { Gender } from "@/lib/character-generator";
import type { ModelRef } from "@/types/game";

// ============================================
// 喵杀版立绘头像
// 十九轮：**真正的两帧口型动画**。此前十七轮因为「叠加层画出来的嘴像贴上去的人嘴」而改回静态；
// 现在每只猫都补了一张**同画风、与闭帧逐像素对齐的张嘴帧**（做法见 avatar-config 的
// getCatAvatarOpenPath 注释），于是这里用「闭帧 + 张帧」交替播放实现真口型，
// **身体完全静止（不再有任何摇晃/呼吸动效）**，只在嘴部有开合。
// ============================================

interface TalkingAvatarProps {
  seed: string;
  gender?: Gender;
  modelRef?: ModelRef;
  useModelLogo?: boolean;
  isTalking?: boolean;
  className?: string;
  alt?: string;
  scale?: number;
  translateY?: number;
}

export function TalkingAvatar(props: TalkingAvatarProps) {
  const {
    seed,
    modelRef,
    useModelLogo = false,
    isTalking = false,
    className = "",
    alt = "Avatar",
  } = props;

  const url = useMemo(() => buildAvatarUrl({ seed }), [seed]);
  const openUrl = useMemo(() => getCatAvatarOpenPath(seed), [seed]);

  if (useModelLogo) {
    return <img src={getModelLogoUrl(modelRef)} alt={alt} className={className} />;
  }

  // 没在说话：静态单帧（一动不动）
  if (!isTalking) {
    return <img src={url} alt={alt} draggable={false} className={className} />;
  }

  // 说话中：闭帧 + 张嘴帧 交替 → 真正的口型动画；身体静止，只有嘴开合
  return (
    <span className="wc-cat-flip">
      <img src={url} alt={alt} draggable={false} className={className} />
      <img
        src={openUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={`${className} wc-cat-flip__open`}
      />
    </span>
  );
}

interface TalkingAvatarSmallProps {
  seed: string;
  gender?: Gender;
  modelRef?: ModelRef;
  useModelLogo?: boolean;
  isTalking?: boolean;
  className?: string;
  alt?: string;
}

export function TalkingAvatarSmall(props: TalkingAvatarSmallProps) {
  const {
    seed,
    modelRef,
    useModelLogo = false,
    className = "w-8 h-8 rounded-full",
    alt = "Avatar",
  } = props;

  const url = useMemo(() => buildAvatarUrl({ seed }), [seed]);

  if (useModelLogo) {
    return <img src={getModelLogoUrl(modelRef)} alt={alt} className={className} />;
  }

  // 十七轮：静态
  return <img src={url} alt={alt} draggable={false} className={className} />;
}
