const saveButton = document.querySelector("#saveButton");
const statusEl = document.querySelector("#status");
const routerTokenInput = document.querySelector("#routerToken");
const tokenHelpButton = document.querySelector("#tokenHelpButton");
const tokenHelp = document.querySelector("#tokenHelp");
const llmProviderInput = document.querySelector("#llmProvider");
const llmBaseUrlField = document.querySelector("#llmBaseUrlField");
const llmBaseUrlInput = document.querySelector("#llmBaseUrl");
const llmModelSelectField = document.querySelector("#llmModelSelectField");
const llmModelSelect = document.querySelector("#llmModelSelect");
const llmModelTextField = document.querySelector("#llmModelTextField");
const llmModelInput = document.querySelector("#llmModel");
const llmApiKeyInput = document.querySelector("#llmApiKey");
const testModelButton = document.querySelector("#testModelButton");
const modelTestStatus = document.querySelector("#modelTestStatus");
const bearNoteIdInput = document.querySelector("#bearNoteId");
const ROUTER_ENDPOINT = "http://127.0.0.1:18791";
const PROVIDERS = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"],
    apiType: "openai-chat",
    lockBaseUrl: true
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    models: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-3-7-sonnet-latest", "claude-sonnet-4-5"],
    apiType: "anthropic-messages",
    lockBaseUrl: true
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-2.0-flash-lite"],
    apiType: "openai-chat",
    lockBaseUrl: true
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    apiType: "openai-chat",
    lockBaseUrl: true
  },
  kimi: {
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "kimi-k2-0711-preview"],
    apiType: "openai-chat",
    lockBaseUrl: true
  },
  custom: {
    baseUrl: "",
    models: [],
    apiType: "openai-chat",
    lockBaseUrl: false
  }
};

init();

async function init() {
  const routerToken = await getRouterToken();
  routerTokenInput.value = routerToken;
  llmProviderInput.addEventListener("change", () => applyProviderPreset(llmProviderInput.value, true));
  llmModelSelect.addEventListener("change", () => {
    llmModelInput.value = llmModelSelect.value;
    modelTestStatus.textContent = "";
    modelTestStatus.className = "inline-result";
  });
  saveButton.addEventListener("click", save);
  testModelButton.addEventListener("click", testModelConnection);
  tokenHelpButton.addEventListener("click", toggleTokenHelp);
  await loadServerSettings(routerToken);
}

async function testModelConnection() {
  const routerToken = routerTokenInput.value.trim() || await getRouterToken();
  await chrome.storage.sync.set({ routerToken });
  testModelButton.disabled = true;
  testModelButton.classList.add("is-loading");
  modelTestStatus.className = "inline-result";
  modelTestStatus.textContent = "正在测试...";
  try {
    const result = await testServerModelSettings(routerToken, getModelSettingsPayload());
    modelTestStatus.className = "inline-result is-success";
    modelTestStatus.textContent = `连接成功：${result.model}`;
  } catch (error) {
    modelTestStatus.className = "inline-result is-error";
    modelTestStatus.textContent = `连接失败：${error.message}`;
  } finally {
    testModelButton.disabled = false;
    testModelButton.classList.remove("is-loading");
  }
}

async function loadServerSettings(token) {
  if (!token) return;
  try {
    const settings = await getServerSettings(token);
    llmProviderInput.value = settings.llmProvider || inferProvider(settings.llmBaseUrl) || "deepseek";
    llmBaseUrlInput.value = settings.llmBaseUrl || "";
    llmModelInput.value = settings.llmModel || "";
    llmApiKeyInput.value = settings.llmApiKeyMasked || "";
    llmApiKeyInput.placeholder = settings.llmApiKeyConfigured ? "已配置，可输入新 key 覆盖" : "填写 API key";
    bearNoteIdInput.value = settings.bearNoteId || "";
    applyProviderPreset(llmProviderInput.value, false);
  } catch (error) {
    statusEl.textContent = `读取本地服务配置失败：${error.message}`;
  }
}

async function save() {
  const routerToken = routerTokenInput.value.trim() || await getRouterToken();
  await chrome.storage.sync.set({ routerToken });
  await saveServerSettings(routerToken, {
    ...getModelSettingsPayload(),
    bearNoteId: bearNoteIdInput.value.trim()
  });
  llmApiKeyInput.value = "";
  await loadServerSettings(routerToken);
  statusEl.textContent = "已保存。";
}

