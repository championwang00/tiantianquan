import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateClipMetadata } from "../utils/provider.js";
import { hostnameFromUrl, safeFileName } from "../utils/webpage.js";
import { getJournalDate } from "../utils/time.js";
import { articleHtmlToMarkdown, extractArticleImageUrls } from "../utils/article.js";

const DEFAULT_VAULT = path.join(
  os.homedir(),
  "Library",
  "Mobile Documents",
  "iCloud~md~obsidian",
  "Documents"
);
const DEFAULT_CLIP_FOLDER = path.join("mynote", "Clippings");
const OBSIDIAN_APP_CONFIG = path.join(os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json");

export async function runObsidianAdapter(payload) {
  const config = await getObsidianConfig();
  const metadata = await buildMetadata(payload);
  const writePlan = buildWritePlan(payload, config, metadata);

  return {
    status: "needs_review",
    reason: "等待用户确认后再写入 Obsidian",
    targetMode: writePlan.mode,
    path: writePlan.filePath,
    metadata,
    propertiesTypes: loadPropertiesTypes(),
    preview: writePlan.markdown.slice(0, 4000),
    previewFields: buildObsidianPreviewFields(payload, metadata, writePlan),
    writePlan
  };
}

export async function confirmObsidianWrite(task) {
  const result = task.results?.obsidian;
  if (!result?.writePlan) {
    throw new Error("Obsidian write plan not found on task");
  }

  const { writePlan } = result;
  await fs.mkdir(path.dirname(writePlan.filePath), { recursive: true });
  if (await pathExists(writePlan.filePath)) {
    const existing = await verifyObsidianFile(writePlan.filePath, task.payload.url);
    if (!existing.ok) {
      const filePath = await uniqueFilePath(writePlan.filePath);
      writePlan.filePath = filePath;
      writePlan.markdown = await localizeMarkdownImages({
        markdown: writePlan.markdown,
        noteFilePath: filePath,
        fetchImpl: globalThis.fetch
      });
      await fs.writeFile(filePath, writePlan.markdown, "utf8");
    }
  } else {
    writePlan.markdown = await localizeMarkdownImages({
      markdown: writePlan.markdown,
      noteFilePath: writePlan.filePath,
      fetchImpl: globalThis.fetch
    });
    await fs.writeFile(writePlan.filePath, writePlan.markdown, "utf8");
  }

  const written = await verifyObsidianFile(writePlan.filePath, task.payload.url);
  if (written.ok && writePlan.reveal !== false) {
    const currentConfig = await getObsidianConfig();
    const revealVaultPath = resolveObsidianRevealVaultPath(
      writePlan.filePath,
      currentConfig.vaultPath,
      writePlan.vaultPath
    );
    await revealObsidianFile(writePlan.filePath, revealVaultPath);
  }
  return {
    ...result,
    status: written.ok ? "success" : "failed",
    reason: written.ok ? "Obsidian 写入并验证成功" : written.reason,
    writtenAt: new Date().toISOString(),
    verification: written
  };
}

export function buildWritePlan(payload, config, metadata, _requestedMode = "clip") {
  const filename = `${safeFileName(metadata.canonicalName)}.md`;
  const filePath = path.join(config.vaultPath, config.clipFolder, filename);
  const markdown = buildStandaloneMarkdown(payload, metadata);

  return {
    mode: "clip",
    vaultPath: config.vaultPath,
    vaultName: config.vaultName,
    filePath,
    markdown,
    inheritedClipFolder: config.clipFolder
  };
}

async function uniqueFilePath(filePath) {
  if (!(await pathExists(filePath))) return filePath;
  const parsed = path.parse(filePath);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${Date.now()}-${index}${parsed.ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  return path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
}

function buildStandaloneMarkdown(payload, metadata) {
  const tags = metadata.tags.map((tag) => `  - ${tag}`).join("\n");
  const authors = metadata.author.values.map((author) => `  - ${author}`).join("\n");
  const originalText = payload.pageContent?.articleHtml
    ? articleHtmlToMarkdown(payload.pageContent.articleHtml, payload.url)
    : getPreferredOriginalText(payload);
  return [
    "---",
    `title: ${yamlString(metadata.titleZh)}`,
    `source: ${yamlString(payload.url)}`,
    "author:",
    authors,
    `published: ${payload.pageMeta?.published || metadata.published || ""}`,
    `created: ${getJournalDate(payload.capturedAt)}`,
    `description: ${yamlString(metadata.summary)}`,
    "tags:",
    tags,
    "---",
    "",
    originalText || payload.selectedText || payload.pageMeta?.description || metadata.summary,
    payload.selectedText && originalText !== payload.selectedText ? ["", "## 摘录", "", payload.selectedText].join("\n") : "",
    payload.userNote ? ["", "## 备注", "", payload.userNote].join("\n") : ""
  ].filter(Boolean).join("\n");
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function localizeMarkdownImages({ markdown, noteFilePath, fetchImpl = globalThis.fetch }) {
  const source = String(markdown || "");
  const urls = extractArticleImageUrls(source);
  if (!urls.length || typeof fetchImpl !== "function") return source;

  const note = path.parse(noteFilePath);
  const assetDir = path.join(note.dir, "assets", safeFileName(note.name));
  const replacements = new Map();
  const usedNames = new Set();
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (!response?.ok) throw new Error(`HTTP ${response?.status || "error"}`);
      const declaredSize = Number(response.headers?.get("content-length") || 0);
      if (declaredSize > MAX_IMAGE_BYTES) throw new Error("image too large");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image too large");
      const extension = imageExtension(response.headers?.get("content-type"), url);
      const urlPath = new URL(url).pathname;
      let stem = safeFileName(path.basename(urlPath, path.extname(urlPath)) || "image")
        .replace(/[^\p{L}\p{N}_-]+/gu, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
      if (!stem) stem = "image";
      let fileName = `${stem}${extension}`;
      for (let suffix = 2; usedNames.has(fileName); suffix += 1) fileName = `${stem}-${suffix}${extension}`;
      usedNames.add(fileName);
      await fs.mkdir(assetDir, { recursive: true });
      await fs.writeFile(path.join(assetDir, fileName), bytes);
      replacements.set(url, path.posix.join("assets", safeFileName(note.name), fileName));
    } catch (_error) {
      // A failed image must not prevent the note itself from being saved.
    }
  }
  return replaceImageDestinations(source, replacements);
}

function imageExtension(contentType, url) {
  const type = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  const byType = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg", "image/avif": ".avif" };
  if (byType[type]) return byType[type];
  const candidate = path.extname(new URL(url).pathname).toLowerCase();
  return /^\.(?:jpe?g|png|gif|webp|svg|avif)$/.test(candidate) ? (candidate === ".jpeg" ? ".jpg" : candidate) : ".img";
}

function replaceImageDestinations(markdown, replacements) {
  return markdown.replace(/(!\[[^\n]*?\]\()(<[^>]+>|(?:\\.|[^)])*(?:\((?:\\.|[^)])*\)(?:\\.|[^)])*)?)(\))/g, (match, prefix, destination, close) => {
    const raw = destination?.startsWith("<") ? destination.slice(1, -1) : destination;
    const replacement = replacements.get(raw);
    return replacement ? `${prefix}${replacement}${close}` : match;
  });
}

