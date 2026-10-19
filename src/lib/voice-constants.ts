export type AppLocale = "zh" | "en";

export interface VoicePreset {
  id: string;
  name: string;
  styles: string[]; // 对应的 persona styleLabel 或 traits
  gender: "male" | "female";
  minAge?: number;
  maxAge?: number;
  /**
   * 底层 edge-tts 音色分组（就是实际发声的那个「音色模型」的 ShortName）。
   * 喵杀（第十二轮）：自建 tts 容器把多个 MiniMax 风格 ID 映射到同一个 edge 音色
   * （仅靠语速/音调区分）→ 同局里两个角色可能拿到「同一个底层嗓音」。
   * 这里显式声明每个预设的底色，pickUnusedVoiceId 会优先保证「同局内底色不重复」。
   * ⚠️ 必须与服务器 tts 容器 /root/Nginx/tts_src/main.py 的 VOICE_MAP 保持一致。
   */
  voiceGroup?: string;
}

// MiniMax T2A V2 推荐音色 (根据官方文档或常用音色)
// 注意：实际 ID 需要根据 MiniMax 控制台获取，这里使用一些常见的预设 ID 或示例 ID
// 喵杀（十三轮）再排：站长反馈「方言听不懂」→ **把所有方言底色换掉**。
//   · 去掉 zh-HK（粤语）、zh-CN-liaoning（东北话）、zh-CN-shaanxi（陕西话）；
//   · 保留 zh-TW（台湾腔，仍是普通话，能听懂）；
//   · 「港普空姐」语义上原本定位粤语，这里改名「清爽女声」并改用台湾腔底色。
// 换算后普通话可用底色：男 5（云希/云夏/云健/云扬/云哲）· 女 4（晓晓/晓伊/晓臻/晓雨）。
// 同局同性别 ≤ 可用底色数时仍不撞（pickUnusedVoiceId 按 voiceGroup 去重），超出才复用。
export const VOICE_PRESETS: VoicePreset[] = [
  // --- 男性音色 ---
  { id: "Cantonese_PlayfulMan", name: "活泼男声", styles: ["cheerful", "balanced", "活泼", "阳光"], gender: "male", minAge: 18, maxAge: 22, voiceGroup: "zh-CN-YunxiaNeural" },
  { id: "Chinese (Mandarin)_Stubborn_Friend", name: "嘴硬竹马", styles: ["aggressive", "balanced", "嘴硬", "竹马"], gender: "male", minAge: 21, maxAge: 25, voiceGroup: "zh-CN-YunxiNeural" },
  { id: "Chinese (Mandarin)_Southern_Young_Man", name: "南方小哥", styles: ["cheerful", "safe", "南方", "随和"], gender: "male", minAge: 24, maxAge: 29, voiceGroup: "zh-TW-YunJheNeural" },
  { id: "Chinese (Mandarin)_Gentle_Youth", name: "温润青年", styles: ["calm", "balanced", "温润", "儒雅"], gender: "male", minAge: 28, maxAge: 34, voiceGroup: "zh-CN-YunjianNeural" },
  { id: "male-qn-jingying", name: "精英青年音色", styles: ["logic", "balanced", "精英", "青年"], gender: "male", minAge: 32, maxAge: 38, voiceGroup: "zh-CN-YunyangNeural" },
  { id: "Chinese (Mandarin)_Sincere_Adult", name: "真诚青年", styles: ["balanced", "safe", "真诚", "热情"], gender: "male", minAge: 36, maxAge: 42, voiceGroup: "zh-CN-YunxiNeural" },
  { id: "Chinese (Mandarin)_Radio_Host", name: "电台男主播", styles: ["calm", "logic", "电台", "播音"], gender: "male", minAge: 41, maxAge: 48, voiceGroup: "zh-CN-YunyangNeural" },
  { id: "Chinese (Mandarin)_Humorous_Elder", name: "搞笑大爷", styles: ["cheerful", "aggressive", "搞笑", "大爷"], gender: "male", minAge: 45, voiceGroup: "zh-CN-YunjianNeural" },

  // --- 女性音色（普通话 4 个底色，7 个预设按 voiceGroup 去重分配）---
  { id: "Chinese (Mandarin)_Cute_Spirit", name: "憨憨萌兽", styles: ["cheerful", "balanced", "憨憨", "萌"], gender: "female", minAge: 18, maxAge: 21, voiceGroup: "zh-CN-XiaoyiNeural" },
  { id: "Chinese (Mandarin)_Warm_Girl", name: "温暖少女", styles: ["cheerful", "safe", "温暖", "少女"], gender: "female", minAge: 22, maxAge: 25, voiceGroup: "zh-CN-XiaoxiaoNeural" },
  { id: "Chinese (Mandarin)_Soft_Girl", name: "软软女孩", styles: ["balanced", "safe", "软软", "可爱"], gender: "female", minAge: 26, maxAge: 29, voiceGroup: "zh-TW-HsiaoYuNeural" },
  { id: "Chinese (Mandarin)_HK_Flight_Attendant", name: "清爽女声", styles: ["balanced", "safe", "清爽", "利落"], gender: "female", minAge: 30, maxAge: 32, voiceGroup: "zh-TW-HsiaoChenNeural" },
  { id: "Chinese (Mandarin)_Gentle_Senior", name: "温柔学姐", styles: ["calm", "safe", "学姐", "温柔"], gender: "female", minAge: 33, maxAge: 34, voiceGroup: "zh-CN-XiaoxiaoNeural" },
  { id: "Chinese (Mandarin)_Warm_Bestie", name: "温暖闺蜜", styles: ["balanced", "safe", "闺蜜", "温暖"], gender: "female", minAge: 35, maxAge: 44, voiceGroup: "zh-TW-HsiaoYuNeural" },
  { id: "Chinese (Mandarin)_Kind-hearted_Antie", name: "热心大婶", styles: ["cheerful", "aggressive", "热心", "大婶"], gender: "female", minAge: 45, voiceGroup: "zh-CN-XiaoyiNeural" },
];