function getModelSettingsPayload() {
  const provider = PROVIDERS[llmProviderInput.value] || PROVIDERS.custom;
  return {
    llmProvider: llmProviderInput.value,
    llmApiType: provider.apiType,
    llmBaseUrl: llmBaseUrlInput.value.trim(),
    llmModel: getSelectedModel(),
    llmApiKey: llmApiKeyInput.value.trim()
  };
}

function applyProviderPreset(providerKey, shouldFillDefaults) {
  const provider = PROVIDERS[providerKey] || PROVIDERS.custom;
  if (shouldFillDefaults) {
    llmBaseUrlInput.value = provider.baseUrl;
    renderModelControl(provider, provider.models[0] || "");
    modelTestStatus.textContent = "";
    modelTestStatus.className = "inline-result";
  } else {
    if (!llmBaseUrlInput.value) llmBaseUrlInput.value = provider.baseUrl;
    renderModelControl(provider, llmModelInput.value || provider.models[0] || "");
  }
  llmBaseUrlInput.readOnly = Boolean(provider.lockBaseUrl);
  llmBaseUrlField.hidden = Boolean(provider.lockBaseUrl);
  llmBaseUrlInput.classList.toggle("is-readonly", Boolean(provider.lockBaseUrl));
}

function renderModelControl(provider, selectedModel) {
  const models = provider.models || [];
  const useSelect = models.length > 0;
  llmModelSelectField.hidden = !useSelect;
  llmModelTextField.hidden = useSelect;
  if (useSelect) {
    llmModelSelect.replaceChildren(...models.map((model) => {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      return option;
    }));
    llmModelSelect.value = models.includes(selectedModel) ? selectedModel : models[0];
    llmModelInput.value = llmModelSelect.value;
  } else {
    llmModelInput.value = selectedModel || "";
  }
}

function getSelectedModel() {
  const provider = PROVIDERS[llmProviderInput.value] || PROVIDERS.custom;
  return (provider.models || []).length ? llmModelSelect.value : llmModelInput.value.trim();
}

function inferProvider(baseUrl) {
  const value = String(baseUrl || "").toLowerCase();
  if (value.includes("api.openai.com")) return "openai";
  if (value.includes("api.anthropic.com")) return "anthropic";
  if (value.includes("generativelanguage.googleapis.com")) return "gemini";
  if (value.includes("api.deepseek.com")) return "deepseek";
  if (value.includes("api.moonshot.cn")) return "kimi";
  return value ? "custom" : "";
}

function toggleTokenHelp() {
  const open = tokenHelp.hidden;
  tokenHelp.hidden = !open;
  tokenHelpButton.setAttribute("aria-expanded", String(open));
}

async function getServerSettings(token) {
  const response = await fetchWithRouterToken("/api/settings", { method: "GET" }, token);
  return readSettingsJson(response);
}

async function saveServerSettings(token, body) {
  const response = await fetchWithRouterToken("/api/settings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }, token);
  return readSettingsJson(response);
}

async function testServerModelSettings(token, body) {
  const response = await fetchWithRouterToken("/api/settings/test-model", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }, token);
  return readSettingsJson(response);
}

async function fetchWithRouterToken(path, options = {}, token = "") {
  let routerToken = token || await getRouterToken();
  let response = await fetch(`${ROUTER_ENDPOINT}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${routerToken}`
    }
  });
  if (response.status === 401) {
    await chrome.storage.sync.remove(["routerToken"]);
    routerToken = await bootstrapRouterToken();
    response = await fetch(`${ROUTER_ENDPOINT}${path}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${routerToken}`
      }
    });
  }
  return response;
}

async function getRouterToken() {
  const defaultToken = typeof DEFAULT_ROUTER_TOKEN === "string" ? DEFAULT_ROUTER_TOKEN : "";
  const { routerToken } = await chrome.storage.sync.get({ routerToken: defaultToken || "" });
  if (routerToken) return routerToken;
  return bootstrapRouterToken();
}

async function bootstrapRouterToken() {
  const response = await fetch(`${ROUTER_ENDPOINT}/bootstrap`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.routerToken) {
    throw new Error(data.error || `Router bootstrap returned ${response.status}`);
  }
  await chrome.storage.sync.set({ routerToken: data.routerToken });
  return data.routerToken;
}

async function readSettingsJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Router returned ${response.status}`);
  return data;
}
