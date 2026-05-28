import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generateClipMetadata } from "../utils/provider.js";
import { saveDataUrlAsset } from "../utils/assets.js";
import { hostnameFromUrl } from "../utils/webpage.js";
import { loadEnv } from "../utils/env.js";

const execFileAsync = promisify(execFile);
const DEFAULT_BEAR_NOTE_ID = "39D4DACD-6747-4633-88A8-3C042C4A948D";
const BEAR_DB_CANDIDATES = [
  path.join(os.homedir(), "Library", "Group Containers", "9K33E3U3T4.net.shinyfrog.bear", "Application Data", "database.sqlite"),
  path.join(os.homedir(), "Library", "Group Containers", "9K33E3U3T4.net.shinyfrog.bear", "Application Data", "Bear.sqlite"),
  path.join(os.homedir(), "Library", "Containers", "net.shinyfrog.bear", "Data", "Documents", "Application Data", "database.sqlite")
];

export async function runBearAdapter(payload) {
  const metadata = await generateClipMetadata(payload, "bear");
  const twitterGif = isTwitterUrl(payload.url)
    ? await buildTwitterGifForBear(payload, metadata).catch(() => null)
    : null;
  const screenshot = payload.screenshotDataUrl
    ? await saveDataUrlAsset(payload.screenshotDataUrl, metadata.titleZh || payload.title || "bear-screenshot", "jpg")
    : null;
  const compactScreenshot = screenshot ? await compactImageForBear(screenshot).catch(() => null) : null;
  const visualAsset = twitterGif || compactScreenshot;
  const visualPreview = visualAsset ? await buildDataUrlPreview(visualAsset).catch(() => "") : "";
  const draftParts = buildBearDraftParts(payload, metadata, visualAsset);
  const draftNoScreenshot = buildBearDraftParts(payload, metadata, null).full;
  const draft = draftParts.full;

  return {
    status: "needs_review",
    reason: "等待用户在插件内确认后再写入 Bear",
    noteId: getBearNoteId(),
    screenshot: visualAsset ? "ready" : "missing",
    screenshotFile: visualAsset,
    draft,
    draftNoScreenshot,
    draftParts,
    previewFields: buildBearPreviewFields(payload, metadata, visualAsset, visualPreview),
    metadata
  };
}

export async function confirmBearWrite(task, options = {}) {
  const normalized = typeof options === "string" ? { draft: options, includeScreenshot: true } : options;
  return withTimeout(confirmBearWriteInner(task, normalized), 25000, "Bear confirm timed out");
}

async function confirmBearWriteInner(task, options) {
  const result = task.results?.bear;
  if (!result?.draft && !options.draft) {
    throw new Error("Bear draft not found on task");
  }

  const includeScreenshot = options.includeScreenshot !== false;
  const draft = includeScreenshot
    ? (options.draft || result.draft)
    : (result.draftNoScreenshot || buildBearDraftParts(task.payload, result.metadata || {}, null).full);
  if (includeScreenshot && result.screenshotFile?.filePath) {
    const draftParts = result.draftParts || buildBearDraftParts(task.payload, result.metadata || {}, result.screenshotFile);
    await appendToBear(draftParts.beforeImage);
    await addFileToBear(result.screenshotFile.filePath, result.screenshotFile.filename);
    await wait(1400);
    await indentBearImageLine(result.screenshotFile.filename);
    await appendToBear(draftParts.afterImage);
  } else {
    await appendToBear(draft);
  }
  await wait(1800);
  const verification = await verifyBearUrl(task.payload.url, includeScreenshot ? result.screenshotFile?.filename || "" : "");
  const mediaOk = !includeScreenshot || !result.screenshotFile?.filename || verification.imageRefCount > 0;
  if (verification.count < 1 || !mediaOk) {
    return {
      ...result,
      status: "failed",
      reason: verification.count < 1 ? "Bear x-callback 已调用，但 SQLite 未验证到 URL" : "Bear 已写入 URL，但未验证到媒体引用",
      verification
    };
  }

  return {
    ...result,
    status: "success",
    reason: "Bear 写入并验证成功",
    writtenAt: new Date().toISOString(),
    verification
  };
}

