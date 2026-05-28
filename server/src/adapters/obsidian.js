import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateClipMetadata } from "../utils/provider.js";
import { hostnameFromUrl, safeFileName } from "../utils/webpage.js";
import { formatShanghaiTime, getJournalDate } from "../utils/time.js";

const DEFAULT_VAULT = path.join(
  os.homedir(),
  "Library",
  "Mobile Documents",
  "iCloud~md~obsidian",
  "Documents",
  "mynote"
);

export async function runObsidianAdapter(payload) {
  const config = await getObsidianConfig();
  const metadata = await buildMetadata(payload);
  const requestedMode = payload.options?.obsidian?.mode || "auto";
  const targetMode = requestedMode === "auto" ? decideMode(payload, metadata) : requestedMode;
  const writePlan = buildWritePlan(payload, config, metadata, targetMode);

  return {
    status: "needs_review",
    reason: "等待用户确认后再写入 Obsidian",
    targetMode,
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
  if (writePlan.mode === "journal") {
    await ensureJournal(writePlan.filePath, writePlan.journalDate, result.metadata.tags);
    await fs.appendFile(writePlan.filePath, `\n${writePlan.entry}\n`, "utf8");
  } else {
    await fs.mkdir(path.dirname(writePlan.filePath), { recursive: true });
    const filePath = await uniqueFilePath(writePlan.filePath);
    writePlan.filePath = filePath;
    await fs.writeFile(filePath, writePlan.markdown, "utf8");
  }

  const written = await verifyObsidianFile(writePlan.filePath, task.payload.url);
  if (written.ok) await revealObsidianFile(writePlan.filePath);
  return {
    ...result,
    status: written.ok ? "success" : "failed",
    reason: written.ok ? "Obsidian 写入并验证成功" : written.reason,
    writtenAt: new Date().toISOString(),
    verification: written
  };
}

function buildWritePlan(payload, config, metadata, targetMode) {
  if (targetMode === "journal") {
    return buildJournalPlan(payload, config, metadata);
  }
  return buildStandalonePlan(payload, config, metadata, targetMode);
}

function buildJournalPlan(payload, config, metadata) {
  const date = getJournalDate(payload.capturedAt);
  const journalPath = path.join(config.vaultPath, "journal", `${date}.md`);
  const entry = [
    `## ${formatShanghaiTime(payload.capturedAt)}`,
    "",
    `- [${metadata.titleZh}](${payload.url})`,
    payload.selectedText ? `- 摘录：${payload.selectedText}` : "",
    payload.userNote ? `- 备注：${payload.userNote}` : "",
    `- 摘要：${metadata.summary}`
  ].filter(Boolean).join("\n");

  return {
    mode: "journal",
    filePath: journalPath,
    journalDate: date,
    entry,
    markdown: entry
  };
}

function buildStandalonePlan(payload, config, metadata, mode) {
  const folder = mode === "thought" ? "thoughts" : config.clipFolder;
  const filename = `${safeFileName(metadata.canonicalName)}.md`;
  const filePath = path.join(config.vaultPath, folder, filename);
  const markdown = buildStandaloneMarkdown(payload, metadata, mode);

  return {
    mode,
    filePath,
    markdown,
    inheritedClipFolder: config.clipFolder
  };
}

async function ensureJournal(filePath, date, tags) {
  if (await pathExists(filePath)) return;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const frontmatterTags = ["日记", ...tags.slice(0, 4)]
    .map((tag) => `  - ${tag}`)
    .join("\n");
  const content = [
    "---",
    `date: ${date}`,
    "tags:",
    frontmatterTags,
    "---",
    "",
    `# ${date}`,
    ""
  ].join("\n");

  await fs.writeFile(filePath, content, "utf8");
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

function buildStandaloneMarkdown(payload, metadata, mode) {
  const tags = metadata.tags.map((tag) => `  - ${tag}`).join("\n");
  const authors = metadata.author.values.map((author) => `  - ${author}`).join("\n");
  const originalText = normalizeOriginalText(payload.pageContent?.markdown || payload.pageContent?.text || payload.selectedText || payload.pageMeta?.description || "");
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

function buildObsidianPreviewFields(payload, metadata, writePlan) {
  const body = normalizeOriginalText(payload.pageContent?.markdown || payload.pageContent?.text || payload.selectedText || "");
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

function decideMode(payload, metadata) {
  if (payload.userNote || payload.selectedText.length > 160) return "thought";
  if (metadata.contentType === "thought") return "thought";
  return "clip";
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
    targetMode: "auto",
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
  const vaultPath = DEFAULT_VAULT;
  return {
    vaultPath,
    clipFolder: "Clippings",
    source: "default"
  };
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

async function revealObsidianFile(filePath) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("open", ["-a", "Obsidian", filePath], { timeout: 5000 }).catch(() => {});
}
