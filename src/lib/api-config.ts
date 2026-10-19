/**
 * 前端 API 配置管理
 * 使用 localStorage 存储，支持用户自定义 API 设置
 */

// API 服务商预设
export interface ApiProvider {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  applyUrl: string;
}

// 预设模型列表
export const MODEL_PRESETS = [
  'deepseek-v3.2',
  'gemini-3-flash-preview',
  'gemini-3-pro',
  'gemini-2.5-pro',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-5-20251101',
  'gpt-5.2',
  'gpt-4.1',
] as const;

export const API_PROVIDERS: ApiProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    defaultModel: 'deepseek-chat',
    applyUrl: 'https://platform.deepseek.com/',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1/chat/completions',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    applyUrl: 'https://cloud.siliconflow.cn/',
  },
  {
    id: 'openai',
    name: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o',
    applyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'custom',
    name: '自定义',
    baseUrl: '',
    defaultModel: '',
    applyUrl: '',
  },
];

export interface ApiConfig {
  // LLM 配置
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  
  // TTS 配置 (MiniMax)
  ttsEnabled: boolean;
  ttsApiKey: string;
  ttsGroupId: string;
}

const STORAGE_KEY = 'meowcha_api_config';

/**
 * 玩家自己在「设置 → AI 模型」里填写的配置（优先级最高）。
 * 使用独立的存储键，不会被部署时注入的 prefill.js 锁定，
 * 因此可以在不修改服务器默认配置的前提下覆盖它。
 */
const USER_OVERRIDE_KEY = 'meowcha_user_api_config';

const DEFAULT_CONFIG: ApiConfig = {
  llmProvider: 'deepseek',
  llmBaseUrl: 'https://api.deepseek.com/v1/chat/completions',
  llmApiKey: '',
  llmModel: 'deepseek-flash',
  
  ttsEnabled: false,
  ttsApiKey: '',
  ttsGroupId: '',
};

function readStoredConfig(key: string): Partial<ApiConfig> | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Partial<ApiConfig>) : null;
  } catch (e) {
    console.warn('Failed to load API config from localStorage:', key, e);
    return null;
  }
}

/** 一条配置是否「可用」：地址和 Key 都齐了才能真的让 AI 说话 */
function isUsableConfig(config: Partial<ApiConfig> | null): boolean {
  return Boolean(config && config.llmApiKey && config.llmBaseUrl);
}

/** 玩家在「设置 → AI 模型」里填写的配置（可能为空） */
export function getUserApiOverride(): Partial<ApiConfig> {
  return readStoredConfig(USER_OVERRIDE_KEY) ?? {};
}

/** 玩家是否填写了「可用的」覆盖配置 */
export function hasUserApiOverride(): boolean {
  return isUsableConfig(readStoredConfig(USER_OVERRIDE_KEY));
}

/** 服务器端默认配置（部署时由 prefill.js 写入） */
export function getServerApiConfig(): Partial<ApiConfig> {
  return readStoredConfig(STORAGE_KEY) ?? {};
}

export type ApiConfigSource = 'user' | 'server' | 'none';

/** 当前生效配置的来源：玩家填写 > 服务器默认 > 未配置 */
export function getApiConfigSource(): ApiConfigSource {
  if (hasUserApiOverride()) {
    return 'user';
  }
  if (isUsableConfig(readStoredConfig(STORAGE_KEY))) {
    return 'server';
  }
  return 'none';
}

/**
 * 当前生效的完整配置。
 * 优先级：玩家在设置里填写的（填写了才生效）> 服务器默认配置 > 内置默认值。
 */
export function getApiConfig(): ApiConfig {
  if (typeof window === 'undefined') {
    return DEFAULT_CONFIG;
  }

  const override = readStoredConfig(USER_OVERRIDE_KEY);
  if (isUsableConfig(override)) {
    return { ...DEFAULT_CONFIG, ...override };
  }

  const server = readStoredConfig(STORAGE_KEY);
  if (isUsableConfig(server)) {
    return { ...DEFAULT_CONFIG, ...server };
  }

  return DEFAULT_CONFIG;
}

/** 保存玩家填写的覆盖配置（存空字符串即等于「不填」） */
export function saveUserApiOverride(config: Partial<ApiConfig>): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const current = getUserApiOverride();
    window.localStorage.setItem(USER_OVERRIDE_KEY, JSON.stringify({ ...current, ...config }));
  } catch (e) {
    console.warn('Failed to save user api config to localStorage:', e);
  }
}

/** 清除玩家填写的覆盖配置，回到「使用服务器默认配置」 */
export function clearUserApiOverride(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.removeItem(USER_OVERRIDE_KEY);
  } catch (e) {
    console.warn('Failed to clear user api config from localStorage:', e);
  }
}

export interface ApiTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

/**
 * 测试一组 LLM 配置是否能真正连通（发一条最小的 chat 请求）。
 * 用于「测试连通性」按钮，不会写入任何存储。
 */
export async function testApiConnection(config: {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}): Promise<ApiTestResult> {
  const started = Date.now();
  const baseUrl = (config.llmBaseUrl || '').trim();
  const apiKey = (config.llmApiKey || '').trim();

  if (!baseUrl || !apiKey) {
    return { ok: false, message: '请先填写 API 地址与 API Key', latencyMs: 0 };
  }

  try {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: (config.llmModel || '').trim() || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        stream: false,
      }),
    });

    const latencyMs = Date.now() - started;

    if (!response.ok) {
      const text = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        message = parsed?.error?.message || parsed?.error || parsed?.message || message;
      } catch {
        message = `${message}: ${text.slice(0, 200)}`;
      }
      return { ok: false, message: String(message), latencyMs };
    }

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content;
    return {
      ok: true,
      message: reply ? `连通成功，模型回复：${String(reply).slice(0, 40)}` : '连通成功',
      latencyMs,
    };
  } catch (e) {
    return {
      ok: false,
      message: `请求失败：${e instanceof Error ? e.message : String(e)}`,
      latencyMs: Date.now() - started,
    };
  }
}

export function saveApiConfig(config: Partial<ApiConfig>): void {
  if (typeof window === 'undefined') {
    return;
  }
  
  try {
    const current = getApiConfig();
    const updated = { ...current, ...config };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.warn('Failed to save API config to localStorage:', e);
  }
}

export function clearApiConfig(): void {
  if (typeof window === 'undefined') {
    return;
  }
  
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.warn('Failed to clear API config from localStorage:', e);
  }
}

export function isApiConfigured(): boolean {
  const config = getApiConfig();
  return Boolean(config.llmApiKey && config.llmBaseUrl);
}