function buildBearDraft(payload, metadata, screenshot) {
  return buildBearDraftParts(payload, metadata, screenshot).full;
}

function buildBearDraftParts(payload, metadata, visualAsset) {
  const title = buildTitle(payload, metadata);
  const summary = (metadata.summary || "待补充摘要。").replace(/\n/g, " ");
  const beforeImage = `* **${title}**`;
  const afterImage = [
    `  * ${summary}`,
    `  * ${payload.url}`
  ].join("\n");

  if (!visualAsset) {
    return {
      beforeImage,
      afterImage,
      full: [beforeImage, afterImage].join("\n")
    };
  }

  return {
    beforeImage,
    afterImage,
    full: [beforeImage, `  * [${visualAsset.label || "媒体"}将由 Bear 附件写入：${visualAsset.filename}]`, afterImage].join("\n")
  };
}

function buildTitle(payload, metadata) {
  const title = metadata.titleZh || payload.title?.trim() || hostnameFromUrl(payload.url);
  const oneLine = metadata.oneLine || "阅读笔记摘录";
  return `${title} — ${oneLine}`.replace(/\s+/g, " ").trim();
}

function buildBearPreviewFields(payload, metadata, visualAsset, visualPreview) {
  const visualLabel = visualAsset?.kind === "gif" ? "动图" : "截图";
  return [
    { label: "标题", value: buildTitle(payload, metadata), kind: "text" },
    {
      label: visualLabel,
      value: visualAsset?.filename || (isTwitterUrl(payload.url) ? "未识别到可转换的 X 视频，确认时会使用截图或纯文本" : "截图未捕获或压缩后仍过大"),
      kind: visualAsset?.filePath ? "image" : "text",
      src: visualAsset?.filePath || "",
      dataUrl: visualPreview
    },
    { label: "描述", value: metadata.summary.replace(/\n/g, " "), kind: "longtext" },
    { label: "链接", value: payload.url, kind: "url" }
  ];
}

async function buildDataUrlPreview(asset) {
  const base64 = await fs.readFile(asset.filePath, "base64");
  return `data:${asset.mimeType || "image/jpeg"};base64,${base64}`;
}

async function appendToBear(markdown) {
  const noteId = getBearNoteId();
  const callback = new URL("bear://x-callback-url/add-text");
  const url = [
    callback.toString(),
    `?id=${encodeURIComponent(noteId)}`,
    "&mode=append",
    `&text=${encodeURIComponent(`\n${markdown}\n`)}`
  ].join("");
  await openBearUrl(url, 5000);
  await revealBear();
}

async function addFileToBear(filePath, filename) {
  const noteId = getBearNoteId();
  const base64 = await fs.readFile(filePath, "base64");
  const callback = new URL("bear://x-callback-url/add-file");
  const url = [
    callback.toString(),
    `?id=${encodeURIComponent(noteId)}`,
    "&mode=append",
    `&file=${encodeURIComponent(base64)}`,
    `&filename=${encodeURIComponent(filename)}`
  ].join("");
  await openBearUrl(url, 8000);
}

async function indentBearImageLine(filename) {
  const noteText = await readBearNoteText();
  const normalized = noteText
    .split(/\r?\n/)
    .map((line) => {
      if (line.includes(`](${filename})`) && !line.trimStart().startsWith("*")) {
        return `  * ${line.trim()}`;
      }
      return line;
    })
    .join("\n");
  if (normalized !== noteText) await replaceBearText(normalized);
}

async function replaceBearText(markdown) {
  const noteId = getBearNoteId();
  const callback = new URL("bear://x-callback-url/add-text");
  const url = [
    callback.toString(),
    `?id=${encodeURIComponent(noteId)}`,
    "&mode=replace_all",
    `&text=${encodeURIComponent(markdown)}`
  ].join("");
  await openBearUrl(url, 8000);
  await revealBear();
}