// English Voice Presets (MiniMax T2A V2)
export const ENGLISH_VOICE_PRESETS: VoicePreset[] = [
  // --- Male Voices ---
  { id: "English_Trustworthy_Man", name: "Trustworthy Man", styles: ["balanced", "safe", "reliable", "steady"], gender: "male", minAge: 28, maxAge: 40 },
  { id: "English_Gentle-voiced_man", name: "Gentle-voiced man", styles: ["calm", "balanced", "soft", "gentle"], gender: "male", minAge: 25, maxAge: 35 },
  { id: "English_Diligent_Man", name: "Diligent Man", styles: ["logic", "calm", "serious", "professional"], gender: "male", minAge: 35, maxAge: 50 },
  { id: "English_Aussie_Bloke", name: "Aussie Bloke", styles: ["cheerful", "aggressive", "energetic", "rough"], gender: "male", minAge: 30, maxAge: 55 },
  { id: "Santa_Claus", name: "Santa Claus", styles: ["cheerful", "warm", "elder"], gender: "male", minAge: 50 },
  { id: "Friendly_Person", name: "Friendly Person", styles: ["cheerful", "balanced", "friendly"], gender: "male", minAge: 18, maxAge: 30 },
  
  // --- Female Voices ---
  { id: "English_Graceful_Lady", name: "Graceful Lady", styles: ["calm", "balanced", "elegant", "mature"], gender: "female", minAge: 30, maxAge: 50 },
  { id: "Sweet_Girl", name: "Sweet Girl", styles: ["cheerful", "safe", "sweet", "young"], gender: "female", minAge: 18, maxAge: 25 },
  { id: "English_Whispering_girl", name: "Whispering girl", styles: ["calm", "safe", "soft", "quiet"], gender: "female", minAge: 20, maxAge: 30 },
  { id: "Charming_Lady", name: "Charming Lady", styles: ["balanced", "safe", "charming", "warm"], gender: "female", minAge: 25, maxAge: 40 },
  { id: "Serene_Woman", name: "Serene Woman", styles: ["calm", "balanced", "serene", "storytelling"], gender: "female", minAge: 35, maxAge: 55 },
  { id: "Lively_Girl", name: "Lively Girl", styles: ["cheerful", "balanced", "energetic"], gender: "female", minAge: 18, maxAge: 28 },
];

export const DEFAULT_VOICE_ID = {
  male: "male-qn-jingying",
  female: "Chinese (Mandarin)_Warm_Girl",
};

export const DEFAULT_VOICE_ID_EN = {
  male: "English_Trustworthy_Man",
  female: "English_Graceful_Lady",
};

/**
 * Resolve voice ID based on input, gender, age, and locale.
 * - For Chinese (zh): Uses VOICE_PRESETS and prioritizes input ID if valid.
 * - For English (en): Always uses ENGLISH_VOICE_PRESETS, ignoring Chinese input IDs.
 */
