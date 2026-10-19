"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  API_PROVIDERS,
  MODEL_PRESETS,
  clearUserApiOverride,
  getApiConfigSource,
  getServerApiConfig,
  getUserApiOverride,
  saveUserApiOverride,
  testApiConnection,
  type ApiConfigSource,
} from "@/lib/api-config";

/**
 * 「设置 → AI 模型」配置区。
 *
 * 优先级：这里填写的（填写后生效）> 服务器默认配置（部署时由 prefill.js 注入）> 未配置。
 * 留空即表示「使用服务器默认配置」；两边都没有时 AI 猫无法发言。
 * 配置只写在浏览器本地（localStorage），不会上传到本站服务器。
 */
export function ApiConfigSection() {
  const [providerId, setProviderId] = useState("deepseek");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");

  const [source, setSource] = useState<ApiConfigSource>("none");
  const [serverHint, setServerHint] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(() => {
    const override = getUserApiOverride();
    setProviderId(override.llmProvider || "deepseek");
    setBaseUrl(override.llmBaseUrl || "");
    setApiKey(override.llmApiKey || "");
    setModel(override.llmModel || "");

    setSource(getApiConfigSource());

    const server = getServerApiConfig();
    setServerHint(
      server.llmBaseUrl || server.llmModel
        ? `服务器默认：${server.llmProvider || "自定义"} · ${server.llmModel || "（未指定模型）"}`
        : "服务器未提供默认配置"
    );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const statusText = useMemo(() => {
    if (source === "user") return "当前使用：你填写的配置";
    if (source === "server") return "当前使用：服务器默认配置（可留空）";
    return "尚未配置：服务器没有默认值，请填写下方内容";
  }, [source]);

  const handleProviderChange = (id: string) => {
    setProviderId(id);
    const preset = API_PROVIDERS.find((p) => p.id === id);
    if (preset && preset.baseUrl) {
      setBaseUrl(preset.baseUrl);
      setModel(preset.defaultModel);
    }
  };

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testApiConnection({ llmBaseUrl: baseUrl, llmApiKey: apiKey, llmModel: model });
      setTestResult({ ok: result.ok, text: `${result.message}（${result.latencyMs}ms）` });
      if (result.ok) {
        toast("API 连通正常", { description: result.message });
      } else {
        toast("API 连通失败", { description: result.message });
      }
    } finally {
      setTesting(false);
    }
  }, [apiKey, baseUrl, model]);

  const handleSave = useCallback(() => {
    if (!baseUrl.trim() || !apiKey.trim()) {
      toast("保存失败", { description: "API 地址与 API Key 都必须填写；若要使用服务器默认配置，请点「改用服务器默认」。" });
      return;
    }
    if (!model.trim()) {
      toast("保存失败", { description: "请填写模型名称，例如 deepseek-chat。" });
      return;
    }
    saveUserApiOverride({
      llmProvider: providerId,
      llmBaseUrl: baseUrl.trim(),
      llmApiKey: apiKey.trim(),
      llmModel: model.trim(),
    });
    refresh();
    toast("已保存", { description: "新的 AI 模型配置将立即生效。" });
  }, [apiKey, baseUrl, model, providerId, refresh]);

  const handleClear = useCallback(() => {
    clearUserApiOverride();
    setBaseUrl("");
    setApiKey("");
    setModel("");
    setTestResult(null);
    refresh();
    toast("已清除自定义配置", { description: "现在回到「使用服务器默认配置」。" });
  }, [refresh]);

  const statusTone =
    source === "none"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
      : "border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]";

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium text-[var(--text-primary)]">AI 模型（LLM）</div>
        <div className="text-xs text-[var(--text-muted)]">
          留空则使用服务器默认配置；填写后优先使用你填的。两边都没有，AI 猫就不会说话。
        </div>
      </div>

      <div className={`rounded-md border-2 px-3 py-2 text-xs leading-relaxed ${statusTone}`}>
        <div className="font-medium">{statusText}</div>
        <div className="opacity-80">{serverHint}</div>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-[var(--text-secondary)]" htmlFor="meowcha-llm-provider">
          服务商
        </label>
        <select
          id="meowcha-llm-provider"
          value={providerId}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="flex h-9 w-full rounded-md border-2 border-[var(--border-color)] bg-[var(--bg-card)] px-3 text-sm text-[var(--text-primary)] focus-visible:outline-none focus-visible:border-[var(--color-accent)]"
        >
          {API_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-[var(--text-secondary)]" htmlFor="meowcha-llm-baseurl">
          API 地址（Base URL）
        </label>
        <Input
          id="meowcha-llm-baseurl"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.deepseek.com/v1/chat/completions"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs text-[var(--text-secondary)]" htmlFor="meowcha-llm-key">
          API Key
        </label>
        <Input
          id="meowcha-llm-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-...（只保存在你本机浏览器）"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs text-[var(--text-secondary)]" htmlFor="meowcha-llm-model">
          模型名称
        </label>
        <Input
          id="meowcha-llm-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="deepseek-chat"
          list="meowcha-model-presets"
          autoComplete="off"
          spellCheck={false}
        />
        <datalist id="meowcha-model-presets">
          {MODEL_PRESETS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>

      {testResult ? (
        <div
          className={`rounded-md border-2 px-3 py-2 text-xs leading-relaxed ${
            testResult.ok
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/40 bg-red-500/10 text-red-300"
          }`}
        >
          {testResult.text}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => void handleTest()} disabled={testing} className="flex-1">
          {testing ? "测试中…" : "测试连通性"}
        </Button>
        <Button type="button" variant="default" onClick={handleSave} className="flex-1">
          保存
        </Button>
      </div>
      <Button type="button" variant="outline" onClick={handleClear} className="w-full">
        清除自定义配置（改用服务器默认）
      </Button>

      <div className="text-[11px] leading-relaxed text-[var(--text-muted)]">
        · 语音朗读走站内自建的 <code>/api/tts</code>，无需在这里配置语音 Key。
        <br />· API Key 只写入本机浏览器（localStorage），请求由浏览器直连你所填写的模型服务，不会经过本站服务器。
      </div>
    </div>
  );
}