async function openBearUrl(url, timeout) {
  if (url.length < 60000) {
    await execFileAsync("open", [url], { timeout });
    return;
  }

  const urlPath = path.join(os.tmpdir(), "tiantianquan-assets", `${Date.now()}-bear-url.txt`);
  await fs.mkdir(path.dirname(urlPath), { recursive: true });
  await fs.writeFile(urlPath, url, "utf8");
  const script = [
    `set callbackUrl to read POSIX file "${escapeAppleScriptPath(urlPath)}" as «class utf8»`,
    "open location callbackUrl"
  ].join("\n");
  await execFileAsync("osascript", ["-e", script], { timeout });
}

async function compactImageForBear(asset) {
  if (!asset?.filePath) return null;
  const targetPath = path.join(os.tmpdir(), "tiantianquan-assets", `${Date.now()}-bear-shot.jpg`);
  await execFileAsync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "55", "-Z", "900", asset.filePath, "--out", targetPath], { timeout: 10000 });
  const stat = await fs.stat(targetPath);
  if (stat.size > 280000) return null;
  return {
    ...asset,
    filePath: targetPath,
    filename: `clip-router-shot-${Date.now()}.jpg`,
    mimeType: "image/jpeg",
    size: stat.size
  };
}

async function buildTwitterGifForBear(payload, metadata) {
  const media = await downloadTwitterVideo(payload.url, metadata);
  const gif = await convertVideoToGif(media.filePath, metadata);
  return {
    ...gif,
    kind: "gif",
    label: "GIF",
    sourceVideo: media.filePath
  };
}

async function downloadTwitterVideo(url, metadata) {
  const outputTemplate = path.join(os.tmpdir(), `clip-router-bear-${Date.now()}-${safeShellName(metadata.titleZh || "twitter-video")}.%(ext)s`);
  const args = [
    "--no-playlist",
    "--merge-output-format",
    "mp4",
    "-f",
    "bv*+ba/b",
    "-o",
    outputTemplate,
    "--print",
    "after_move:filepath",
    url
  ];
  const { stdout } = await execFileAsync("yt-dlp", args, { timeout: 120000, maxBuffer: 1024 * 1024 * 2 });
  const filePath = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!filePath) throw new Error("yt-dlp 未返回 X 视频路径");
  return { filePath, filename: path.basename(filePath) };
}

async function convertVideoToGif(videoPath, metadata) {
  const dir = path.join(os.tmpdir(), "tiantianquan-assets");
  await fs.mkdir(dir, { recursive: true });
  const base = safeShellName(metadata.titleZh || "x-video");
  const palettePath = path.join(dir, `${Date.now()}-${base}-palette.png`);
  const gifPath = path.join(dir, `${Date.now()}-${base}.gif`);
  const filters = "fps=10,scale=480:-1:flags=lanczos";
  await execFileAsync("ffmpeg", [
    "-y",
    "-t", "8",
    "-i", videoPath,
    "-vf", `${filters},palettegen=max_colors=96`,
    palettePath
  ], { timeout: 30000, maxBuffer: 1024 * 1024 * 2 });
  await execFileAsync("ffmpeg", [
    "-y",
    "-t", "8",
    "-i", videoPath,
    "-i", palettePath,
    "-lavfi", `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5`,
    gifPath
  ], { timeout: 45000, maxBuffer: 1024 * 1024 * 2 });

  const stat = await fs.stat(gifPath);
  if (stat.size > 6 * 1024 * 1024) {
    throw new Error("GIF 转换后超过 Bear 写入限制");
  }
  return {
    filePath: gifPath,
    filename: `clip-router-x-video-${Date.now()}.gif`,
    mimeType: "image/gif",
    size: stat.size
  };
}

function isTwitterUrl(url) {
  const host = hostnameFromUrl(url);
  return host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com");
}

