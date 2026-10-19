/**
 * 喵杀 · 站点子路径统一入口
 * ⚠️ 必须与 next.config.ts 的 basePath 一致（喵杀二创后默认 /meowcha），
 *    也须与 nginx location 前缀一致；一切指向 public/ 的 URL 都要经 assetPath 拼接。
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_APP_BASEPATH ?? "/meowcha";

export function assetPath(p: string): string {
  return BASE_PATH.replace(/\/+$/, "") + p;
}
