import type { HouseRules } from "@/types/game";

/** 默认值即当前标准规则：enabled=false 时整局行为与旧版完全一致 */
export const DEFAULT_HOUSE_RULES: HouseRules = {
  enabled: false,
  guardSaveOverlap: "death",
  witchSelfSave: "always",
  poisonedHunterShoots: false,
  winCondition: "city",
  sheriffVoteWeight: 1.5,
  idiotRevealedLosesVote: true,
  whiteWolfKingCanBoom: true,
};

/** 全局唯一的规则裁决入口：未开启或未提供时一律回退到标准规则 */
export function effectiveRules(r?: Partial<HouseRules> | null): HouseRules {
  if (!r || !r.enabled) return DEFAULT_HOUSE_RULES;
  return { ...DEFAULT_HOUSE_RULES, ...r };
}

export const HOUSE_RULES_STORAGE_KEY = "meowcha_house_rules";

export function loadHouseRules(): HouseRules {
  if (typeof window === "undefined") return DEFAULT_HOUSE_RULES;
  try {
    const raw = localStorage.getItem(HOUSE_RULES_STORAGE_KEY);
    if (!raw) return DEFAULT_HOUSE_RULES;
    const parsed = JSON.parse(raw) as Partial<HouseRules> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_HOUSE_RULES;
    return { ...DEFAULT_HOUSE_RULES, ...parsed };
  } catch {
    return DEFAULT_HOUSE_RULES;
  }
}

export function saveHouseRules(r: HouseRules): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(HOUSE_RULES_STORAGE_KEY, JSON.stringify(r));
  } catch {
    // 忽略存储异常（例如隐私模式）
  }
}
