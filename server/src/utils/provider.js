import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "./env.js";

const DEFAULT_PROVIDER_CONFIG = path.join(os.homedir(), ".config", "link-router", "providers.json");
const PROVIDER_TIMEOUT_MS = 12000;

export async function generateClipMetadata(payload, target) {
  const prompt = [
    "你是一个本地网页收藏整理器。请只输出 JSON，不要 Markdown。",
    "字段：titleZh, oneLine, summary, tags, contentType, whySaved。",
    "要求：中文为主，tags 2-6 个，contentType 从 article/tool/design_reference/thought/video/tweet/portfolio/documentation/unknown 里选。",
    "",
    `目标：${target}`,
    `标题：${payload.title}`,
    `URL：${payload.url}`,
    `页面描述：${payload.pageMeta?.description || ""}`,
    `作者：${payload.pageMeta?.author || ""}`,
    `选中文字：${payload.selectedText || ""}`,
    `用户备注：${payload.userNote || ""}`
  ].join("\n");

  try {
    const text = await withTimeout(callConfiguredProvider(prompt), PROVIDER_TIMEOUT_MS, "Provider metadata generation timed out");
    const parsed = parseJson(text);
    return sanitizeMetadata(parsed, payload);
  } catch (error) {
    return {
      titleZh: payload.title || "网页摘录",
      oneLine: "网页收藏摘录",
      summary: [payload.userNote, payload.selectedText].filter(Boolean).join("\n") || "待补充摘要。",
      tags: ["网页摘录"],
      contentType: "unknown",
      whySaved: payload.userNote || "待补充保存原因。",
      providerError: error.message
    };
  }
}

export async function testProviderSettings(settings = {}) {
  const env = loadEnv();
  const provider = buildCustomProvider({
    ...env,
    CLIP_ROUTER_LLM_PROVIDER: settings.llmProvider,
    CLIP_ROUTER_LLM_API_TYPE: settings.llmApiType || "openai-chat",
    CLIP_ROUTER_LLM_BASE_URL: settings.llmBaseUrl,
    CLIP_ROUTER_LLM_MODEL: settings.llmModel,
    CLIP_ROUTER_LLM_API_KEY: resolveTestApiKey(settings.llmApiKey, env)
  });
  if (!provider) throw new Error("请先填写 Base URL 和 Model");
  if (!provider.apiKey) throw new Error("请先填写 API Key");
  const text = await withTimeout(
    callProvider(provider, "请只输出 JSON：{\"ok\":true}"),
    PROVIDER_TIMEOUT_MS,
    "模型连接测试超时"
  );
  const parsed = parseJson(text);
  if (parsed.ok !== true) throw new Error("模型返回内容不符合预期");
  return {
    ok: true,
    provider: provider.providerName || "",
    model: provider.model,
    baseUrl: provider.baseUrl
  };
}

