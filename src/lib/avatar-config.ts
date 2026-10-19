/**
 * 喵杀 · 萌猫头像配置
 *
 * 二创说明：
 *   原版使用 DiceBear Notionists 在线头像（远程 SVG，带发型/眼睛/嘴型变体）。
 *   喵杀版本改为「本地内置的 16 款不同品种萌猫插画」：
 *     · 全部离线、无任何外部请求；
 *     · seed 若为「花名册 token」（纯数字，如 "4"）→ 精确取对应猫，
 *       这样一局内由 buildCatRoster 唯一分配的座位必然头像互不重复；
 *     · 其它 seed（昵称/UUID）→ 稳定哈希兜底，同一玩家全局一致；
 *     · 说话动效：十七轮已按要求**整体移除**（单帧静态图做不出原生口型，见 TalkingAvatar 注释）。
 */

import type { ModelRef } from "@/types/game";
import type { Gender } from "./character-generator";
import { getModelLogoPath } from "./model-logo";
import { assetPath } from "./site-path";
import { CAT_BREEDS, CAT_COUNT, hashString, parseCatIndex } from "./cat-roster";

export { CAT_BREEDS, CAT_COUNT, CAT_NICKNAMES, buildCatRoster } from "./cat-roster";

/**
 * 根据 seed 稳定选取猫猫序号（0-based）：
 * 优先识别花名册 token（纯数字 / cat-N），否则按哈希兜底。
 */
export function getCatIndex(seed: string): number {
  const parsed = parseCatIndex(seed);
  return parsed !== null ? parsed : hashString(seed) % CAT_COUNT;
}

/**
 * 根据 seed 取本地萌猫头像路径（已带站点 basePath）
 */
export function getCatAvatarPath(seed: string): string {
  const index = getCatIndex(seed) + 1;
  return assetPath(`/avatars/cats/cat-${String(index).padStart(2, "0")}.png`);
}

/**
 * 该 seed 对应的「张嘴」帧路径（口型动画的第二帧，已带站点 basePath）。
 * 十九轮：每只猫都有一张同画风、仅嘴部张开的**对齐帧**——做法是把图像模型生成的「张嘴」
 * 版本，只在嘴部区域合成回原图（除嘴部外逐像素一致）→ 两帧交替播放时绝不会跳动。
 */
export function getCatAvatarOpenPath(seed: string): string {
  const index = getCatIndex(seed) + 1;
  return assetPath(`/avatars/cats/open/cat-${String(index).padStart(2, "0")}.png`);
}

/** 该 seed 对应的萌猫品种中文名（便于调试/展示） */
export function getCatBreed(seed: string): string {
  return CAT_BREEDS[getCatIndex(seed)];
}

// ============================================
// URL 构建（保持与上游一致的调用签名）
// ============================================

export interface AvatarUrlOptions {
  seed: string;
  gender?: Gender;
  eyes?: string;
  lips?: string;
  hair?: string;
  scale?: number;
  translateY?: number;
  backgroundColor?: string | "transparent";
}

/**
 * 构建头像 URL。
 * 喵杀版本忽略旧版 DiceBear 参数（发型/眼睛/嘴型等），统一返回本地萌猫插画。
 */
export function buildAvatarUrl(options: AvatarUrlOptions): string {
  return getCatAvatarPath(options.seed);
}

/**
 * 简化版 URL 构建 - 用于快速生成头像（兼容旧调用点）
 */
export function buildSimpleAvatarUrl(
  seed: string,
  _backgroundColorOrOptions?:
    | string
    | {
        backgroundColor?: string | "transparent";
        gender?: Gender;
        eyes?: string;
      }
): string {
  return getCatAvatarPath(seed);
}

export const getModelLogoUrl = (modelRef?: ModelRef): string => getModelLogoPath(modelRef);