function buildObsidianPreviewFields(payload, metadata, writePlan) {
  const body = getPreferredOriginalText(payload);
  return [
    { label: "title", value: metadata.titleZh, kind: "text" },
    { label: "source", value: payload.url, kind: "url" },
    { label: "author", value: metadata.author.values, kind: "tags" },
    { label: "published", value: payload.pageMeta?.published || metadata.published || "", kind: "text" },
    { label: "created", value: getJournalDate(payload.capturedAt), kind: "text" },
    { label: "description", value: metadata.summary, kind: "longtext" },
    { label: "tags", value: metadata.tags, kind: "tags" },
    { label: "正文", value: body || "未读取到页面正文，将写入页面描述或摘要作为兜底内容。", kind: "markdown" }
  ];
}

async function buildMetadata(payload) {
  const generated = await generateClipMetadata(payload, "obsidian");
  const host = hostnameFromUrl(payload.url);
  const originalTitle = payload.title || host;
  const text = `${payload.title} ${payload.url} ${payload.selectedText} ${payload.userNote}`.toLowerCase();
  const contentType = generated.contentType || inferContentType(text);
  const titleZh = generated.titleZh || `${originalTitle} — ${contentTypeLabel(contentType)}`;
  const tags = normalizeTags(generated.tags?.length ? generated.tags : inferTags(text, contentType));
  const summary = generated.summary || "待补充摘要。";
  const author = payload.pageMeta?.author || host;

  return {
    originalTitle,
    titleZh,
    canonicalName: titleZh,
    author: {
      name: author,
      type: "publication",
      normalized: author,
      values: [author]
    },
    siteName: payload.pageMeta?.siteName || host,
    contentType,
    targetMode: "clip",
    tags,
    summary,
    keyPoints: buildKeyPoints(payload, contentType, generated),
    whySaved: generated.whySaved || payload.userNote || "这条链接可能对之后的设计、产品、写作或研究判断有参考价值。",
    relatedTopics: tags
  };
}

