/**
 * 喵杀 · 品牌常量
 *
 * 二创说明：
 *   本版二创作者：见星阁主（https://github.com/qq255204159）。
 *   本项目是「狼人杀」玩法的深度二创版本，Fork 自上游开源项目
 *   oil-oil/wolfcha 与 onebai123/wolfcha-web（MIT License）。
 *   在原玩法之上做了整体二次创作：
 *     · 更名为「喵杀 / MEOWCHA」并重做全部品牌文案与视觉；
 *     · 玩家头像由在线 DiceBear 头像换成本地内置的 16 款不同品种萌猫插画；
 *     · 「关于」入口收拢进「设置」，其余界面细节同步调整。
 *
 * 说明：所有对外品牌字样集中在此文件中，日后改名只需改动这一处。
 */

export const BRAND = {
  /** 中文名 */
  name: "喵杀",
  /** 英文名（大写展示用） */
  nameEn: "MEOWCHA",
  /** 英文名（行文用） */
  nameEnHuman: "Meowcha",
  /** 英文副标题（首页契约卷轴） */
  tagline: "The Meow Game",
  /** 一句话简介（meta description） */
  description: "AI 驱动的复古童话风狼人杀 · 喵杀",
  /** 浏览器图标 */
  favicon: "/brand/meowcha-favicon.png",
  /** 主 Logo */
  logo: "/brand/meowcha-logo.png",
  /** 上游出处 */
  upstream: ["oil-oil/wolfcha", "onebai123/wolfcha-web"] as const,
  /** 本版二创作者 */
  author: "见星阁主",
  /** 作者主页（GitHub） */
  authorUrl: "https://github.com/qq255204159",
  /** 开源许可 */
  license: "MIT",
} as const;

/** 浏览器标签标题 */
export const APP_TITLE = `${BRAND.nameEnHuman} - ${BRAND.name}`;
