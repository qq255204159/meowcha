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

const DEFAULT_CONFIG: ApiConfig = {
  llmProvider: 'deepseek',
  llmBaseUrl: 'https://api.deepseek.com/v1/chat/completions',
  llmApiKey: '',
  llmModel: 'deepseek-flash',
  
  ttsEnabled: false,
  ttsApiKey: '',
  ttsGroupId: '',
};

export function getApiConfig(): ApiConfig {
  if (typeof window === 'undefined') {
    return DEFAULT_CONFIG;
  }
  
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch (e) {
    console.warn('Failed to load API config from localStorage:', e);
  }
  
  return DEFAULT_CONFIG;
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
