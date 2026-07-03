import { confirmTaskBear, confirmTaskEagle, confirmTaskObsidian, createTask, getTask, runTask } from "./queue.js";
import { listEagleFolders } from "./adapters/eagle.js";
import { envFilePath } from "./utils/env.js";
import { testProviderSettings } from "./utils/provider.js";
import { normalizeSourceUrl } from "./utils/webpage.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

export function createRouter(env) {
  return async function router(req, res) {
    const origin = req.headers.origin || "";
    const headers = corsHeaders(env, origin);

    if (req.method === "OPTIONS") {
      send(res, 204, "", headers);
      return;
    }

    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true }, headers);
        return;
      }

      if (req.method === "GET" && url.pathname === "/bootstrap") {
        if (!isExtensionOrigin(origin)) {
          sendJson(res, 403, { error: "Bootstrap is only available to browser extensions" }, headers);
          return;
        }
        sendJson(res, 200, { routerToken: env.LOCAL_CLIP_ROUTER_TOKEN }, headers);
        return;
      }

      if (url.pathname.startsWith("/api/") && url.pathname !== "/api/assets/preview") {
        requireAuth(req, env, url);
      }

      if (req.method === "GET" && url.pathname === "/api/assets/preview") {
        requireAuth(req, env, url);
        sendAssetPreview(req, res, url, headers);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/eagle/folders") {
        const folders = await listEagleFolders();
        sendJson(res, 200, { folders }, headers);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/settings") {
        sendJson(res, 200, getPublicSettings(env), headers);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/settings") {
        const body = await readJson(req);
        const nextEnv = updateSettings(body, env);
        Object.assign(env, nextEnv);
        sendJson(res, 200, getPublicSettings(env), headers);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/settings/test-model") {
        const result = await testProviderSettings(await readJson(req));
        sendJson(res, 200, result, headers);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/clip") {
        const payload = validatePayload(await readJson(req));
        const task = await createTask(payload);
        runTask(task).catch((error) => {
          console.error("Task failed outside request lifecycle", error);
        });

        sendJson(res, 202, {
          taskId: task.id,
          status: task.status,
          targets: Object.fromEntries(payload.targets.map((target) => [target, "queued"]))
        }, headers);
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (req.method === "GET" && taskMatch) {
        const task = await getTask(taskMatch[1]);
        if (!task) {
          sendJson(res, 404, { error: "Task not found" }, headers);
          return;
        }

        sendJson(res, 200, task, headers);
        return;
      }

      const bearConfirmMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/confirm-bear$/);
      if (req.method === "POST" && bearConfirmMatch) {
        const body = await readJson(req);
        const task = await confirmTaskBear(bearConfirmMatch[1], {
          draft: body.draft,
          includeScreenshot: body.includeScreenshot !== false,
          candidateIds: normalizeCandidateIds(body)
        });
        if (!task) {
          sendJson(res, 404, { error: "Task not found" }, headers);
          return;
        }

        sendJson(res, 200, task, headers);
        return;
      }

      const eagleConfirmMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/confirm-eagle$/);
      if (req.method === "POST" && eagleConfirmMatch) {
        const body = await readJson(req);
        const task = await confirmTaskEagle(eagleConfirmMatch[1], {
          folderIds: Array.isArray(body.folderIds)
            ? body.folderIds.filter((id) => typeof id === "string")
            : [body.folderId].filter((id) => typeof id === "string"),
          candidateIds: normalizeCandidateIds(body)
        });
        if (!task) {
          sendJson(res, 404, { error: "Task not found" }, headers);
          return;
        }

        sendJson(res, 200, task, headers);
        return;
      }

      const obsidianConfirmMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/confirm-obsidian$/);
      if (req.method === "POST" && obsidianConfirmMatch) {
        const task = await confirmTaskObsidian(obsidianConfirmMatch[1]);
        if (!task) {
          sendJson(res, 404, { error: "Task not found" }, headers);
          return;
        }

        sendJson(res, 200, task, headers);
        return;
      }

      sendJson(res, 404, { error: "Not found" }, headers);
    } catch (error) {
      const status = error.statusCode || 500;
      sendJson(res, status, { error: error.message || "Internal server error" }, headers);
    }
  };
}

function normalizeCandidateIds(body = {}) {
  const value = body.candidateIds ?? body.candidateId;
  return (Array.isArray(value) ? value : [value]).filter((id) => typeof id === "string" && id.length > 0);
}

export const __testHooks = { normalizeCandidateIds };

