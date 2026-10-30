import type { DifficultyLevel, GameState, Player, DailySummaryVoteData } from "@/types/game";
import type { SystemPromptPart } from "@/game/core/types";
import type { LLMMessage } from "./llm";
import { getSystemMessages } from "./game-texts";
import { effectiveRules } from "./house-rules";
import { getI18n } from "@/i18n/translator";

/**
 * Prompt helper utilities used by Phase prompts.
 */

export const getRoleText = (role: string) => {
  const { t } = getI18n();
  switch (role) {
    case "Werewolf":
      return t("promptUtils.roleText.werewolf");
    case "WhiteWolfKing":
      return t("promptUtils.roleText.whiteWolfKing" as Parameters<typeof t>[0]);
    case "Seer":
      return t("promptUtils.roleText.seer");
    case "Witch":
      return t("promptUtils.roleText.witch");
    case "Hunter":
      return t("promptUtils.roleText.hunter");
    case "Guard":
      return t("promptUtils.roleText.guard");
    case "Idiot":
      return t("promptUtils.roleText.idiot" as Parameters<typeof t>[0]);
    default:
      return t("promptUtils.roleText.villager");
  }
};

export const getWinCondition = (role: string) => {
  const { t } = getI18n();
  switch (role) {
    case "Werewolf":
    case "WhiteWolfKing":
      return t("promptUtils.winCondition.werewolf");
    case "Seer":
      return t("promptUtils.winCondition.seer");
    case "Witch":
      return t("promptUtils.winCondition.witch");
    case "Hunter":
      return t("promptUtils.winCondition.hunter");
    case "Guard":
      return t("promptUtils.winCondition.guard");
    case "Idiot":
      return t("promptUtils.winCondition.villager");
    default:
      return t("promptUtils.winCondition.villager");
  }
};

/**
 * Role-specific strategy tips (know-how) to help AI make better decisions
 * These tips are tailored to each role to prevent homogenization
 */
export const getRoleKnowHow = (role: string): string => {
  const { t } = getI18n();
  const base = (() => {
    switch (role) {
      case "Werewolf":
        return t.raw("promptUtils.roleKnowHow.werewolf");
      // 喵杀（十八轮）：白狼王 / 白痴 原先都落到 default → 拿到的是「村民攻略」
      //（白狼王是狼阵营却按好人思路玩、白痴完全不知道「翻牌免死 + 失去投票权」）→ 已补各自专属攻略。
      case "WhiteWolfKing":
        return t.raw("promptUtils.roleKnowHow.whiteWolfKing");
      case "Seer":
        return t.raw("promptUtils.roleKnowHow.seer");
      case "Witch":
        return t.raw("promptUtils.roleKnowHow.witch");
      case "Hunter":
        return t.raw("promptUtils.roleKnowHow.hunter");
      case "Guard":
        return t.raw("promptUtils.roleKnowHow.guard");
      case "Idiot":
        return t.raw("promptUtils.roleKnowHow.idiot");
      default:
        return t.raw("promptUtils.roleKnowHow.villager");
    }
  })();
  // 喵杀（十八轮）：结构性问题 —— 狼人侧有一套厚实的战术库（悍跳判据/倒钩深水/分散票型/自检），
  // 好人侧只有各角色的零星提示 → 同难度下狼人被"训练"得更会打。给所有好人角色追加
  // 同一段「好人通用战术」（判断真假预言家 / 站边要站到底 / 别内讧 / 拿不定主意时先取证）。
  if (role === "Werewolf" || role === "WhiteWolfKing") return base;
  const shared = t.raw("promptUtils.roleKnowHow.goodTeamTactics");
  // 2026-10-18 站长要求：不把「报验必须起跳」做成硬规则，让 AI 自己权衡。
  return shared ? `${base}\n\n${shared}` : base;
};

/**
 * Build a light public-info angle based on current game state.
 */
export const buildFocusAngle = (state: GameState, player: Player): string => {
  return buildPerspectiveHint(state, player);
};

/**
 * Generate a unique "perspective hint" for a player based on public game information.
 * Each player gets a different analytical angle to think from, producing natural diversity
 * in AI speeches without prescriptive output formatting.
 */
function buildPerspectiveHint(state: GameState, player: Player): string {
  // Only generate perspective hints during day speech phases (not night actions)
  const isDaySpeech = state.phase.startsWith("DAY_");
  if (!isDaySpeech) return "";

  const hints: string[] = [];

  // --- 1. Mentioned by others: if other players named you, react to it ---
  const dayStartIndex = getDayStartIndex(state);
  const mentionedBy: number[] = [];
  const seatStr = `${player.seat + 1}号`;
  for (let i = dayStartIndex; i < state.messages.length; i++) {
    const m = state.messages[i];
    if (m.isSystem || m.playerId === player.playerId) continue;
    if (m.content.includes(seatStr)) {
      const speaker = state.players.find(p => p.playerId === m.playerId);
      if (speaker && speaker.alive) mentionedBy.push(speaker.seat);
    }
  }
  if (mentionedBy.length > 0) {
    const who = [...new Set(mentionedBy)].map(s => `${s + 1}号`).join("、");
    hints.push(`你被${who}点名提到了，可以考虑是否回应`);
  }

  // --- 2. Adjacent to a dead player: you have a spatial observation ---
  const deadToday = state.players.filter(p => !p.alive);
  const totalSeats = state.players.length;
  const isAdjacentToDead = deadToday.some(d => {
    const diff = Math.abs(d.seat - player.seat);
    return diff === 1 || diff === totalSeats - 1;
  });
  if (isAdjacentToDead && deadToday.length > 0) {
    hints.push("你和出局的玩家座位相邻，可以从这个角度聊一句");
  }

  // --- 3. Sheriff-related: different angles depending on badge status ---
  const sheriffSeat = state.badge.holderSeat;
  if (sheriffSeat !== null && sheriffSeat === player.seat) {
    hints.push("你是警长，你的发言会影响别人，可以自然给出你的方向");
  } else if (sheriffSeat !== null) {
    if (player.seat % 2 === 0) {
      hints.push("可以回应一下警长的方向，说明你是否认同");
    } else {
      hints.push("如果你不认同警长，可以自然提出疑问");
    }
  }

  // --- 4. Voting pattern awareness (day 2+): who voted together yesterday? ---
  if (state.day >= 2 && state.voteHistory) {
    const yesterdayVotes = state.voteHistory[state.day - 1];
    if (yesterdayVotes) {
      const myVote = yesterdayVotes[player.playerId];
      if (myVote !== undefined) {
        const sameVoters = Object.entries(yesterdayVotes)
          .filter(([id, target]) => target === myVote && id !== player.playerId)
          .map(([id]) => state.players.find(p => p.playerId === id))
          .filter((p): p is Player => !!p && p.alive);
        if (sameVoters.length > 0) {
          const names = sameVoters.slice(0, 2).map(p => `${p.seat + 1}号`).join("、");
          hints.push(`昨天${names}和你投了同一个目标，可以想想这件事要不要提`);
        }
      }
    }
  }

  // --- 5. First speaker vs late speaker: different information burden ---
  const todaySpeakers = new Set<string>();
  for (let i = dayStartIndex; i < state.messages.length; i++) {
    const m = state.messages[i];
    if (!m.isSystem && m.playerId && m.playerId !== player.playerId) {
      todaySpeakers.add(m.playerId);
    }
  }
  const aliveCount = state.players.filter(p => p.alive).length;
  const spokenRatio = todaySpeakers.size / Math.max(1, aliveCount - 1);

  if (spokenRatio === 0) {
    hints.push("你是第一个发言，没有人可以参考，可以先抛出一个起手判断");
  } else if (spokenRatio >= 0.7) {
    hints.push("你已经听了大部分人的发言，可以挑你最在意的一点回应");
  }

  if (hints.length === 0) return "";

  // Pick at most 2 hints to keep it focused (use seat + day as deterministic selector)
  const selected = hints.length <= 2 ? hints : [
    hints[(player.seat + state.day) % hints.length],
    hints[(player.seat + state.day + 1) % hints.length],
  ].filter((v, i, a) => a.indexOf(v) === i);

  return `<focus_angle>\n【你的视角】\n${selected.map(h => `- ${h}`).join("\n")}\n</focus_angle>`;
}