function safeShellName(value) {
  return String(value || "asset").replace(/[^\w.-]+/g, "-").slice(0, 60) || "asset";
}

async function revealBear() {
  await execFileAsync("open", ["-a", "Bear"], { timeout: 5000 }).catch(() => {});
}

async function verifyBearUrl(url, imageFilename = "") {
  const dbPath = await findBearDb();
  if (!dbPath) {
    return {
      count: -1,
      status: "unverified",
      reason: "未找到 Bear SQLite 数据库"
    };
  }

  const escaped = escapeSqlLike(url);
  const escapedImage = imageFilename ? escapeSqlLike(imageFilename) : "";
  const readableDbPath = await copyDbForRead(dbPath);
  const countSql = `SELECT COUNT(*) AS count FROM ZSFNOTE WHERE ZTEXT LIKE '%${escaped}%';`;
  const matchSql = `SELECT ZTITLE AS title, substr(ZTEXT, max(length(ZTEXT)-1000, 1), 1000) AS tail FROM ZSFNOTE WHERE ZTEXT LIKE '%${escaped}%' LIMIT 3;`;
  const imageSql = escapedImage ? `SELECT COUNT(*) AS count FROM ZSFNOTE WHERE ZTEXT LIKE '%${escapedImage}%';` : "SELECT 0 AS count;";
  const countRows = await sqliteJson(readableDbPath, countSql);
  const noteRows = await sqliteJson(readableDbPath, matchSql);
  const imageRows = await sqliteJson(readableDbPath, imageSql);
  return {
    dbPath,
    count: Number(countRows[0]?.count || 0),
    imageRefCount: Number(imageRows[0]?.count || 0),
    matches: noteRows
  };
}

async function readBearNoteText() {
  const noteId = getBearNoteId();
  const dbPath = await findBearDb();
  if (!dbPath) throw new Error("未找到 Bear SQLite 数据库");
  const readableDbPath = await copyDbForRead(dbPath);
  const rows = await sqliteJson(
    readableDbPath,
    `SELECT ZTEXT AS text FROM ZSFNOTE WHERE ZUNIQUEIDENTIFIER='${escapeSqlLike(noteId)}' LIMIT 1;`
  );
  const text = rows[0]?.text;
  if (typeof text !== "string") throw new Error("未读取到 Bear 目标笔记正文");
  return text;
}

function getBearNoteId() {
  const env = loadEnv();
  return normalizeBearNoteId(env.CLIP_ROUTER_BEAR_NOTE_ID) || DEFAULT_BEAR_NOTE_ID;
}

function normalizeBearNoteId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol === "bear:" && url.searchParams.get("id")) {
      return url.searchParams.get("id").trim();
    }
  } catch (_error) {
    // Plain Bear note identifiers are supported too.
  }
  const idMatch = text.match(/[?&]id=([^&]+)/);
  if (idMatch) return decodeURIComponent(idMatch[1]).trim();
  return text;
}

async function copyDbForRead(dbPath) {
  const tmpPath = path.join(os.tmpdir(), `clip-router-bear-${Date.now()}.sqlite`);
  await fs.copyFile(dbPath, tmpPath);
  return tmpPath;
}

async function sqliteJson(dbPath, sql) {
  const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], { timeout: 5000 });
  return JSON.parse(stdout.trim() || "[]");
}

async function findBearDb() {
  for (const candidate of BEAR_DB_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (_error) {
      // try next candidate
    }
  }

  const groupRoot = path.join(os.homedir(), "Library", "Group Containers", "9K33E3U3T4.net.shinyfrog.bear");
  try {
    const matches = await findSqliteFiles(groupRoot, 4);
    return matches[0] || null;
  } catch (_error) {
    return null;
  }
}

async function findSqliteFiles(root, depth) {
  if (depth < 0) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findSqliteFiles(fullPath, depth - 1));
    } else if (/\.sqlite$|\.db$/i.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

function escapeSqlLike(value) {
  return String(value).replaceAll("'", "''");
}

function escapeAppleScriptPath(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