function corsHeaders(env, origin) {
  const allowed = env.CLIP_ROUTER_ALLOWED_EXTENSION_ID || "*";
  const allowOrigin =
    allowed === "*" || origin === `chrome-extension://${allowed}`
      ? origin || "*"
      : "null";

  return {
    ...JSON_HEADERS,
    "Access-Control-Allow-Origin": allowOrigin
  };
}

function isExtensionOrigin(origin) {
  return /^chrome-extension:\/\/[a-z]{32}$/i.test(origin);
}

function requireAuth(req, env, url = null) {
  const expected = env.LOCAL_CLIP_ROUTER_TOKEN;
  if (!expected || expected === "change-me-local-token") {
    const error = new Error("LOCAL_CLIP_ROUTER_TOKEN is not configured");
    error.statusCode = 500;
    throw error;
  }

  const header = req.headers.authorization || "";
  const queryToken = url?.searchParams?.get("token") || "";
  if (header !== `Bearer ${expected}` && queryToken !== expected) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

function sendAssetPreview(req, res, url, cors) {
  const filePath = path.resolve(url.searchParams.get("path") || "");
  if (!isAllowedPreviewPath(filePath) || !fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "Preview asset not found" }, cors);
    return;
  }

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  const contentType = contentTypeForPath(filePath);
  const baseHeaders = {
    ...cors,
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  };

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
      res.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...baseHeaders,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${stat.size}`
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...baseHeaders, "Content-Length": String(stat.size) });
  fs.createReadStream(filePath).pipe(res);
}

function isAllowedPreviewPath(filePath) {
  const tempRoot = path.resolve(os.tmpdir());
  const assetsRoot = path.resolve(os.tmpdir(), "chrome-clip-router-assets");
  return filePath.startsWith(`${assetsRoot}${path.sep}`)
    || (filePath.startsWith(`${tempRoot}${path.sep}`) && path.basename(filePath).startsWith("clip-router-eagle-"));
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function validatePayload(payload) {
  const allowedTargets = new Set(["eagle", "bear", "obsidian"]);
  if (!payload || typeof payload !== "object") {
    throw badRequest("Payload must be an object");
  }
  if (!payload.url || typeof payload.url !== "string") {
    throw badRequest("Payload url is required");
  }
  if (!Array.isArray(payload.targets) || payload.targets.length === 0) {
    throw badRequest("At least one target is required");
  }

  const targets = [...new Set(payload.targets)].filter((target) => allowedTargets.has(target));
  if (!targets.length) {
    throw badRequest("Targets must include eagle, bear, or obsidian");
  }

  return {
    source: payload.source || "chrome-extension",
    captureUrl: payload.url,
    url: normalizeSourceUrl(payload.url),
    title: payload.title || payload.url,
    selectedText: payload.selectedText || "",
    userNote: payload.userNote || "",
    targets,
    options: payload.options || {},
    pageMeta: sanitizeObject(payload.pageMeta),
    pageAssets: sanitizePageAssets(payload.pageAssets),
    pageContent: sanitizePageContent(payload.pageContent),
    screenshotDataUrl: typeof payload.screenshotDataUrl === "string" ? payload.screenshotDataUrl : "",
    capturedAt: payload.capturedAt || new Date().toISOString()
  };
}

function sanitizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sanitizePageAssets(value) {
  const assets = sanitizeObject(value);
  return {
    images: Array.isArray(assets.images) ? assets.images.slice(0, 20) : [],
    videos: Array.isArray(assets.videos) ? assets.videos.slice(0, 10) : [],
    videoRects: Array.isArray(assets.videoRects) ? assets.videoRects.slice(0, 5) : [],
    viewport: sanitizeObject(assets.viewport)
  };
}

function sanitizePageContent(value) {
  const content = sanitizeObject(value);
  return {
    text: typeof content.text === "string" ? content.text.slice(0, 60000) : "",
    markdown: typeof content.markdown === "string" ? content.markdown.slice(0, 100000) : "",
    htmlSnapshot: typeof content.htmlSnapshot === "string" ? content.htmlSnapshot.slice(0, 250000) : ""
  };
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function sendJson(res, statusCode, body, headers) {
  send(res, statusCode, JSON.stringify(body, null, 2), headers);
}

function send(res, statusCode, body, headers) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function getPublicSettings(env) {
  const llmApiKey = env.CLIP_ROUTER_LLM_API_KEY || env.CLIP_ROUTER_API_KEY || "";
  return {
    llmProvider: env.CLIP_ROUTER_LLM_PROVIDER || providerFromSettings(env),
    llmApiType: env.CLIP_ROUTER_LLM_API_TYPE || "openai-chat",
    llmBaseUrl: env.CLIP_ROUTER_LLM_BASE_URL || env.CLIP_ROUTER_BASE_URL || "",
    llmModel: env.CLIP_ROUTER_LLM_MODEL || env.CLIP_ROUTER_MODEL || "",
    llmApiKeyConfigured: Boolean(llmApiKey),
    llmApiKeyMasked: maskSecret(llmApiKey),
    bearNoteId: formatBearNoteLink(env.CLIP_ROUTER_BEAR_NOTE_ID || ""),
    obsidianClipPath: sanitizeSetting(env.CLIP_ROUTER_OBSIDIAN_CLIP_PATH || "")
  };
}

function updateSettings(body, env) {
  const patch = {
    CLIP_ROUTER_LLM_PROVIDER: sanitizeSetting(body.llmProvider || providerFromSettings(env) || "custom"),
    CLIP_ROUTER_LLM_API_TYPE: sanitizeSetting(body.llmApiType || "openai-chat"),
    CLIP_ROUTER_LLM_BASE_URL: sanitizeSetting(body.llmBaseUrl),
    CLIP_ROUTER_LLM_MODEL: sanitizeSetting(body.llmModel),
    CLIP_ROUTER_BEAR_NOTE_ID: formatBearNoteLink(body.bearNoteId),
    CLIP_ROUTER_OBSIDIAN_CLIP_PATH: sanitizeSetting(body.obsidianClipPath)
  };
  if (typeof body.llmApiKey === "string" && body.llmApiKey.trim() && !isMaskedSecret(body.llmApiKey)) {
    patch.CLIP_ROUTER_LLM_API_KEY = body.llmApiKey.trim();
  } else if (env.CLIP_ROUTER_LLM_API_KEY) {
    patch.CLIP_ROUTER_LLM_API_KEY = env.CLIP_ROUTER_LLM_API_KEY;
  }

  const nextEnv = { ...env, ...patch };
  writeEnvFile(nextEnv);
  return nextEnv;
}

function sanitizeSetting(value) {
  return String(value || "").trim();
}

function formatBearNoteLink(value) {
  const text = sanitizeSetting(value);
  if (!text) return "";
  if (text.startsWith("bear://")) return text;
  const idMatch = text.match(/[?&]id=([^&]+)/);
  const noteId = idMatch ? sanitizeSetting(decodeURIComponent(idMatch[1])) : text;
  return noteId ? `bear://x-callback-url/open-note?id=${encodeURIComponent(noteId)}` : "";
}