export function resolveVoiceId(
  input: string | undefined,
  gender: "male" | "female" | "nonbinary" | undefined,
  age?: number,
  locale: AppLocale = "zh"
): string {
  const normGender: "male" | "female" = gender === "female" ? "female" : "male";
  
  // Select preset list and defaults based on locale
  const presets = locale === "en" ? ENGLISH_VOICE_PRESETS : VOICE_PRESETS;
  const defaults = locale === "en" ? DEFAULT_VOICE_ID_EN : DEFAULT_VOICE_ID;
  
  // For Chinese locale, check if input ID exists in presets
  if (locale === "zh") {
    const trimmed = (input || "").trim();
    const exists = trimmed ? presets.some((p) => p.id === trimmed) : false;
    if (exists) return trimmed;
  }
  // For English locale, we always resolve from English presets (ignore Chinese input ID)
  
  // Filter by gender
  const baseCandidates = presets.filter((p) => p.gender === normGender);
  
  // Filter by age if available
  const hasAge = typeof age === "number" && Number.isFinite(age);
  const ageCandidates = hasAge
    ? baseCandidates.filter((p) => {
        const minOk = typeof p.minAge === "number" ? age >= p.minAge : true;
        const maxOk = typeof p.maxAge === "number" ? age <= p.maxAge : true;
        return minOk && maxOk;
      })
    : baseCandidates;

  const picked = (ageCandidates[0] ?? baseCandidates[0])?.id;
  if (picked) return picked;

  return normGender === "female" ? defaults.female : defaults.male;
}

/**
 * 喵杀：为一局内的角色挑一个「不重复」的音色。
 * 原 resolveVoiceId 兜底取的是「第一个匹配项」→ 同性别 + 同年龄段的角色会拿到同一个音色，
 * 一局里就会出现多个角色嗓音一模一样。这里按
 * 「① 年龄段匹配且未被占用 → ② 同性别未被占用 → ③ 只能复用」的顺序挑。
 */
export function pickUnusedVoiceId(
  used: ReadonlySet<string>,
  gender: "male" | "female" | "nonbinary" | undefined,
  age?: number,
  locale: AppLocale = "zh"
): string {
  const normGender: "male" | "female" = gender === "female" ? "female" : "male";
  const presets = locale === "en" ? ENGLISH_VOICE_PRESETS : VOICE_PRESETS;
  const defaults = locale === "en" ? DEFAULT_VOICE_ID_EN : DEFAULT_VOICE_ID;

  // 底色分组：显式声明 voiceGroup 时按底色去重（避免「不同 ID、同一个嗓音模型」）；
  // 未声明（如英文预设）时退化为按 id 去重，与旧行为一致。
  const idToGroup = new Map<string, string>();
  for (const p of presets) idToGroup.set(p.id, p.voiceGroup ?? p.id);
  const groupOf = (p: VoicePreset) => p.voiceGroup ?? p.id;
  const usedGroups = new Set<string>();
  for (const id of used) usedGroups.add(idToGroup.get(id) ?? id);

  const pool = presets.filter((p) => p.gender === normGender);
  const hasAge = typeof age === "number" && Number.isFinite(age);
  const inAge = hasAge
    ? pool.filter(
        (p) =>
          (typeof p.minAge === "number" ? age >= p.minAge : true) &&
          (typeof p.maxAge === "number" ? age <= p.maxAge : true)
      )
    : pool;

  const fullyFree = (list: VoicePreset[]) =>
    list.find((p) => !used.has(p.id) && !usedGroups.has(groupOf(p)));

  // ① 年龄段内 + 底色与 id 都未被占用（首选，保证同局嗓音模型不重复）
  const ageGroupFree = fullyFree(inAge);
  if (ageGroupFree) return ageGroupFree.id;
  // ② 同性别内 + 底色与 id 都未被占用
  const anyGroupFree = fullyFree(pool);
  if (anyGroupFree) return anyGroupFree.id;
  // ③ 底色池已用尽：退而求「id 未被占用」——正常一局人数不会超过音色池
  const ageFree = inAge.find((p) => !used.has(p.id));
  if (ageFree) return ageFree.id;
  const anyFree = pool.find((p) => !used.has(p.id));
  if (anyFree) return anyFree.id;
  // ④ 只能复用
  return (inAge[0] ?? pool[0])?.id ?? (normGender === "female" ? defaults.female : defaults.male);
}
