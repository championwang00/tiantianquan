const ROUTER_ENDPOINT = "http://127.0.0.1:18791";

async function getRouterConfig() {
  const defaultToken = typeof DEFAULT_ROUTER_TOKEN === "string" ? DEFAULT_ROUTER_TOKEN : "";
  const config = await chrome.storage.sync.get({
    routerToken: "",
    defaultTargets: ["eagle", "bear", "obsidian"],
    eagleCaptureMode: "screenshot",
    eagleFolderId: "",
    eagleFolderIds: [],
    bearNoScreenshot: false,
    obsidianMode: "auto"
  });

  if (!config.routerToken && defaultToken) {
    config.routerToken = defaultToken;
  }

  if (!config.routerToken) {
    config.routerToken = await bootstrapRouterToken();
  }

  return config;
}

async function sendClip(payload) {
  const config = await getRouterConfig();
  const response = await fetchRouter("/api/clip", config, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  return readRouterJson(response);
}

async function getTask(taskId) {
  const config = await getRouterConfig();
  const response = await fetchRouter(`/api/tasks/${encodeURIComponent(taskId)}`, config);

  return readRouterJson(response);
}

async function getEagleFolders() {
  const config = await getRouterConfig();
  const response = await fetchRouter("/api/eagle/folders", config);
  return readRouterJson(response);
}

async function confirmEagle(taskId, folderIds = [], candidateIds = []) {
  return confirmTarget(taskId, "eagle", { folderIds, candidateIds });
}

async function confirmBear(taskId, draft, includeScreenshot = true) {
  return confirmTarget(taskId, "bear", { draft, includeScreenshot });
}

async function confirmObsidian(taskId) {
  return confirmTarget(taskId, "obsidian", {});
}

async function confirmTarget(taskId, target, body) {
  const config = await getRouterConfig();
  const response = await fetchRouter(`/api/tasks/${encodeURIComponent(taskId)}/confirm-${target}`, config, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  return readRouterJson(response);
}

async function fetchRouter(path, config, options = {}) {
  try {
    let response = await fetch(`${ROUTER_ENDPOINT}${path}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${config.routerToken}`
      }
    });
    if (response.status === 401) {
      config.routerToken = await bootstrapRouterToken();
      response = await fetch(`${ROUTER_ENDPOINT}${path}`, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${config.routerToken}`
        }
      });
    }
    return response;
  } catch (error) {
    throw new Error(`无法连接本地采集服务。请先在 server 目录运行 npm run dev。原始错误：${error.message}`);
  }
}

async function bootstrapRouterToken() {
  try {
    const response = await fetch(`${ROUTER_ENDPOINT}/bootstrap`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.routerToken) {
      throw new Error(data.error || `Router bootstrap returned ${response.status}`);
    }
    await chrome.storage.sync.set({ routerToken: data.routerToken });
    return data.routerToken;
  } catch (error) {
    throw new Error(`无法自动连接本地采集服务。请先在 server 目录运行 npm run dev。原始错误：${error.message}`);
  }
}

async function readRouterJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Router returned ${response.status}`);
  }
  return data;
}