/**
 * Build situational strategy based on current game state.
 * Provides context-aware tactical suggestions without being overly restrictive.
 */
/**
 * 喵杀（十五轮）：判断今天是否**已经有别人**声称自己是预言家（大概率是狼悍跳）。
 * 真预言家在这时必须对跳，否则狼抢走话语权（站长反馈：好人跳得太多、狼胜率偏高）。
 * 粗略文本匹配即可 —— 命中「我是预言家 / 我跳预言家 / 我才是预言家…」这类第一人称声明。
 */
function seerClaimFromOthers(state: GameState, player: Player): boolean {
  const start = getDayStartIndex(state);
  for (let i = start; i < state.messages.length; i++) {
    const m = state.messages[i];
    if (m.isSystem || !m.playerId || m.playerId === player.playerId) continue;
    const speaker = state.players.find((p) => p.playerId === m.playerId);
    if (!speaker?.alive) continue;
    const c = m.content || "";
    if (/我是预言家|我跳预言家|我才是预言家|我报预言家|我就是预言家|预言家，?我是/.test(c)) return true;
    if (/I am the Seer|I'm the Seer|I claim Seer|I am the seer/i.test(c)) return true;
  }
  return false;
}

export const buildSituationalStrategy = (state: GameState, player: Player): string => {
  const lines: string[] = [];
  const isBadgeSpeech = state.phase === "DAY_BADGE_SPEECH";
  
  if (player.role === "Seer") {
    const checks = state.nightActions.seerHistory || [];
    if (checks.length === 0) {
      return "";
    }
    // 是否已有人（大概率是狼）声称预言家 → 真预言家必须对跳
    const rivalClaim = seerClaimFromOthers(state, player);
    
    const hasWolfCheck = checks.some(c => c.isWolf);
    const hasGoodCheck = checks.some(c => !c.isWolf);
    const latestCheck = checks[checks.length - 1];
    const latestTarget = state.players.find(p => p.seat === latestCheck.targetSeat);
    
    lines.push("<situational_tips>");
    if (isBadgeSpeech) {
      // 喵杀（十五轮）：**不再「强制跳身份」** —— 站长反馈开局跳预言家的太多、不真实；
      // 一夜查验的信息量往往很小，硬跳会被狼对跳搅局、当夜被刀。改为按条件权衡：
      // ① 有人悍跳 → 必须对跳自证；② 手上有查杀 → 建议跳（信息够硬）；
      // ③ 只有金水/没验到 → 建议先不跳，保留信息，等更有价值的时机。
      if (rivalClaim) {
        lines.push("【竞选策略 - 必须对跳】场上已经有玩家声称自己是预言家（大概率是狼在悍跳）。");
        lines.push("- 你是真预言家，这种情况**必须**跳身份对跳，否则狼人抢走话语权、好人会被带偏");
        lines.push("- 声明\"我是预言家\"，并说明为什么你才是真的（对方是悍跳狼）");
        if (hasWolfCheck) {
          lines.push(`- 报出查验结果：你查了${latestCheck.targetSeat + 1}号${latestTarget?.displayName || ""}，是狼人`);
        } else if (hasGoodCheck) {
          lines.push(`- 报出金水：${latestCheck.targetSeat + 1}号${latestTarget?.displayName || ""}是好人`);
        }
        lines.push("- 明确给出今日归票方向（有查杀就优先归查杀目标）");
      } else if (hasWolfCheck) {
        lines.push("【竞选策略 - 应当跳身份报查杀】你手上有查杀，这是全场最硬的信息，吞掉等于放走一只狼。");
        lines.push("- 应当跳身份：声明\"我是预言家\"，并报出查杀");
        lines.push(`- 报出查验结果：你查了${latestCheck.targetSeat + 1}号${latestTarget?.displayName || ""}，是狼人`);
        lines.push(`- 明确要求今天归票${latestCheck.targetSeat + 1}号，并强调\"好人的票集中到这一票\"`);
        lines.push("- 记住代价：起跳后你大概率会被狼刀，所以今天务必把归票目标讲清楚，别浪费这条信息");
      } else {
        lines.push("【竞选策略 - 是否跳身份要自己权衡（不强制）】");
        lines.push("- 你现在只有金水（或还没验到东西），首夜信息量很小：**这时直接跳身份收益低、风险高**（狼会对跳搅局、你当夜就可能被刀）");
        lines.push("- 建议：**先不跳**，像普通好人一样发言 —— 给出你对可疑座位的判断与今日归票方向，把身份信息留到更有价值的时候（拿到查杀 / 有人悍跳 / 局势僵住）");
        lines.push("- 但如果场上无人跳预言家、好人票型混乱或警长带票明显可疑，**应该跳出来报金水**，给好人一个可信锚点；记住金水只证明被验者是好人，不要把个人怀疑包装成查杀");
        lines.push("- 当然，如果你判断现在跳出来就能立刻带队、且已想好今天归票谁，跳也可以，但要说明理由");
      }
    } else if (rivalClaim) {
      lines.push("【当前情境】场上已经有人声称自己是预言家，而你是真预言家。");
      lines.push("【必须做】立刻跳身份对跳：声明\"我是预言家\"，报出你的查验结果，并指出对方大概率是悍跳狼。");
      lines.push("- 这是好人最需要你站出来的时候；沉默等于把话语权让给狼");
      if (hasWolfCheck) {
        lines.push(`- 报出查验结果：你查了${latestCheck.targetSeat + 1}号${latestTarget?.displayName || ""}，是狼人`);
      } else if (hasGoodCheck) {
        lines.push(`- 报出金水：${latestCheck.targetSeat + 1}号${latestTarget?.displayName || ""}是好人`);
      }
    } else if (hasWolfCheck && state.day === 1) {
      lines.push("【当前情境】你首验查杀！这是全场最硬的信息，不要吞掉。");
      lines.push("【必须做】");
      lines.push("- 跳身份带节奏：声明\"我是预言家\"，报出查杀的座位号");
      lines.push("- 明确给出今日归票建议，并要求\"好人的票集中到这一票\"（散票等于放走这只被查杀的狼）");
      lines.push("- 准备好应对可能的狼人对跳：让对跳者先报验人顺序，谁的逻辑自洽信谁");
    } else if (hasGoodCheck && !hasWolfCheck) {
      lines.push("【当前情境】你目前只有金水（好人验），信息量有限。");
      lines.push("【可选策略（建议优先潜水）】");
      lines.push("- 首选：**潜水观察** —— 过早跳身份容易被狼对跳搅局、当夜被刀；等拿到查杀 / 有人悍跳 / 局势僵住再跳");
      lines.push("- 但如果场上无人跳预言家、好人票型混乱或警长带票明显可疑，可以跳出来报金水，给好人一个可信锚点；金水不等于查杀");
      lines.push("- 若你判断需要你带队，也可以跳身份报金水，但要说明理由并给出今日归票方向");
      lines.push("- 时刻留意是否有人对跳预言家（有则必须立刻对跳自证）");
    } else if (hasWolfCheck && state.day > 1) {
      lines.push("【当前情境】你有查杀记录。");
      lines.push("【必须做】");
      lines.push("- 持续推动查杀目标出局：明确喊归票该目标，并要求好人的票集中到他身上");
      lines.push("- 结合新的查验结果分析局势（若又验到狼，一并向全场报出）");
    }
    lines.push("</situational_tips>");
  }
  
  // 喵杀修复：白狼王也属于狼营（本文件未引入 isWolfRole，沿用文件内既有写法）
  if (player.role === "Werewolf" || player.role === "WhiteWolfKing") {
    const aliveWolves = state.players.filter(p => p.role === "Werewolf" || p.role === "WhiteWolfKing").filter(p => p.alive);
    const isLastWolf = aliveWolves.length === 1;
    
    lines.push("<situational_tips>");
    if (isBadgeSpeech) {
      // 警长竞选时，狼人要主动发假风向
      lines.push("【竞选策略 - 狼人悍跳/做风向】");
      lines.push("- 你必须像真正的好人一样给出明确方向");
      lines.push("- 可选策略1（悍跳预言家）：声称自己是预言家，编造一个假查验结果，点名一个好人说\"查杀\"");
      lines.push("- 可选策略2（稳健风向）：不跳身份，但要点名一个好人说他可疑，给出看似合理的理由");
      lines.push("- 无论哪种，必须点名一个具体座位号并给出分析");
      lines.push("- 目标：把水搅浑，引导好人互相怀疑");
      // 提示不要指向狼队友
      if (aliveWolves.length > 1) {
        const teammates = aliveWolves.filter(p => p.playerId !== player.playerId);
        const tmSeats = teammates.map(p => p.seat + 1).join("、");
        lines.push(`- 注意：${tmSeats}号是你的狼队友，不要把风向指向他们`);
      }
    } else if (isLastWolf) {
      lines.push("【当前情境】你是最后一只狼！");
      lines.push("【可选策略】");
      lines.push("- 低调发言，避免被集火");
      lines.push("- 引导好人内斗");
      lines.push("- 寻找机会翻盘");
    } else if (state.day === 1) {
      lines.push("【当前情境】首日发言，建立信任很关键。");
      lines.push("【可选策略】");
      lines.push("- 像好人一样分析局势");
      lines.push("- 不要过早站边或暴露狼视角");
      lines.push("- 可以适当质疑可疑发言");
    }
    lines.push("</situational_tips>");
  }
  
  if (player.role === "Witch") {
    const hasHeal = !state.roleAbilities.witchHealUsed;
    const hasPoison = !state.roleAbilities.witchPoisonUsed;
    
    if (!hasHeal && !hasPoison && !isBadgeSpeech) {
      return "";
    }
    
    lines.push("<situational_tips>");
    if (isBadgeSpeech) {
      lines.push("【竞选策略 - 女巫发风向】");
      lines.push("- 你知道昨晚谁被刀了，这是独有信息");
      lines.push("- 可以选择报出刀口位置（\"昨晚X号被刀\"），也可以先保留");
      lines.push("- 必须给出一个可疑目标或关注方向，点名具体座位号");
      lines.push("- 可以从\"刀口选择\"角度分析：为什么狼人要刀那个位置？");
    } else {
      lines.push("【当前情境】你是女巫。");
      if (hasHeal && hasPoison) {
        lines.push("- 解药和毒药都还在，谨慎使用");
      } else if (hasHeal) {
        lines.push("- 解药还在，留给关键好人");
      } else if (hasPoison) {
        lines.push("- 毒药还在，留给确认的狼人");
      }
      lines.push("- 你知道谁被刀了，这是重要信息");
    }
    lines.push("</situational_tips>");
  }

  if (player.role === "Guard" && isBadgeSpeech) {
    lines.push("<situational_tips>");
    lines.push("【竞选策略 - 守卫发风向】");
    lines.push("- 你知道自己昨晚守了谁，可以从守护角度分析局势");
    lines.push("- 必须给出一个可疑方向：谁的发言有问题？谁可能是狼？");
    lines.push("- 可以从座位分布、发言顺序等角度给一个初步判断");
    lines.push("</situational_tips>");
  }

  if (player.role === "Hunter" && isBadgeSpeech) {
    lines.push("<situational_tips>");
    lines.push("【竞选策略 - 猎人发风向】");
    lines.push("- 你有开枪权，这是上警的理由之一（死后可以带走一个狼）");
    lines.push("- 必须给出一个可疑方向，点名具体座位号");
    lines.push("- 可以暗示\"如果确认某人是狼，我有手段处理\"");
    lines.push("</situational_tips>");
  }

  if (player.role === "Villager" && isBadgeSpeech) {
    lines.push("<situational_tips>");
    lines.push("【竞选策略 - 平民发风向】");
    lines.push("- 作为平民上警，要靠逻辑分析赢得信任");
    lines.push("- 必须给出一个明确的可疑方向，说出你怀疑谁、为什么");
    lines.push("- 可以从其他候选人的发言中找破绽");
    lines.push("- 展示你的分析能力，证明你适合带队");
    lines.push("</situational_tips>");
  }

  if (player.role === "Idiot" && isBadgeSpeech) {
    lines.push("<situational_tips>");
    lines.push("【竞选策略 - 白痴发风向】");
    lines.push("- 你可以大胆发言，因为即使被投出也不会真正出局");
    lines.push("- 必须给出明确方向，点名可疑玩家");
    lines.push("- 可以积极站边或质疑其他候选人");
    lines.push("</situational_tips>");
  }
  
  return lines.join("\n");
};

/**
 * Build difficulty hint for speech generation.
 * Now always uses "hard" level strategy for better AI performance.
 * The difficulty parameter is kept for backward compatibility but ignored.
 */
export const buildDifficultySpeechHint = (_difficulty?: DifficultyLevel): string => {
  const { t } = getI18n();
  // Always use hard difficulty for better strategic depth
  return t("promptUtils.difficultySpeech.hard");
};

/**
 * Build difficulty hint for decision making.
 * Now always uses "hard" level strategy for better AI performance.
 * The difficulty parameter is kept for backward compatibility but ignored.
 */
export const buildDifficultyDecisionHint = (_difficulty?: DifficultyLevel, role?: string): string => {
  const { t } = getI18n();
  const roleNote =
    role === "Werewolf" || role === "WhiteWolfKing"
      ? t("promptUtils.difficultyDecision.roleNoteWerewolf")
      : t("promptUtils.difficultyDecision.roleNoteGood");

  // Always use hard difficulty for better strategic depth
  return t("promptUtils.difficultyDecision.hard", { roleNote });
};

export const buildPersonaSection = (player: Player, isGenshinMode: boolean = false): string => {
  if (isGenshinMode || !player.agentProfile) return "";
  const { t } = getI18n();
  const { persona } = player.agentProfile;
  const separator = t("promptUtils.gameContext.listSeparator");

  const base = t("promptUtils.persona.section", {
    voiceRules: persona.voiceRules.join(separator),
    riskLabel: t("promptUtils.persona.riskBalanced")
  });
  const extraInfo = persona.basicInfo?.trim()
    ? `\n${t("promptUtils.persona.basicInfo", { basicInfo: persona.basicInfo.trim() })}`
    : "";
  return `${base}${extraInfo}`;
};

export const buildAliveCountsSection = (state: GameState): string => {
  const { t } = getI18n();
  const alive = state.players.filter((p) => p.alive);

  return t("promptUtils.aliveCounts", { count: alive.length });
};

/**
 * 喵杀（十四轮）：本局生效规则说明。取自 effectiveRules(state.houseRules)，
 * 因此**自定义规则下自动改成对应的描述**（站长要求：AI 必须知道规则，除非自定义改了）。
 * 这段被塞进 <rules>，所有阶段（报名/竞选/发言/投票/夜间行动）共用同一份上下文，人人可见。
 * 说明：本文件既有大量硬编码中文（buildSituationalStrategy / buildPerspectiveHint 等），此处保持一致。
 */
export const buildHouseRulesNote = (state: GameState): string => {
  const r = effectiveRules(state.houseRules);
  // 喵杀（2026-10-17）：只输出「本局实际存在的角色」相关规则 ——
  // 站长反馈：本局没有守卫时，AI 仍被塞了「同守同救」规则，于是去推理「守卫为什么没守」。
  const rolesInPlay = new Set(state.players.map((p) => p.role));
  const hasGuard = rolesInPlay.has("Guard");
  const hasWitch = rolesInPlay.has("Witch");
  const hasHunter = rolesInPlay.has("Hunter");
  const hasIdiot = rolesInPlay.has("Idiot");
  const hasWWK = rolesInPlay.has("WhiteWolfKing");

  const guardOverlap =
    r.guardSaveOverlap === "death"
      ? "守卫守护与女巫解药同时作用于同一人 → 该目标必定死亡（即「同守同救必死 / 毒奶」）。因此看到「有人被双保险救却死了」时，这是规则使然，不是守卫或女巫失误。"
      : "同守同救不会致死，该目标可以被正常救活。";
  const witchSelfSave =
    r.witchSelfSave === "always"
      ? "任何夜晚都可以自救"
      : r.witchSelfSave === "firstNightOnly"
        ? "仅第一夜可以自救，之后不能自救"
        : "任何夜晚都不能自救";
  const winText =
    r.winCondition === "city"
      ? "屠城：必须杀光全部好人才能获胜"
      : "屠边：杀光全部平民或全部神职即获胜";

  const lines: string[] = [
    "【本局生效规则（务必遵守；规则本身是既定前提，不要质疑、不要抱怨规则）】",
  ];
  // 仅当对应角色确实存在时才列出对应规则（避免「没有守卫却讨论同守同救」这类困惑）
  if (hasGuard && hasWitch) lines.push(`- 守护/解药：${guardOverlap}`);
  if (hasGuard) {
    lines.push(
      "- 守卫连守限制：守卫不能连续两晚守护同一人（例如昨晚守7号，今晚就不能再守7号；可以守自己）。" +
        "这是规则本身，不要质疑为什么不能连续守同一个人，也不要要求守卫做连守。"
    );
    lines.push(
      "- 守卫目标私密：守卫实际守了谁，只有守卫自己知道；非守卫玩家不要假装知道，也不要据此断言「昨晚一定守了谁」。"
    );
  }
  if (hasWitch) lines.push(`- 女巫自救：${witchSelfSave}`);
  if (hasHunter && hasWitch) lines.push(`- 被毒死的猎人：${r.poisonedHunterShoots ? "仍然可以开枪" : "不能开枪"}`);
  lines.push(`- 胜负条件：${winText}`);
  lines.push(`- 警长票权：${r.sheriffVoteWeight === 1 ? "1 票（与普通玩家相同）" : `${r.sheriffVoteWeight} 票`}`);
  if (hasIdiot) lines.push(`- 白痴翻牌后：${r.idiotRevealedLosesVote ? "不会被放逐，但失去投票权" : "不会被放逐，且保留投票权"}`);
  if (hasWWK) lines.push(`- 白狼王：${r.whiteWolfKingCanBoom ? "白天可以自爆并带走一名玩家" : "本局没有自爆能力"}`);
  return lines.join("\n");
};

/**
 * 喵杀（十四轮）：投票阶段的「实时票型」提示。AI 是**逐个投票**的，
 * 之前每个 AI 都只看发言记录、各投各的 → 票型散开、狼人笑到最后（站长反馈：
 * 明明多人表态要投被查杀的 7 号，最后却散了、票死了别人）。现在把「已经投出的票」
 * 实时喂给尚未投票的 AI，并明确要求「认同就集中投领先目标」。
 */
export const buildVoteTallyNote = (state: GameState): string => {
  const pkTargets =
    state.pkSource === "vote" && Array.isArray(state.pkTargets) && state.pkTargets.length > 0
      ? new Set(state.pkTargets)
      : null;
  const eligible = state.players.filter((p) => p.alive && (!pkTargets || pkTargets.has(p.seat)));
  const voted = eligible.filter((p) => typeof state.votes[p.playerId] === "number");
  const pending = eligible.filter((p) => typeof state.votes[p.playerId] !== "number");
  if (voted.length === 0) return "";

  const counts = new Map<number, number>();
  for (const p of voted) {
    const seat = state.votes[p.playerId];
    counts.set(seat, (counts.get(seat) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const tally = sorted.map(([seat, n]) => `${seat + 1}号×${n}`).join("、");

  const lines: string[] = [];
  lines.push(`【实时票型（已投 ${voted.length} 人，还有 ${pending.length} 人未投，投票是公开可见的）】${tally}`);
  const lead = sorted[0];
  if (lead) {
    const leadName = state.players.find((p) => p.seat === lead[0])?.displayName ?? "";
    lines.push(
      `目前领先：${lead[0] + 1}号${leadName ? ` ${leadName}` : ""}（${lead[1]} 票）。**如果你认同这个方向，就投他——把票集中才能把人票出去；投一个「只有你自己投」的目标等于帮狼人。**`
    );
    lines.push("除非你有更强的新依据坚决反对这个目标（请在理由里写明），否则请与多数人保持一致。");
  }
  return lines.join("\n");
};

/** Format structured vote_data into readable text for <history>. Seat numbers in vote_data are 0-based. */
function formatVoteDataForHistory(v: DailySummaryVoteData): string {
  const { t } = getI18n();
  const separator = t("promptUtils.gameContext.listSeparator");
  const parts: string[] = [];
  const fmt = (votes: Record<string, number[]>) =>
    Object.entries(votes)
      .map(([target, arr]) => {
        const voters = (arr as number[]).map((s) => t("promptUtils.gameContext.seatLabel", { seat: s + 1 })).join(separator);
        const targetNum = Number.parseInt(target, 10);
        return t("promptUtils.gameContext.votersVotedFor", { voters, target: Number.isFinite(targetNum) ? targetNum + 1 : target });
      })
      .filter(Boolean)
      .join(t("promptUtils.gameContext.semicolon"));
  if (v.sheriff_election) {
    const { winner, votes } = v.sheriff_election;
    const base = t("promptUtils.gameContext.sheriffVote", { seat: winner + 1 });
    const detail = fmt(votes);
    parts.push(detail ? `${base}${t("promptUtils.gameContext.semicolon")}${detail}` : base);
  }
  if (v.execution_vote) {
    const { eliminated, votes } = v.execution_vote;
    const base = t("promptUtils.gameContext.executionVote", { seat: eliminated + 1 });
    const detail = fmt(votes);
    parts.push(detail ? `${base}${t("promptUtils.gameContext.semicolon")}${detail}` : base);
  }
  return parts.join(" ");
}

export const buildDailySummariesSection = (state: GameState): string => {
  const { t } = getI18n();
  // Get summaries from dailySummaries (new format: single paragraph text)
  const entries = Object.entries(state.dailySummaries || {})
    .map(([day, bullets]) => ({ day: Number(day), bullets }))
    .filter((x) => Number.isFinite(x.day) && Array.isArray(x.bullets));

  if (entries.length === 0) return "";

  const lines: string[] = [];
  const separator = t("promptUtils.gameContext.semicolon");
  for (const { day, bullets } of entries.sort((a, b) => a.day - b.day)) {
    const summaryTexts = bullets
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);

    if (summaryTexts.length === 0) continue;

    const fullSummary = summaryTexts.join(separator);
    
    // Append structured vote_data so "who voted for whom" is never lost
    const voteData = state.dailySummaryVoteData?.[day];
    const voteText = voteData ? formatVoteDataForHistory(voteData) : "";
    const dayLabel = t("promptUtils.gameContext.dayLabel", { day });
    const line = voteText ? `${dayLabel}${fullSummary} ${voteText}` : `${dayLabel}${fullSummary}`;
    lines.push(line);
  }

  if (lines.length === 0) return "";
  return `<history>\n${lines.join("\n\n")}\n</history>`;
};

export const getDayStartIndex = (state: GameState): number => {
  const systemMessages = getSystemMessages();
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    // Match both Chinese and English versions
    if (m.isSystem && (m.content === "天亮了" || m.content === "Dawn breaks, please open your eyes" || m.content === systemMessages.dayBreak)) return i;
  }
  return 0;
};

export const getVoteStartIndex = (state: GameState): number => {
  const systemMessages = getSystemMessages();
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    // Match both Chinese and English versions
    if (m.isSystem && (m.content === "进入投票环节" || m.content === "发言结束，开始投票。" || m.content === "Discussion ends, voting begins." || m.content === systemMessages.voteStart)) return i;
  }
  return state.messages.length;
};

/**
 * Check if today's transcript is long enough to warrant a mid-day summary
 * Returns the transcript length and whether summary is needed
 */
export const checkNeedsMidDaySummary = (state: GameState, threshold: number = 6000): {
  transcriptLength: number;
  needsSummary: boolean;
  hasSummary: boolean;
} => {
  const dayStartIndex = getDayStartIndex(state);
  const voteStartIndex = getVoteStartIndex(state);

  const slice = state.messages.slice(
    dayStartIndex,
    voteStartIndex > dayStartIndex ? voteStartIndex : state.messages.length
  );

  const transcript = slice
    .filter((m) => !m.isSystem)
    .map((m) => m.content)
    .join("\n");

  const hasSummary = !!(
    (state.dailySummaryFacts?.[state.day]?.length ?? 0) > 0 ||
    (state.dailySummaries?.[state.day]?.length ?? 0) > 0
  );

  return {
    transcriptLength: transcript.length,
    needsSummary: transcript.length > threshold && !hasSummary,
    hasSummary,
  };
};

export const buildTodayTranscript = (
  state: GameState,
  maxChars: number,
  options?: { includeDeadSpeech?: boolean }
): string => {
  const { t } = getI18n();
  const dayStartIndex = getDayStartIndex(state);
  const voteStartIndex = getVoteStartIndex(state);

  const slice = state.messages.slice(
    dayStartIndex,
    voteStartIndex > dayStartIndex ? voteStartIndex : state.messages.length
  );

  // Build a map of playerId -> alive status for quick lookup
  const playerAliveMap = new Map<string, boolean>();
  state.players.forEach((p) => {
    playerAliveMap.set(p.playerId, p.alive);
  });
  const includeDeadSpeech = options?.includeDeadSpeech === true;

  // Separate last words from regular speech for priority handling
  const regularMessages = slice.filter((m) => {
    if (m.isSystem || m.isLastWords) return false;
    const isAlive = playerAliveMap.get(m.playerId) ?? true;
    return includeDeadSpeech || isAlive;
  });
  const lastWordsMessages = slice.filter((m) => {
    // 遗言是公开信息，必须始终给 AI 看；死者说的是最后一段有效信息。
    // 之前这里用 isAlive 过滤，导致所有遗言都被排除（遗言本来就是死者说的）。
    return !m.isSystem && m.isLastWords === true;
  });

  const formatMessage = (m: typeof slice[0]) => {
    const player = state.players.find((p) => p.playerId === m.playerId);
    // Only use seat number for prompt, no player name (to anonymize for model)
    const speaker = player ? t("mentions.seatLabel", { seat: player.seat + 1 }) : m.playerName;
    const isAlive = playerAliveMap.get(m.playerId) ?? true;
    const statusLabel = isAlive ? "" : t("promptUtils.gameContext.eliminated");
    const lastWordsLabel = m.isLastWords ? t("promptUtils.gameContext.lastWordsLabel") : "";
    return `${lastWordsLabel}${speaker}${statusLabel}: ${m.content}`;
  };

  // Last words are always preserved (they're important)
  const lastWordsText = lastWordsMessages.map(formatMessage).join("\n");
  const regularText = regularMessages.map(formatMessage).join("\n");
  
  const transcript = [lastWordsText, regularText].filter(Boolean).join("\n");

  if (!transcript) return "";
  if (transcript.length <= maxChars) return transcript;

  const summaryFacts = state.dailySummaryFacts?.[state.day];
  const summaryBullets = state.dailySummaries?.[state.day];
  const summaryItems =
    summaryFacts && summaryFacts.length > 0
      ? summaryFacts.map((f) => f.fact).filter(Boolean)
      : summaryBullets || [];
  
  if (summaryItems.length > 0) {
    const separator = t("promptUtils.gameContext.semicolon");
    const maxSummaryChars = Math.min(1200, Math.max(300, Math.floor(maxChars * 0.4)));
    let summaryText = "";
    for (const item of summaryItems) {
      const clean = String(item).trim();
      if (!clean) continue;
      const candidate = summaryText ? `${summaryText}${separator}${clean}` : clean;
      if (candidate.length > maxSummaryChars) break;
      summaryText = candidate;
    }
    const header = `<early_summary>${summaryText}</early_summary>\n<recent_speech>\n`;
    const footer = `\n</recent_speech>`;
    
    // Reserve space for last words (always include)
    const lastWordsReserve = lastWordsText ? lastWordsText.length + 50 : 0;
    const availableForRecent = maxChars - header.length - footer.length - lastWordsReserve;
    
    // Get recent regular messages
    const recentRegular = availableForRecent > 0 ? regularText.slice(-availableForRecent) : "";
    
    // Combine: summary + last words + recent regular
    const lastWordsPart = lastWordsText ? `<last_words>\n${lastWordsText}\n</last_words>\n` : "";
    return `${header}${lastWordsPart}${recentRegular}${footer}`.trim();
  }

  // No summary: prioritize last words, then use sliding window for regular
  if (lastWordsText) {
    const lastWordsPart = `<last_words>\n${lastWordsText}\n</last_words>\n`;
    const availableForRecent = maxChars - lastWordsPart.length;
    const recentRegular = availableForRecent > 0 ? regularText.slice(-availableForRecent) : "";
    return `${lastWordsPart}<recent_speech>\n${recentRegular}\n</recent_speech>`.trim();
  }

  // No last words, just sliding window
  return `<today_speech>\n${transcript.slice(-maxChars)}\n</today_speech>`;
};

export const buildPlayerTodaySpeech = (state: GameState, player: Player, maxChars: number): string => {
  const dayStartIndex = getDayStartIndex(state);
  const voteStartIndex = getVoteStartIndex(state);

  const slice = state.messages.slice(
    dayStartIndex,
    voteStartIndex > dayStartIndex ? voteStartIndex : state.messages.length
  );

  const speech = slice
    .filter((m) => !m.isSystem && m.playerId === player.playerId)
    .map((m) => m.content)
    .join("\n");

  if (!speech) return "";
  // 喵杀修复（2026-10-30 · 站长实测「大家都说投4号、结果全投1号」）：
  // 原实现只取开头 maxChars 字，而 AI 的「今天票压 X号」几乎都写在发言末尾。
  // 发言一长（12 人局常见 2000+ 字），最关键的归票承诺就被截掉了 →
  // 投票时模型看不到自己的结论，容易被实时票型带偏。
  // 现改为「开头一小段 + 结尾主体」，保证最后的表态一定在上下文里。
  if (speech.length <= maxChars) return speech;
  const headChars = Math.min(400, Math.floor(maxChars * 0.25));
  const tailChars = Math.max(0, maxChars - headChars - 2);
  return `${speech.slice(0, headChars)}\n…\n${speech.slice(-tailChars)}`;
};

/**
 * 夜间私密决策上下文。
 *
 * 夜间行动同样需要对白天公开过的判断负责：狼人刀谁、女巫救不救/毒谁、
 * 守卫守谁、预言家验谁，都应该结合「整体局势 + 当天公开讨论 + 本人发言」，
 * 而不是进入夜晚后换一套逻辑。这里只拼接公开信息，不泄露其他角色私有信息。
 */
export const buildNightDecisionContext = (
  state: GameState,
  player: Player,
  options?: { transcriptChars?: number; selfSpeechChars?: number }
): string => {
  const { t } = getI18n();
  const transcript = buildTodayTranscript(state, options?.transcriptChars ?? 3200);
  const selfSpeech = buildPlayerTodaySpeech(state, player, options?.selfSpeechChars ?? 1200);
  // buildTodayTranscript 只截到「投票开始」之前；而放逐后的遗言往往包含最关键的信息
  //（例如被放逐的预言家报验）。夜间决策必须能看到当天遗言。
  const lastWords = state.messages
    .filter((m) => m.day === state.day && m.isLastWords === true && !m.isSystem)
    .map((m) => {
      const speaker = state.players.find((p) => p.playerId === m.playerId);
      const speakerLabel = speaker ? `${speaker.seat + 1}号` : m.playerName;
      return `${speakerLabel}${t("promptUtils.gameContext.lastWordsLabel")}: ${m.content}`;
    })
    .join("\n");
  const transcriptWithLastWords = [
    transcript,
    lastWords
      ? `${t("promptUtils.nightDecision.lastWordsHeader")}\n${lastWords.slice(-1200)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const sections = [
    t("promptUtils.nightDecision.consistency"),
    `${t("promptUtils.nightDecision.transcriptHeader")}\n${transcriptWithLastWords || t("promptUtils.nightDecision.transcriptEmpty")}`,
    `${t("promptUtils.nightDecision.selfHeader")}\n${
      selfSpeech ? `"${selfSpeech}"` : t("promptUtils.nightDecision.selfEmpty")
    }`,
  ];

  return `<night_decision_context>\n${sections.join("\n\n")}\n</night_decision_context>`;
};

export const buildSystemAnnouncementsSinceDawn = (state: GameState, maxLines: number): string => {
  const dayStartIndex = getDayStartIndex(state);
  const systemMessages = getSystemMessages();
  const excluded = [
    "天亮了",
    "Dawn breaks, please open your eyes",
    systemMessages.dayBreak,
    "进入投票环节",
    "发言结束，开始投票。",
    "Discussion ends, voting begins.",
    systemMessages.voteStart,
  ];

  const slice = state.messages.slice(dayStartIndex);
  const systemLines = slice
    .filter((m) => m.isSystem)
    .map((m) => String(m.content || "").trim())
    .filter((c) => {
      if (!c) return false;
      // 过滤掉带有 0-based 索引的原始 JSON 数据，避免混淆 AI
      if (c.startsWith("[VOTE_RESULT]")) return false;
      // Filter out dawn and vote start messages in both locales
      if (excluded.includes(c)) return false;
      // 喵杀修正（2026-10-17 · 站长实测）：这里原本把「X号 昨晚出局 / 昨晚平安无事」也过滤掉了，
      // 导致天亮后的 AI 只能靠 <today_deaths> 推断死者，第一天首位发言者（当天记录为空）
      // 曾出现「今天没死人」的错误发言。死讯是公开信息，必须保留给 AI。
      return true;
    });

  const limit = Math.max(0, maxLines);
  if (limit === 0 || systemLines.length === 0) return "";
  const recentLines = systemLines.length > limit ? systemLines.slice(-limit) : systemLines;
  return recentLines.join("\n");
};

/**
 * Build role-specific private information section.
 * This is placed at the TOP of the context to ensure AI sees it first.
 */
const buildRolePrivateInfo = (state: GameState, player: Player): string | null => {
  const { t } = getI18n();
  
  if (player.role === "Seer") {
    const history = state.nightActions.seerHistory || [];
    if (history.length === 0) return null;
    
    const checks = history.map((record) => {
      const target = state.players.find((p) => p.seat === record.targetSeat);
      const resultEmoji = record.isWolf ? "🐺 狼人" : "✓ 好人";
      return `  第${record.day}夜 → ${record.targetSeat + 1}号${target?.displayName || ""} = ${resultEmoji}`;
    });
    
    return `<your_seer_checks>
【你的查验记录】
${checks.join("\n")}
</your_seer_checks>`;
  }
  
  if (player.role === "Witch") {
    const healStatus = state.roleAbilities.witchHealUsed ? "已用" : "可用";
    const poisonStatus = state.roleAbilities.witchPoisonUsed ? "已用" : "可用";
    const witchActions: string[] = [];
    const wolfTargetInfo: string[] = [];

    if (state.nightHistory) {
      Object.entries(state.nightHistory).forEach(([day, history]) => {
        // 收集狼人刀口信息
        if (history.wolfTarget !== undefined) {
          const targetPlayer = state.players.find(p => p.seat === history.wolfTarget);
          if (targetPlayer) {
            wolfTargetInfo.push(`  第${day}夜：狼目标为 ${history.wolfTarget + 1}号${targetPlayer.displayName}`);
          }
        }

        if (history.witchSave && history.wolfTarget !== undefined) {
          const savedPlayer = state.players.find(p => p.seat === history.wolfTarget);
          if (savedPlayer) {
            witchActions.push(`  第${day}夜：救了 ${history.wolfTarget + 1}号${savedPlayer.displayName}`);
          }
        }
        if (history.witchPoison !== undefined) {
          const poisonedPlayer = state.players.find(p => p.seat === history.witchPoison);
          if (poisonedPlayer) {
            witchActions.push(`  第${day}夜：毒了 ${history.witchPoison + 1}号${poisonedPlayer.displayName}`);
          }
        }
      });
    }
    let witchInfo = `<your_potions>
【你的药水状态】解药: ${healStatus} | 毒药: ${poisonStatus}`;
    if (wolfTargetInfo.length > 0) {
      witchInfo += `\n【狼人刀口记录】\n${wolfTargetInfo.join("\n")}`;
    }
    if (witchActions.length > 0) {
      witchInfo += `\n【用药记录】\n${witchActions.join("\n")}`;
    }
    witchInfo += `\n</your_potions>`;
    return witchInfo;
  }
  
  if (player.role === "Guard") {
    const lastTarget = state.nightActions.lastGuardTarget !== undefined 
      ? state.players.find((p) => p.seat === state.nightActions.lastGuardTarget)
      : null;
    const guardedSeat = state.nightActions.lastGuardTarget;
    
    if (guardedSeat !== undefined && lastTarget) {
      const wasProtectionEffective = lastTarget.alive;
      const protectionResult = wasProtectionEffective 
        ? `${guardedSeat + 1}号${lastTarget.displayName} 今天仍然存活`
        : `${guardedSeat + 1}号${lastTarget.displayName} 已出局`;

      // 喵杀修复（2026-10-17 · 站长实测）：守卫「守护后反咬」。
      // 你昨晚主动守护了 X，第二天白天却指控 X「可能是坏人」——与自己的守护判断自相矛盾。
      // 白天的讨论/投票共用这段上下文，因此在这里显式给出推理提示：
      //  ① 守护本身说明你当时判断 X 值得保护 → 无新证据不要指控他；
      //  ② 若昨夜还是「平安夜（无人出局）」，你的守护极可能正是挡下狼刀的原因 → X 大概率是好人。
      const isDayPhase = state.phase.indexOf("DAY") === 0;
      let guardReasoning = "";
      if (isDayPhase && wasProtectionEffective) {
        const lastNight = state.nightHistory?.[state.day];
        const seatAlive = (seat?: number) =>
          seat === undefined ? true : !!state.players.find((p) => p.seat === seat)?.alive;
        const peacefulLastNight =
          !!lastNight &&
          (lastNight.deaths?.length ?? 0) === 0 &&
          seatAlive(lastNight.wolfTarget) &&
          seatAlive(lastNight.witchPoison);

        guardReasoning = `\n【推理提示】你昨晚主动守护了 ${guardedSeat + 1}号${lastTarget.displayName}，说明你当时判断他值得保护。`
          + `除非白天出现了针对他的明确新证据，否则不要在发言里指控他、也不要投票给他——否则会和你昨晚的守护判断自相矛盾。`
          + (peacefulLastNight
              ? `\n昨夜是平安夜（无人出局），你的守护很可能正是挡下狼刀的原因 → ${guardedSeat + 1}号${lastTarget.displayName} 大概率是好人，更不应指控他（除非你怀疑他自刀骗守）。`
              : "");
      }

      return `<your_guard_info>
【昨晚守护】${guardedSeat + 1}号${lastTarget.displayName}
【守护结果】${protectionResult}${guardReasoning}
【今晚限制】不能连续守护 ${guardedSeat + 1}号
</your_guard_info>`;
    } else {
      return `<your_guard_info>
【首次行动】你之前没有守护过任何人
【今晚限制】无，可以守护任何存活玩家
</your_guard_info>`;
    }
  }
  
  if (player.role === "Werewolf" || player.role === "WhiteWolfKing") {
    const teammates = state.players.filter(
      (p) => (p.role === "Werewolf" || p.role === "WhiteWolfKing") && p.alive && p.playerId !== player.playerId
    );
    const allWolves = state.players.filter((p) => p.role === "Werewolf" || p.role === "WhiteWolfKing");
    const aliveWolves = allWolves.filter((p) => p.alive);
    const teammateList = teammates.length > 0 
      ? teammates.map((tm) => `${tm.seat + 1}号${tm.displayName}`).join("、")
      : "无存活队友";
    
    return `<your_wolf_team>
【狼队友】${teammateList}
【狼人存活】${aliveWolves.length}/${allWolves.length}
</your_wolf_team>`;
  }
  
  return null;
};

export const buildGameContext = (
  state: GameState,
  player: Player,
  options?: { excludePendingDeaths?: boolean }
): string => {
  const { t } = getI18n();
  const alivePlayers = state.players.filter((p) => p.alive);
  const deadPlayers = state.players.filter((p) => !p.alive);
  const totalSeats = state.players.length;
  const publicGenericDeathCause = t("promptUtils.gameContext.deathCauseDeath");
  const publicExecutionCause = t("promptUtils.gameContext.deathCauseVote");

  // === 第一优先级：角色私有信息（放在最前面） ===
  const privateInfo = buildRolePrivateInfo(state, player);
  let context = privateInfo ? `${privateInfo}\n\n` : "";

  // Build YAML-formatted game state
  const aliveSeats = alivePlayers.map((p) => p.seat + 1);
  const deadInfo = deadPlayers.map((p) => {
    // Find death info
    let cause = publicGenericDeathCause;
    let deathDay = 0;
    for (const [day, history] of Object.entries(state.nightHistory || {})) {
      if (history.wolfTarget === p.seat) { cause = publicGenericDeathCause; deathDay = Number(day); }
      if (history.witchPoison === p.seat) { cause = publicGenericDeathCause; deathDay = Number(day); }
      if (Array.isArray(history.deaths)) {
        const match = history.deaths.find((d) => d.seat === p.seat);
        if (match) {
          cause = publicGenericDeathCause;
          deathDay = Number(day);
        }
      }
      if (history.hunterShot?.targetSeat === p.seat) { cause = publicGenericDeathCause; deathDay = Number(day); }
    }
    for (const [day, history] of Object.entries(state.dayHistory || {})) {
      if (history.executed?.seat === p.seat) { cause = publicExecutionCause; deathDay = Number(day); }
      if (history.hunterShot?.targetSeat === p.seat) { cause = publicGenericDeathCause; deathDay = Number(day); }
    }
    return `{seat: ${p.seat + 1}, name: ${p.displayName}, day: ${deathDay}, cause: ${cause}}`;
  });

  const sheriffSeat = state.badge.holderSeat;
  const sheriffInfo = sheriffSeat !== null ? sheriffSeat + 1 : t("promptUtils.gameContext.noSheriff");

  // 明确的时间和身份提示，放在最前面
  const isNight = state.phase.includes("NIGHT");
  const phaseText = isNight ? t("promptUtils.gameContext.night") : t("promptUtils.gameContext.day");
  const timeReminder = t("promptUtils.gameContext.timeReminder", { 
    day: state.day, 
    phase: phaseText, 
    seat: player.seat + 1, 
    name: player.displayName 
  });

  context += `<current_status>\n${timeReminder}\n</current_status>

<game_state>
day: ${state.day}
phase: ${phaseText}
you: {seat: ${player.seat + 1}, name: ${player.displayName}}
total_seats: ${totalSeats}
alive: [${aliveSeats.join(", ")}]
dead: [${deadInfo.join(", ")}]
sheriff: ${sheriffInfo}
alive_count: ${alivePlayers.length}
</game_state>`;

  // 喵杀（2026-10-17）：把「本局角色构成」作为公开信息告诉 AI。
  // 真实玩家本来就知道本局有哪些角色（例如有没有守卫）；此前 AI 不知道，
  // 于是会出现「本局没有守卫，却去推理守卫为什么没守」这种不合逻辑的行为（站长反馈）。
  const setupCounts: Record<string, number> = {};
  state.players.forEach((p) => {
    setupCounts[p.role] = (setupCounts[p.role] || 0) + 1;
  });
  const setupRoleOrder: Array<[string, string]> = [
    ["Werewolf", "狼人"],
    ["WhiteWolfKing", "白狼王"],
    ["Seer", "预言家"],
    ["Witch", "女巫"],
    ["Hunter", "猎人"],
    ["Guard", "守卫"],
    ["Idiot", "白痴"],
    ["Villager", "平民"],
  ];
  const setupLines = setupRoleOrder
    .filter(([r]) => setupCounts[r] > 0)
    .map(([r, label]) => `${label}×${setupCounts[r]}`)
    .join("、");
  context += `\n\n<roles_in_play>\n【本局角色构成（公开信息，所有玩家都知道）】${setupLines}\n注意：本局只存在上面列出的角色。没列出的角色（例如本局没有守卫）不会有对应技能，请勿假设、也勿推理其行为。\n</roles_in_play>`;

  // 喵杀修复（2026-10-17 · 站长实测）：把**公开已确认的事实**原文喂给 AI。
  // 站长反馈：白狼王自爆且与预言家同归后，仍有 AI 在推理「他到底是不是狼」。
  // 自爆是硬机制、公开事件——自爆者身份当场公开（狼人阵营）。这里把系统公告原文抽出，
  // 并明确「不要再质疑」，避免 AI 对已公开的事实做无意义猜测。
  const confirmedMsgs = state.messages
    .filter((m) => m.isSystem && /白狼王|自爆/.test(m.content ?? ""))
    .map((m) => m.content);
  if (confirmedMsgs.length > 0) {
    context += `\n\n<confirmed_public_facts>\n【本局已确认的公开事实（不可推翻，不要再质疑或猜测）】\n${confirmedMsgs.join("\n")}\n说明：白狼王自爆是公开事件 —— 自爆者即为白狼王（狼人阵营，不在狼队的人也能据此断定），被其带走的受害者已阵亡。请勿再讨论「自爆者是不是狼」。\n</confirmed_public_facts>`;
  }

  // Add alive players list for reference
  const playerList = alivePlayers
    .map((p) => `  - ${t("promptUtils.gameContext.seatLabel", { seat: p.seat + 1 })} ${p.displayName}${p.playerId === player.playerId ? t("promptUtils.gameContext.youSuffix") : ""}`)
    .join("\n");
  context += `\n\n<alive_players>\n${playerList}\n</alive_players>`;

  // 喵杀修正（第十二轮）：收回玩家视角——已出局玩家的「身份」不再作为公开信息。
  // UI 侧死者头像不再显示身份，AI 侧同样不再拿到 <eliminated_players>；
  // 只保留「谁死了/怎么死的」这类真正的公开信息（见上方 <game_state> 的 dead 列表）。
  // 这样玩家与 AI 的信息完全对等，难度更有趣。

  const wolfFriendlyFireNote = t("promptUtils.gameContext.wolfFriendlyFireNote");
  const phaseOrderNote = t("promptUtils.gameContext.phaseOrderNote");
  
  // Check if guard exists in this game
  const hasGuard = state.players.some(p => p.role === "Guard");
  
  // Check if it's a peaceful night (no deaths today)
  const nightHistory = state.nightHistory?.[state.day];
  const isPeacefulNight = !options?.excludePendingDeaths && 
    state.phase.includes("DAY") && 
    nightHistory && 
    !nightHistory.wolfTarget && 
    !nightHistory.witchPoison && 
    (!nightHistory.deaths || nightHistory.deaths.length === 0);
  
  // Build rules text with phase order note always included
  // 喵杀（十四轮）：把「本局生效规则」放在最前面 —— 白天讨论/投票/夜间行动共用这段上下文，
  // 之前只有守卫/女巫的夜间提示里提过「毒奶」，白天的 AI 完全不知道规则，
  // 于是「同守同救必死」被当成「守卫和女巫太假」在场上被指责（站长反馈）。
  let rulesText = buildHouseRulesNote(state);
  rulesText += `\n${wolfFriendlyFireNote}`;
  if (isPeacefulNight) {
    // Use different peaceful night note based on whether guard exists
    const peacefulNightNote = hasGuard 
      ? t("promptUtils.gameContext.peacefulNightNote")
      : t("promptUtils.gameContext.peacefulNightNoteNoGuard");
    rulesText += `\n${peacefulNightNote}`;
  }
  rulesText += `\n${phaseOrderNote}`;
  
  if (rulesText) {
    context += `\n\n<rules>\n${rulesText}\n</rules>`;
  }

  const summarySection = buildDailySummariesSection(state);
  if (summarySection) {
    context += `\n\n${summarySection}`;
  }

  const systemAnnouncements = buildSystemAnnouncementsSinceDawn(state, 8);
  if (systemAnnouncements) {
    context += `\n\n<announcements>\n${systemAnnouncements}\n</announcements>`;
  }

  if (deadPlayers.length > 0) {
    // Build today's deaths info (skip if excludePendingDeaths is true - deaths not announced yet)
    if (!options?.excludePendingDeaths) {
      const currentDayDeaths: string[] = [];
      const nightHistory = state.nightHistory?.[state.day];
      if (nightHistory?.wolfTarget !== undefined) {
        const p = state.players.find(p => p.seat === nightHistory.wolfTarget);
        if (p && !p.alive) {
          currentDayDeaths.push(`{seat: ${p.seat + 1}, name: ${p.displayName}, cause: ${publicGenericDeathCause}}`);
        }
      }
      if (nightHistory?.witchPoison !== undefined) {
        const p = state.players.find(p => p.seat === nightHistory.witchPoison);
        if (p && !p.alive) {
          currentDayDeaths.push(`{seat: ${p.seat + 1}, name: ${p.displayName}, cause: ${publicGenericDeathCause}}`);
        }
      }
      if (nightHistory?.deaths && Array.isArray(nightHistory.deaths)) {
        nightHistory.deaths.forEach(death => {
          if (death && typeof death.seat === 'number') {
            const p = state.players.find(p => p.seat === death.seat);
            if (p && !p.alive) {
              currentDayDeaths.push(`{seat: ${p.seat + 1}, name: ${p.displayName}, cause: ${publicGenericDeathCause}}`);
            }
          }
        });
      }
      const dayHistory = state.dayHistory?.[state.day];
      if (dayHistory?.executed && typeof dayHistory.executed.seat === 'number') {
        const executedSeat = dayHistory.executed.seat;
        const p = state.players.find(p => p.seat === executedSeat);
        if (p) {
          currentDayDeaths.push(`{seat: ${p.seat + 1}, name: ${p.displayName}, cause: ${publicExecutionCause}}`);
        }
      }

      if (currentDayDeaths.length > 0) {
        context += `\n\n<today_deaths>\n${currentDayDeaths.join("\n")}\n</today_deaths>`;
      }
    }

    // Dead players note - softer guideline, allow referencing death causes but focus on alive players
    context += `\n\n<focus_reminder>${t("promptUtils.gameContext.focusReminder")}</focus_reminder>`;
  }

  if (state.voteHistory && Object.keys(state.voteHistory).length > 0) {
    context += `\n\n<votes>`;
    const sheriffSeat = state.badge.holderSeat;
    const sheriffPlayer =
      sheriffSeat !== null ? state.players.find((p) => p.seat === sheriffSeat) : null;
    const sheriffPlayerId = sheriffPlayer?.playerId;
    const currentDay = state.day;
    
    Object.entries(state.voteHistory)
      .sort(([a], [b]) => Number(a) - Number(b))
      .forEach(([day, votes]) => {
        const dayNum = Number(day);
        const isRecent = currentDay - dayNum <= 1; // Recent 2 days show details
        
        const voteGroups: Record<number, number[]> = {};
        Object.entries(votes).forEach(([voterId, targetSeat]) => {
          const voter = state.players.find(p => p.playerId === voterId);
          if (voter) {
            if (!voteGroups[targetSeat]) voteGroups[targetSeat] = [];
            voteGroups[targetSeat].push(voter.seat);
          }
        });
        
        // Sort by vote count descending
        const sortedTargets = Object.entries(voteGroups)
          .map(([target, voters]) => {
            const weightedVotes = voters.reduce((sum, seat) => {
              const voter = state.players.find((p) => p.seat === seat);
              if (!voter) return sum;
              return sum + (voter.playerId === sheriffPlayerId ? 1.5 : 1);
            }, 0);
            return { target: Number(target), voters, weightedVotes };
          })
          .sort((a, b) => b.weightedVotes - a.weightedVotes);
        
        if (isRecent) {
          // Recent days: show full details in YAML format
          context += `\nday_${day}:`;
          sortedTargets.forEach(({ target, voters, weightedVotes }) => {
            const targetPlayer = state.players.find(p => p.seat === target);
            const voteLabel = Number.isInteger(weightedVotes) ? `${weightedVotes}` : weightedVotes.toFixed(1);
            const voterList = voters.map(s => s + 1).join(',');
            context += `\n  ${t("promptUtils.gameContext.seatLabel", { seat: target + 1 })}${targetPlayer?.displayName || ''}: {${t("promptUtils.gameContext.voteCount")}: ${voteLabel}, ${t("promptUtils.gameContext.voters")}: [${voterList}]}`;
          });
        } else {
          // Older days: compressed summary
          const dayHistory = state.dayHistory?.[dayNum];
          if (dayHistory?.executed) {
            const executedSeat = dayHistory.executed.seat;
            const executedPlayer = state.players.find(p => p.seat === executedSeat);
            const topVoter = sortedTargets[0]?.voters[0];
            const leaderSeat = topVoter !== undefined ? topVoter + 1 : null;
            context += `\nday_${day}: {${t("promptUtils.gameContext.eliminated").trim()}: ${t("promptUtils.gameContext.seatLabel", { seat: executedSeat + 1 })}${executedPlayer?.displayName || ''}, ${t("promptUtils.gameContext.voteCount")}: ${dayHistory.executed.votes}${leaderSeat ? `, ${t("promptUtils.gameContext.mainVoter")}: ${t("promptUtils.gameContext.seatLabel", { seat: leaderSeat })}` : ''}}`;
          } else if (dayHistory?.voteTie) {
            context += `\nday_${day}: {${t("promptUtils.gameContext.result")}: ${t("promptUtils.gameContext.tie")}}`;
          }
        }
      });
    context += `\n</votes>`;
  }

  // NOTE: Role-specific private information is now at the TOP of the context
  // via buildRolePrivateInfo() to ensure AI sees it first.

  // NOTE: We intentionally do NOT include <current_votes> during DAY_VOTE phase.
  // Showing real-time votes to later voters causes a "bandwagon effect" where
  // AI players follow earlier votes instead of making independent decisions
  // based on their own analysis and speeches.

  return context;
};

/**
 * Build a system message with cache control for static content.
 * Splits the system prompt into cacheable (static rules) and non-cacheable (dynamic state) parts.
 * 
 * @param cacheableContent - Static content that can be cached (role rules, win conditions, etc.)
 * @param dynamicContent - Dynamic content that changes per request (game state, player-specific info)
 * @param useCache - Whether to enable caching (default: true)
 * @param ttl - Cache TTL: "5m" (default) or "1h"
 * @returns LLMMessage with cache_control breakpoints
 */
export function buildSystemTextFromParts(parts: SystemPromptPart[]): string {
  return parts
    .map((part) => part.text)
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function buildCachedSystemMessageFromParts(
  parts: SystemPromptPart[] | undefined,
  fallbackSystem: string,
  useCache: boolean = true
): LLMMessage {
  if (!parts || parts.length === 0 || !useCache) {
    return { role: "system", content: fallbackSystem };
  }

  let cacheCount = 0;
  const contentParts: Array<{
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral"; ttl?: "1h" };
  }> = [];

  parts.forEach((part) => {
    const text = part.text.trim();
    if (!text) return;
    const cacheable = part.cacheable === true;
    const allowCache = cacheable && cacheCount < 4;
    const cache_control = allowCache
      ? {
          type: "ephemeral" as const,
          ...(part.ttl === "1h" ? { ttl: "1h" as const } : {}),
        }
      : undefined;

    if (allowCache) cacheCount += 1;

    contentParts.push({
      type: "text",
      text,
      ...(cache_control ? { cache_control } : {}),
    });
  });

  if (contentParts.length === 0) {
    return { role: "system", content: fallbackSystem };
  }

  return {
    role: "system",
    content: contentParts,
  };
}