function inferContentType(text) {
  if (text.includes("github") || text.includes("docs") || text.includes("documentation")) return "documentation";
  if (text.includes("tool") || text.includes("app") || text.includes("软件") || text.includes("工具")) return "tool";
  if (text.includes("portfolio") || text.includes("studio") || text.includes("designer")) return "portfolio";
  if (text.includes("tweet") || text.includes("x.com") || text.includes("twitter")) return "tweet";
  if (text.includes("video") || text.includes("youtube") || text.includes("bilibili")) return "video";
  if (text.includes("想") || text.includes("感觉") || text.includes("方法")) return "thought";
  return "article";
}

function contentTypeLabel(type) {
  const labels = {
    article: "文章摘录",
    tool: "工具资料",
    design_reference: "设计参考",
    thought: "思考笔记",
    video: "视频资料",
    tweet: "社媒摘录",
    portfolio: "作品集参考",
    documentation: "文档资料",
    unknown: "网页摘录"
  };
  return labels[type] || labels.unknown;
}

function inferTags(text, contentType) {
  const tags = new Set(["网页摘录", contentTypeLabel(contentType)]);
  if (text.includes("ai") || text.includes("人工智能")) tags.add("AI");
  if (text.includes("design") || text.includes("ui") || text.includes("设计")) tags.add("设计");
  if (text.includes("product") || text.includes("产品")) tags.add("产品");
  if (text.includes("writing") || text.includes("写作")) tags.add("写作");
  return [...tags].slice(0, 6);
}

function buildKeyPoints(payload, contentType, generated) {
  const points = [`类型判断：${contentTypeLabel(contentType)}`];
  if (generated.oneLine) points.push(generated.oneLine);
  if (payload.selectedText) points.push("用户保存时带有选中文字，需要优先保留原文上下文。");
  if (payload.userNote) points.push("用户保存时写了备注，说明这条内容有明确的个人用途。");
  return points;
}

async function getObsidianConfig() {
  const env = await import("../utils/env.js").then((mod) => mod.loadEnv());
  const configuredPath = String(env.CLIP_ROUTER_OBSIDIAN_CLIP_PATH || "").trim();
  return resolveObsidianConfigPaths({
    configuredPath,
    defaultVault: DEFAULT_VAULT,
    vaults: await readRegisteredObsidianVaults(),
    source: configuredPath ? "settings" : "default"
  });
}

export function resolveObsidianConfigPaths({
  configuredPath = "",
  defaultVault = DEFAULT_VAULT,
  vaultRoots = [],
  vaults = [],
  source = configuredPath ? "settings" : "default"
} = {}) {
  const clipPath = path.resolve(configuredPath || path.join(defaultVault, DEFAULT_CLIP_FOLDER));
  const normalizedVaults = normalizeObsidianVaults(vaults, vaultRoots, defaultVault)
    .sort((a, b) => b.path.length - a.path.length);
  const matchedVault = normalizedVaults.find((vault) => isPathInsideOrEqual(clipPath, vault.path));
  const vaultPath = matchedVault?.path
    || inferVaultPathFromClipPath(clipPath);
  const relativeFolder = path.relative(vaultPath, clipPath);
  const clipFolder = relativeFolder && !relativeFolder.startsWith("..")
    ? relativeFolder
    : "Clippings";
  return {
    vaultPath,
    vaultName: matchedVault?.name || path.basename(vaultPath),
    clipFolder,
    clipPath,
    source
  };
}