function maskSecret(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= 8) return "*".repeat(text.length);
  return `${text.slice(0, 3)}${"*".repeat(Math.max(8, text.length - 7))}${text.slice(-4)}`;
}

function isMaskedSecret(value) {
  return /\*{3,}/.test(String(value || ""));
}

function writeEnvFile(env) {
  const keys = [
    "LOCAL_CLIP_ROUTER_TOKEN",
    "CLIP_ROUTER_ALLOWED_EXTENSION_ID",
    "CLIP_ROUTER_PORT",
    "CLIP_ROUTER_LLM_PROVIDER",
    "CLIP_ROUTER_LLM_API_TYPE",
    "CLIP_ROUTER_LLM_BASE_URL",
    "CLIP_ROUTER_LLM_MODEL",
    "CLIP_ROUTER_LLM_API_KEY",
    "CLIP_ROUTER_BEAR_NOTE_ID",
    "CLIP_ROUTER_OBSIDIAN_CLIP_PATH"
  ];
  const lines = [];
  for (const key of keys) {
    if (env[key] !== undefined) lines.push(`${key}=${escapeEnvValue(env[key])}`);
  }
  fs.writeFileSync(envFilePath, `${lines.join("\n")}\n`, "utf8");
}

function providerFromSettings(env) {
  const baseUrl = String(env.CLIP_ROUTER_LLM_BASE_URL || env.CLIP_ROUTER_BASE_URL || "").toLowerCase();
  if (baseUrl.includes("api.openai.com")) return "openai";
  if (baseUrl.includes("api.anthropic.com")) return "anthropic";
  if (baseUrl.includes("generativelanguage.googleapis.com")) return "gemini";
  if (baseUrl.includes("api.deepseek.com")) return "deepseek";
  if (baseUrl.includes("api.moonshot.cn")) return "kimi";
  return baseUrl ? "custom" : "";
}

function escapeEnvValue(value) {
  const text = String(value || "");
  return /[\s#"'=]/.test(text) ? JSON.stringify(text) : text;
}
