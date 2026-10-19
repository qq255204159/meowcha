/**
 * 喵杀 · 萌猫花名册
 *
 * 职责：
 *   1) 定义 16 款萌猫的「品种 + 小名」表（小名必须与 public/avatars/cats/cat-NN.png 的实际品种一致）；
 *   2) 提供「按座位唯一分配」的花名册：同一局内 16 个座位各拿一只不同的猫，
 *      且每位玩家的头像 token 与其展示名（如「黑猫 小夜」）来自同一处分配 → 永远对得上；
 *   3) 提供 token ↔ 索引的互转（token 为纯数字字符串，便于 buildSimpleAvatarUrl 直接识别）。
 *
 * 说明：一局最多 12 人（< 16），故 (seat + offset) % 16 必然互不重复。
 */

/** 品种（顺序严格对应 cat-01.png ~ cat-16.png） */
export const CAT_BREEDS: readonly string[] = [
  "橘猫", // cat-01
  "奶牛猫", // cat-02
  "三花猫", // cat-03
  "黑猫", // cat-04
  "白猫", // cat-05
  "狸花猫", // cat-06
  "布偶猫", // cat-07
  "暹罗猫", // cat-08
  "英短蓝猫", // cat-09
  "玳瑁猫", // cat-10
  "银渐层", // cat-11
  "缅因猫", // cat-12
  "加菲猫", // cat-13
  "折耳猫", // cat-14
  "俄罗斯蓝猫", // cat-15
  "波斯猫", // cat-16
] as const;

/** 每个品种的可爱小名池（写入角色 displayName，如「黑猫 小夜」） */
export const CAT_NICKNAMES: readonly (readonly string[])[] = [
  ["小橘", "阿橘", "橘子酱"],
  ["大花", "哞哞", "黑豆"],
  ["三三", "阿彩", "花花"],
  ["小夜", "煤球", "玄米"],
  ["云朵", "小白", "团团"],
  ["阿狸", "狸狸", "虎虎"],
  ["布丁", "绵绵", "眸眸"],
  ["小暹", "面面", "挖煤"],
  ["蓝蓝", "灰灰", "噜噜"],
  ["点点", "花栗", "玳玳"],
  ["霜霜", "银宝", "素素"],
  ["大毛", "山山", "威威"],
  ["胖胖", "饼饼", "加加"],
  ["折折", "软软", "团子"],
  ["青青", "蓝宝", "阿绿"],
  ["波波", "丝丝", "贵贵"],
] as const;

export const CAT_COUNT = CAT_BREEDS.length;

/** 稳定的字符串哈希（与旧版保持一致，保证同一 seed 结果不乱跳） */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

/** 由索引生成头像 token（纯数字，如 0 → "1"） */
export function catToken(index: number): string {
  return String(index + 1);
}

/** 解析头像 token：纯数字或 cat-N 形式 → 索引；否则返回 null（交给哈希兜底） */
export function parseCatIndex(seed: string): number | null {
  const s = seed.trim();
  const m = /^cat-(\d{1,3})$/i.exec(s) ?? /^(\d{1,3})$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) return null;
  return (n - 1) % CAT_COUNT;
}

export interface CatMember {
  /** 0-based 索引，对应 cat-{index+1}.png */
  index: number;
  /** 头像 token（写入 player.avatarSeed） */
  token: string;
  breed: string;
  nick: string;
  /** 展示名，如「黑猫 小夜」 */
  displayName: string;
}

/**
 * 按座位生成一局的花名册：保证同局内各座位猫种互不重复。
 * offset 由本局玩家 id 推导 → 每局阵容不同，但局内固定不变。
 */
export function buildCatRoster(
  playerIds: readonly (string | undefined)[],
  count: number
): CatMember[] {
  const joined = playerIds
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .join("|");
  const offset = joined ? hashString(joined) % CAT_COUNT : 0;

  return Array.from({ length: count }, (_, seat) => {
    const index = (seat + offset) % CAT_COUNT;
    const pool = CAT_NICKNAMES[index];
    const salt = `${playerIds[seat] ?? seat}|${CAT_BREEDS[index]}`;
    const nick = pool[hashString(salt) % pool.length];
    return {
      index,
      token: catToken(index),
      breed: CAT_BREEDS[index],
      nick,
      displayName: `${CAT_BREEDS[index]} ${nick}`,
    };
  });
}

/** 由 token/品种索引取展示名（不含小名时用第一个小名） */
export function catDisplayNameForToken(token: string): string {
  const idx = parseCatIndex(token);
  if (idx === null) return token;
  return `${CAT_BREEDS[idx]} ${CAT_NICKNAMES[idx][0]}`;
}