function inferVaultPathFromClipPath(clipPath) {
  return path.basename(clipPath).toLowerCase() === "clippings" ? path.dirname(clipPath) : clipPath;
}

async function readRegisteredObsidianVaults() {
  try {
    const raw = await fs.readFile(OBSIDIAN_APP_CONFIG, "utf8");
    const config = JSON.parse(raw);
    return Object.entries(config.vaults || {})
      .map(([id, vault]) => ({
        id,
        name: String(vault?.name || id || "").trim(),
        path: String(vault?.path || "").trim()
      }))
      .filter((vault) => vault.path);
  } catch (_error) {
    return [];
  }
}

function normalizeObsidianVaults(vaults, vaultRoots, defaultVault) {
  const normalized = [];
  for (const vault of vaults) {
    const vaultPath = typeof vault === "string" ? vault : vault?.path;
    if (!vaultPath) continue;
    normalized.push({
      name: typeof vault === "string" ? path.basename(vaultPath) : vault.name || vault.id || path.basename(vaultPath),
      path: path.resolve(vaultPath)
    });
  }
  for (const root of vaultRoots) {
    if (root) normalized.push({ name: path.basename(root), path: path.resolve(root) });
  }
  if (defaultVault) normalized.push({ name: path.basename(defaultVault), path: path.resolve(defaultVault) });
  const seen = new Set();
  return normalized.filter((vault) => {
    if (seen.has(vault.path)) return false;
    seen.add(vault.path);
    return true;
  });
}

function isPathInsideOrEqual(filePath, maybeParent) {
  const relative = path.relative(maybeParent, filePath);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function loadPropertiesTypes() {
  return {
    title: "text",
    source: "text",
    author: "multitext",
    published: "date",
    created: "date",
    description: "text",
    tags: "multitext"
  };
}

function normalizeOriginalText(value) {
  return String(value || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 30000);
}

function getPreferredOriginalText(payload) {
  const text = normalizeOriginalText(payload.pageContent?.text || "");
  const markdown = normalizeOriginalText(payload.pageContent?.markdown || "");
  const selected = normalizeOriginalText(payload.selectedText || "");
  const description = normalizeOriginalText(payload.pageMeta?.description || "");

  if (looksTranslatedChinese(text, markdown)) return text;
  if (markdown) return markdown;
  return text || selected || description || "";
}

function looksTranslatedChinese(text, markdown) {
  if (!text) return false;
  const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (chineseCount < 12) return false;
  const markdownChineseCount = (markdown.match(/[\u4e00-\u9fff]/g) || []).length;
  if (!markdown) return true;
  return chineseCount > markdownChineseCount * 1.25 || chineseCount > 80;
}

function normalizeTags(tags) {
  return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 8);
}

function yamlString(value) {
  return JSON.stringify(String(value || ""));
}

async function verifyObsidianFile(filePath, url) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const required = ["title:", "source:", "author:", "published:", "created:", "description:", "tags:"];
    const missing = required.filter((field) => !content.includes(field));
    if (!content.includes(url)) return { ok: false, reason: "文件中未找到 source URL", filePath };
    if (missing.length) return { ok: false, reason: `缺少 properties: ${missing.join(", ")}`, filePath };
    return { ok: true, filePath, size: content.length };
  } catch (error) {
    return { ok: false, reason: error.message, filePath };
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

export function buildObsidianOpenUrl(filePath, vaultPath) {
  const relativePath = path.relative(vaultPath, filePath).split(path.sep).join("/");
  return `obsidian://open?vault=${encodeURIComponent(path.basename(vaultPath))}&file=${encodeURIComponent(relativePath)}`;
}

export function resolveObsidianRevealVaultPath(filePath, currentVaultPath, plannedVaultPath) {
  if (currentVaultPath && isPathInsideOrEqual(filePath, currentVaultPath)) return currentVaultPath;
  return plannedVaultPath;
}

async function revealObsidianFile(filePath, vaultPath) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const open = promisify(execFile);
  await open("open", [buildObsidianOpenUrl(filePath, vaultPath)], { timeout: 5000 }).catch(() => {});
}