function resolveTestApiKey(value, env) {
  const text = String(value || "").trim();
  if (text && !/\*{3,}/.test(text)) return text;
  return env.CLIP_ROUTER_LLM_API_KEY || env.CLIP_ROUTER_API_KEY || "";
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

async function callConfiguredProvider(prompt) {
  const env = loadEnv();
  const customProvider = buildCustomProvider(env);
  if (customProvider) {
    return callProvider(customProvider, prompt);
  }

  const providerConfigPath = env.CLIP_ROUTER_PROVIDER_CONFIG || DEFAULT_PROVIDER_CONFIG;
  const config = JSON.parse(await fs.readFile(providerConfigPath, "utf8"));
  const providers = config?.models?.providers || {};
  const providerName = env.CLIP_ROUTER_PROVIDER || Object.keys(providers)[0] || "";
  const provider = providers[providerName];
  if (!provider) throw new Error(`No provider found in ${providerConfigPath}`);

  const model = env.CLIP_ROUTER_MODEL || defaultModelForProvider(providerName, provider);
  const apiKey = provider.apiKey || config.env?.[provider.envKey] || config.env?.OPENAI_API_KEY;
  if (!apiKey && provider.auth !== "none") {
    throw new Error(`Provider ${providerName} has no apiKey`);
  }

  return callProvider({ ...provider, model, apiKey }, prompt);
}

function buildCustomProvider(env) {
  const baseUrl = env.CLIP_ROUTER_LLM_BASE_URL || env.CLIP_ROUTER_BASE_URL;
  const apiKey = env.CLIP_ROUTER_LLM_API_KEY || env.CLIP_ROUTER_API_KEY;
  const model = env.CLIP_ROUTER_LLM_MODEL || env.CLIP_ROUTER_MODEL;
  if (!baseUrl || !model) return null;
  return {
    providerName: env.CLIP_ROUTER_LLM_PROVIDER || "",
    api: env.CLIP_ROUTER_LLM_API_TYPE || "openai-chat",
    baseUrl,
    model,
    apiKey,
    auth: apiKey ? "bearer" : "none",
    authHeader: env.CLIP_ROUTER_LLM_AUTH_HEADER || "authorization"
  };
}

async function callProvider(provider, prompt) {
  const model = provider.model;
  const apiKey = provider.apiKey;
  if (provider.api === "openai-responses") {
    return callResponsesApi(provider, model, apiKey, prompt);
  }
  if (provider.api === "anthropic-messages") {
    return callAnthropicMessagesApi(provider, model, apiKey, prompt);
  }

  return callChatCompletionsApi(provider, model, apiKey, prompt);
}

function defaultModelForProvider(providerName, provider) {
  const modelIds = (provider.models || []).map((model) => model.id).filter(Boolean);
  const preferred = {
    deepseek: "deepseek-v4-flash",
    bedrock: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "bedrock-cn": "global.anthropic.claude-haiku-4-5-20251001-v1:0"
  }[providerName];
  return modelIds.includes(preferred) ? preferred : modelIds.at(-1) || "deepseek-v4-flash";
}

async function callResponsesApi(provider, model, apiKey, prompt) {
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: buildHeaders(provider, apiKey),
    body: JSON.stringify({
      model,
      input: prompt,
      text: { format: { type: "json_object" } }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Provider responses failed: ${response.status}`);
  return extractResponsesText(data);
}

async function callChatCompletionsApi(provider, model, apiKey, prompt) {
  const url = `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.2
  };
  let response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(provider, apiKey),
    body: JSON.stringify(body)
  });

  let data = await response.json().catch(() => ({}));
  if (!response.ok && response.status === 400) {
    delete body.response_format;
    response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(provider, apiKey),
      body: JSON.stringify(body)
    });
    data = await response.json().catch(() => ({}));
  }
  if (!response.ok) throw new Error(data.error?.message || `Provider chat failed: ${response.status}`);
  return data.choices?.[0]?.message?.content || "";
}

async function callAnthropicMessagesApi(provider, model, apiKey, prompt) {
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: buildHeaders(provider, apiKey),
    body: JSON.stringify({
      model,
      max_tokens: 800,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Anthropic messages failed: ${response.status}`);
  return (data.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function buildHeaders(provider, apiKey) {
  const headers = {
    "Content-Type": "application/json",
    ...(provider.headers || {})
  };

  if (provider.api === "anthropic-messages") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    return headers;
  }

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    if (provider.authHeader === false || provider.auth === "api-key") {
      headers["api-key"] = apiKey;
    }
  }

  return headers;
}

function extractResponsesText(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" || content.type === "text") chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function parseJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Provider returned empty text");
  const match = trimmed.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : trimmed);
}

function sanitizeMetadata(value, payload) {
  return {
    titleZh: String(value.titleZh || payload.title || "网页摘录").trim(),
    oneLine: String(value.oneLine || "网页收藏摘录").trim(),
    summary: String(value.summary || "待补充摘要。").trim(),
    tags: Array.isArray(value.tags) ? value.tags.map(String).filter(Boolean).slice(0, 6) : ["网页摘录"],
    contentType: String(value.contentType || "unknown").trim(),
    whySaved: String(value.whySaved || payload.userNote || "待补充保存原因。").trim()
  };
}
