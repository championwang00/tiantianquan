import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generateClipMetadata } from "../utils/provider.js";
import { saveDataUrlAsset } from "../utils/assets.js";
import { hostnameFromUrl } from "../utils/webpage.js";
import { loadEnv } from "../utils/env.js";
import { articleHtmlToMarkdown } from "../utils/article.js";

const execFileAsync = promisify(execFile);
const DEFAULT_BEAR_NOTE_ID = "";
const BEAR_DB_CANDIDATES = [
  path.join(os.homedir(), "Library", "Group Containers", "9K33E3U3T4.net.shinyfrog.bear", "Application Data", "database.sqlite"),
  path.join(os.homedir(), "Library", "Group Containers", "9K33E3U3T4.net.shinyfrog.bear", "Application Data", "Bear.sqlite"),
  path.join(os.homedir(), "Library", "Containers", "net.shinyfrog.bear", "Data", "Documents", "Application Data", "database.sqlite")
];

const defaultBearDependencies = {
  resolveCandidate: resolveBearCandidateAsset,
  append: appendToBear,
  addFile: addFileToBear,
  indent: indentBearImageLine,
  verify: verifyBearUrl,
  cleanup: cleanupOwnedPaths,
  wait
};
let bearDependencies = { ...defaultBearDependencies };

export function __setBearTestHooks(hooks = {}) {
  bearDependencies = { ...bearDependencies, ...hooks };
}

export function __resetBearTestHooks() {
  bearDependencies = { ...defaultBearDependencies };
}

export const __testBuildBearDraftParts = buildBearDraftParts;

export async function runBearAdapter(payload) {
  const metadata = await generateClipMetadata(payload, "bear");
  const candidates = await buildBearCandidates(payload, metadata);
  const visualAsset = summarizeCandidates(candidates).find((candidate) => candidate.selected) || null;
  const draftParts = buildBearDraftParts(payload, metadata, visualAsset);
  const draftNoScreenshot = buildBearDraftParts(payload, metadata, null).full;
  const draft = draftParts.full;

  return {
    status: "needs_review",
    reason: "等待用户在插件内确认后再写入 Bear",
    noteId: getBearNoteId(),
    screenshot: candidates.length ? "ready" : "missing",
    screenshotFile: visualAsset,
    candidates: summarizeCandidates(candidates),
    draft,
    draftNoScreenshot,
    draftParts,
    previewFields: buildBearPreviewFields(payload, metadata, candidates),
    writePlan: { metadata, candidates },
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
  const resolution = includeScreenshot ? await resolveSelectedBearAssets(task, options) : { assets: [], items: [] };
  const selectedAssets = resolution.assets;
  try {
  const draft = includeScreenshot
    ? buildBearDraftParts(task.payload, result.metadata || {}, selectedAssets).full
    : (result.draftNoScreenshot || buildBearDraftParts(task.payload, result.metadata || {}, null).full);
  if (includeScreenshot && selectedAssets.length) {
    const draftParts = buildBearDraftParts(task.payload, result.metadata || {}, selectedAssets);
    await bearDependencies.append(draftParts.beforeImage);
    for (const asset of selectedAssets) {
      const item = resolution.items.find((entry) => entry.asset === asset);
      try {
        await bearDependencies.addFile(asset.filePath, asset.filename);
        if (item) item.status = "success";
        await bearDependencies.wait(900);
        try {
          await bearDependencies.indent(asset.filename);
        } catch (error) {
          if (item) item.warnings = [...(item.warnings || []), { stage: "indent", error: error.message }];
        }
      } catch (error) {
        if (item) {
          item.status = "failed";
          item.error = error.message;
        }
      }
    }
    await bearDependencies.append(draftParts.afterImage);
  } else {
    await bearDependencies.append(draft);
  }
  await bearDependencies.wait(1800);
  const successfulAssets = resolution.items.filter((item) => item.status === "success").map((item) => item.asset);
  const verification = await bearDependencies.verify(task.payload.url, includeScreenshot ? successfulAssets.map((asset) => asset.filename) : []);
  const mediaOk = !includeScreenshot || !successfulAssets.length || verification.imageRefCount >= successfulAssets.length;
  const itemResults = resolution.items.map(({ asset: _asset, ...item }) => item);
  const succeeded = itemResults.filter((item) => item.status === "success").length;
  const failed = itemResults.filter((item) => item.status === "failed").length;
  if (verification.count < 1 || !mediaOk) {
    return {
      ...result,
      status: "failed",
      reason: verification.count < 1 ? "Bear x-callback 已调用，但 SQLite 未验证到 URL" : "Bear 已写入 URL，但未验证到媒体引用",
      verification,
      succeeded,
      failed,
      items: itemResults
    };
  }

  const total = succeeded + failed;
  const status = failed ? (succeeded ? "partial_success" : "failed") : "success";
  const reason = failed
    ? (succeeded
      ? `Bear 笔记已保存，附件 ${succeeded}/${total} 个成功，${failed} 个失败`
      : `Bear 笔记已保存，但附件 0/${total} 个成功，${failed} 个失败`)
    : "Bear 写入并验证成功";
  return {
    ...result,
    status,
    reason,
    writtenAt: new Date().toISOString(),
    screenshotFile: selectedAssets[0] || result.screenshotFile || null,
    writtenAssets: successfulAssets,
    verification,
    succeeded,
    failed,
    items: itemResults
  };
  } finally {
    const cleanupPaths = [...new Set(selectedAssets.flatMap((asset) => asset.cleanupPaths || []))];
    if (cleanupPaths.length) await bearDependencies.cleanup(cleanupPaths);
  }
}

function buildBearDraft(payload, metadata, screenshot) {
  return buildBearDraftParts(payload, metadata, screenshot).full;
}

function buildBearDraftParts(payload, metadata, visualAsset) {
  const title = buildTitle(payload, metadata);
  const summary = escapeBearText(metadata.summary || "待补充摘要。");
  const beforeImage = `* **${title}**`;
  const article = payload.pageContent?.articleHtml
    ? articleHtmlToMarkdown(payload.pageContent.articleHtml, payload.url)
    : String(payload.pageContent?.markdown || "").trim();
  const description = escapeBearText(payload.pageMeta?.description || payload.description || "");
  const afterImage = [
    article ? indentDraftBlock(article) : "",
    description ? `  * ${description}` : "",
    `  * ${summary}`,
    `  * ${payload.url}`
  ].filter(Boolean).join("\n");
  const assets = Array.isArray(visualAsset) ? visualAsset : [visualAsset].filter(Boolean);

  if (!assets.length) {
    return {
      beforeImage,
      afterImage,
      full: [beforeImage, afterImage].join("\n")
    };
  }

  return {
    beforeImage,
    afterImage,
    full: [
      beforeImage,
      ...assets.map((asset) => `  * [${escapeBearText(asset.label || "媒体")}将由 Bear 附件写入：${escapeBearText(asset.filename)}]`),
      afterImage
    ].join("\n")
  };
}

function indentDraftBlock(markdown) {
  return String(markdown).split(/\r?\n/).map((line) => line ? `  ${line}` : "  ").join("\n");
}

function buildTitle(payload, metadata) {
  const title = metadata.titleZh || payload.title?.trim() || hostnameFromUrl(payload.url);
  const oneLine = metadata.oneLine || "阅读笔记摘录";
  return escapeBearText(`${title} — ${oneLine}`);
}

function escapeBearText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_[\]{}()<>#+\-.!|>])/g, "\\$1");
}

function buildBearPreviewFields(payload, metadata, candidates) {
  return [
    { label: "标题", value: buildTitle(payload, metadata), kind: "text" },
    { label: "素材", value: summarizeCandidates(candidates), kind: "candidate-list" },
    { label: "描述", value: metadata.summary.replace(/\n/g, " "), kind: "longtext" },
    { label: "链接", value: payload.url, kind: "url" }
  ];
}

async function buildDataUrlPreview(asset) {
  const base64 = await fs.readFile(asset.filePath, "base64");
  return `data:${asset.mimeType || "image/jpeg"};base64,${base64}`;
}

async function buildBearCandidates(payload, metadata) {
  const candidates = [];
  if (isTwitterUrl(payload.url)) {
    const hasVideo = await hasTwitterDownloadableVideo(payload.url).catch(() => false);
    if (hasVideo) {
      const thumbnail = await buildTwitterPreviewThumbnailForBear(payload, metadata).catch(() => null);
      candidates.push(makeCandidate({
        kind: "twitter-gif",
        sourceType: "twitter",
        mediaUrl: payload.url,
        poster: "",
        thumbnail: thumbnail || null,
        selected: true,
        label: "X 视频转 GIF",
        id: `bear-twitter-gif:${safeShellName(payload.url)}`
      }));
    }
  }

  const imageSourceType = isTwitterUrl(payload.url) ? "twitter" : isXiaohongshuUrl(payload.url) ? "xiaohongshu" : "webpage";
  const imageCandidates = buildContentImageCandidates(payload, imageSourceType, {
    selectedFirst: !candidates.some((candidate) => candidate.selected),
    labelPrefix: isXiaohongshuUrl(payload.url) ? "小红书图片" : "内容图片"
  });
  candidates.push(...imageCandidates.slice(0, 8));

  if (payload.screenshotDataUrl) {
    const screenshot = await saveDataUrlAsset(payload.screenshotDataUrl, metadata.titleZh || payload.title || "bear-screenshot", "jpg");
    const compactScreenshot = screenshot
      ? await compactImageForBear({ ...screenshot, cleanupPaths: [screenshot.filePath] }).catch(() => null)
      : null;
    if (compactScreenshot) {
      candidates.push(makeCandidate({
        kind: "screenshot",
        sourceType: "browser",
        asset: compactScreenshot,
        selected: !candidates.some((candidate) => candidate.selected),
        label: "当前截图"
      }));
    }
  }

  if (!candidates.some((candidate) => candidate.selected) && candidates.length) candidates[0].selected = true;
  return candidates;
}

function buildContentImageCandidates(payload, sourceType, options = {}) {
  const seen = new Set();
  const images = [
    payload.pageMeta?.image ? { src: payload.pageMeta.image, alt: `${options.labelPrefix || "内容图片"} 1`, width: 0, height: 0 } : null,
    ...(payload.pageAssets?.images || [])
  ].filter(Boolean)
    .filter((image) => sourceType !== "twitter" || image.tweetScope === "primary");

  return images
    .map((image, index) => {
      const src = normalizeContentImageUrl(image.src || "", sourceType);
      if (!src || seen.has(src)) return null;
      seen.add(src);
      return makeCandidate({
        kind: "asset-url",
        sourceType,
        assetUrl: src,
        selected: Boolean(options.selectedFirst && index === 0),
        label: image.alt || `${options.labelPrefix || "内容图片"} ${index + 1}`,
        description: image.alt || "",
        id: `bear-content-image:${index + 1}:${safeShellName(src)}`,
        width: image.width || 0,
        height: image.height || 0
      });
    })
    .filter(Boolean);
}

function normalizeContentImageUrl(url, sourceType) {
  const text = String(url || "").trim();
  if (!text || text.startsWith("data:") || text.startsWith("blob:")) return "";
  try {
    const parsed = new URL(text);
    if (sourceType === "twitter" && isTwitterDefaultOgImage(parsed)) return "";
    if (sourceType === "xiaohongshu") {
      for (const key of [...parsed.searchParams.keys()]) {
        if (["imageView2", "format", "x-oss-process"].includes(key) || key.startsWith("image")) {
          parsed.searchParams.delete(key);
        }
      }
    }
    return parsed.toString();
  } catch (_error) {
    return text;
  }
}

function isTwitterDefaultOgImage(parsedUrl) {
  return parsedUrl.hostname === "abs.twimg.com"
    && /^\/rweb\/ssr\/default\/v\d+\/og\/image\.png$/i.test(parsedUrl.pathname);
}

function makeCandidate(candidate) {
  const filename = candidate.asset?.filename || candidate.assetUrl || candidate.mediaUrl || candidate.kind;
  return {
    id: candidate.id || `${candidate.kind}:${safeShellName(filename)}`,
    ...candidate
  };
}

function summarizeCandidates(candidates = []) {
  return candidates.map((candidate) => ({
    id: candidate.id || "",
    kind: candidate.kind,
    sourceType: candidate.sourceType || "",
    filename: candidate.asset?.filename || candidate.filename || "",
    filePath: candidate.asset?.filePath || candidate.filePath || "",
    size: candidate.asset?.size || candidate.size || 0,
    assetUrl: candidate.assetUrl || "",
    mediaUrl: candidate.mediaUrl || "",
    poster: candidate.poster || "",
    thumbnailPath: candidate.thumbnail?.filePath || candidate.thumbnailPath || "",
    thumbnailFilename: candidate.thumbnail?.filename || candidate.thumbnailFilename || "",
    label: candidate.label || bearCandidateLabel(candidate),
    description: candidate.description || "",
    selected: Boolean(candidate.selected),
    width: candidate.width || 0,
    height: candidate.height || 0
  }));
}

function bearCandidateLabel(candidate) {
  if (candidate.kind === "twitter-gif") return "X 视频转 GIF";
  if (candidate.kind === "screenshot") return "当前截图";
  if (candidate.kind === "asset-url") return candidate.sourceType === "xiaohongshu" ? "小红书图片" : "内容图片";
  return "素材";
}

async function resolveSelectedBearAssets(task, options = {}) {
  const result = task.results?.bear;
  const candidates = result?.writePlan?.candidates || [];
  const hasExplicitSelection = Object.prototype.hasOwnProperty.call(options, "candidateIds");
  const candidateIds = Array.isArray(options.candidateIds) ? options.candidateIds : [];
  const selectedIds = new Set(candidateIds.filter(Boolean));
  const selectedCandidates = hasExplicitSelection
    ? candidates.filter((candidate) => selectedIds.has(candidate.id))
    : candidates.filter((candidate) => candidate.selected);
  const selected = selectedCandidates.length
    ? selectedCandidates
    : (hasExplicitSelection ? [] : candidates.slice(0, 1));
  if (!selected.length && selectedIds.size) {
    throw new Error("所选 Bear 素材已失效，请重新选择后再试。");
  }
  const assets = [];
  const items = [];
  for (const candidate of selected) {
    try {
      const asset = await bearDependencies.resolveCandidate(candidate, task.payload, result.metadata || {});
      if (asset) {
        assets.push(asset);
        items.push({ id: candidate.id || "", status: "pending", asset });
      } else {
        items.push({ id: candidate.id || "", status: "failed", error: "素材无法解析" });
      }
    } catch (error) {
      items.push({ id: candidate.id || "", status: "failed", error: error.message });
    }
  }
  return { assets, items };
}

async function resolveBearCandidateAsset(candidate, payload, metadata) {
  if (candidate.kind === "twitter-gif") {
    return buildTwitterGifForBear(payload, metadata);
  }
  if (candidate.kind === "screenshot" && candidate.asset?.filePath) {
    return {
      ...candidate.asset,
      kind: "screenshot",
      label: candidate.label || "截图"
    };
  }
  if (candidate.kind === "asset-url" && candidate.assetUrl) {
    const asset = await downloadRemoteAssetForBear(candidate.assetUrl, metadata, candidate.sourceType);
    return {
      ...asset,
      kind: "image",
      label: candidate.label || "图片"
    };
  }
  return null;
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

  const urlPath = path.join(os.tmpdir(), "chrome-clip-router-assets", `${Date.now()}-bear-url.txt`);
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
  const targetPath = path.join(os.tmpdir(), "chrome-clip-router-assets", `${Date.now()}-bear-shot.jpg`);
  try {
    await execFileAsync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "55", "-Z", "900", asset.filePath, "--out", targetPath], { timeout: 10000 });
    const stat = await fs.stat(targetPath);
    if (stat.size > 280000) {
      await cleanupOwnedPaths([targetPath]);
      return null;
    }
    return {
      ...asset,
      filePath: targetPath,
      filename: `clip-router-shot-${Date.now()}.jpg`,
      mimeType: "image/jpeg",
      size: stat.size,
      cleanupPaths: [...(asset.cleanupPaths || []), targetPath]
    };
  } catch (error) {
    await cleanupOwnedPaths([targetPath]);
    throw error;
  }
}

async function downloadRemoteAssetForBear(assetUrl, metadata, sourceType = "asset") {
  if (!assetUrl) throw new Error("远程素材 URL 为空");
  const response = await fetch(assetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 Chrome Clip Router",
      Referer: sourceType === "xiaohongshu" ? "https://www.xiaohongshu.com/" : undefined
    }
  });
  if (!response.ok) throw new Error(`远程素材下载失败：${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("远程素材内容为空");

  const dir = path.join(os.tmpdir(), "chrome-clip-router-assets");
  await fs.mkdir(dir, { recursive: true });
  const contentType = response.headers.get("content-type") || "";
  const ext = extensionFromContentType(contentType) || extensionFromUrl(assetUrl) || "jpg";
  const rawPath = path.join(dir, `${Date.now()}-${safeShellName(metadata.titleZh || sourceType)}-${Math.random().toString(16).slice(2, 8)}.${ext}`);
  await fs.writeFile(rawPath, buffer);
  const compact = await compactImageForBear({
    filePath: rawPath,
    filename: path.basename(rawPath),
    mimeType: contentType,
    size: buffer.length,
    cleanupPaths: [rawPath]
  }).catch(() => null);
  if (compact) return { ...compact, cleanupPaths: [rawPath, compact.filePath] };
  return {
    filePath: rawPath,
    filename: path.basename(rawPath),
    mimeType: contentType,
    size: buffer.length,
    cleanupPaths: [rawPath]
  };
}

function extensionFromContentType(contentType) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif"
  };
  return map[type] || "";
}

function extensionFromUrl(assetUrl) {
  try {
    const ext = path.extname(new URL(assetUrl).pathname).replace(".", "").toLowerCase();
    return ["jpg", "jpeg", "png", "webp", "gif"].includes(ext) ? ext : "";
  } catch (_error) {
    return "";
  }
}

async function buildTwitterGifForBear(payload, metadata) {
  const media = await downloadTwitterVideo(payload.url, metadata);
  try {
    const gif = await convertVideoToGif(media.filePath, metadata);
    return {
      ...gif,
      kind: "gif",
      label: "GIF",
      sourceVideo: media.filePath,
      cleanupPaths: [...(gif.cleanupPaths || []), media.filePath]
    };
  } catch (error) {
    await cleanupOwnedPaths([media.filePath]);
    throw error;
  }
}

async function buildTwitterPreviewThumbnailForBear(payload, metadata) {
  const cropped = await cropVideoFrameFromScreenshot(payload, metadata).catch(() => null);
  if (cropped?.filePath) return cropped;

  const downloaded = await captureTwitterDownloadedFrameForBear(payload, metadata).catch(() => null);
  if (downloaded?.filePath) return downloaded;

  if (payload.screenshotDataUrl) {
    const screenshot = await saveDataUrlAsset(payload.screenshotDataUrl, metadata.titleZh || payload.title || "twitter-video-frame", "png");
    if (screenshot?.filePath) {
      return {
        ...screenshot,
        source: "visible-tab-screenshot"
      };
    }
  }

  return captureTwitterThumbnailForBear(payload.url, metadata).catch(() => null);
}

async function captureTwitterDownloadedFrameForBear(payload, metadata) {
  const media = await withTimeout(
    downloadTwitterVideo(payload.url, metadata),
    18000,
    "X/Twitter 视频首帧下载超时"
  );
  const thumbnail = await captureVideoThumbnail(media.filePath, metadata.titleZh || payload.title || "twitter-video");
  return {
    ...thumbnail,
    source: "yt-dlp-video-first-frame",
    mediaFilePath: media.filePath
  };
}

async function cropVideoFrameFromScreenshot(payload, metadata) {
  const rect = selectVideoRect(payload.pageAssets?.videoRects);
  if (!rect || !payload.screenshotDataUrl) return null;

  const screenshot = await saveDataUrlAsset(payload.screenshotDataUrl, metadata.titleZh || payload.title || "twitter-visible-page", "png");
  if (!screenshot?.filePath) return null;

  const viewport = payload.pageAssets?.viewport || {};
  const dpr = Number(viewport.devicePixelRatio || 1) || 1;
  const imageSize = await getImageSize(screenshot.filePath).catch(() => null);
  const crop = normalizeCropRect(rect, dpr, imageSize);
  if (!crop) return null;

  const dir = path.join(os.tmpdir(), "chrome-clip-router-assets");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `clip-router-bear-video-frame-${Date.now()}-${safeShellName(metadata.titleZh || "twitter")}.jpg`);
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", screenshot.filePath,
    "-vf", `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    "-frames:v", "1",
    "-q:v", "3",
    filePath
  ], { timeout: 12000, maxBuffer: 1024 * 1024 * 2 });

  return {
    filePath,
    filename: path.basename(filePath),
    mimeType: "image/jpeg",
    size: await fileSize(filePath),
    source: "visible-video-crop",
    rect: crop
  };
}

function selectVideoRect(rects) {
  return (Array.isArray(rects) ? rects : [])
    .map((rect) => ({
      x: Number(rect.x || 0),
      y: Number(rect.y || 0),
      width: Number(rect.width || 0),
      height: Number(rect.height || 0)
    }))
    .filter((rect) => rect.width >= 120 && rect.height >= 80)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;
}

async function getImageSize(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    filePath
  ], { timeout: 5000, maxBuffer: 1024 * 32 });
  const [width, height] = stdout.trim().split("x").map((value) => Number(value || 0));
  return width && height ? { width, height } : null;
}

function normalizeCropRect(rect, dpr, imageSize = null) {
  const x = Math.max(0, Math.round(rect.x * dpr));
  const y = Math.max(0, Math.round(rect.y * dpr));
  let width = Math.max(0, Math.round(rect.width * dpr));
  let height = Math.max(0, Math.round(rect.height * dpr));
  if (imageSize?.width && imageSize?.height) {
    width = Math.min(width, Math.max(0, imageSize.width - x));
    height = Math.min(height, Math.max(0, imageSize.height - y));
  }
  if (width < 120 || height < 80) return null;
  return {
    x,
    y,
    width: width % 2 === 0 ? width : width - 1,
    height: height % 2 === 0 ? height : height - 1
  };
}

async function captureTwitterThumbnailForBear(url, metadata) {
  const dir = path.join(os.tmpdir(), "chrome-clip-router-assets");
  await fs.mkdir(dir, { recursive: true });
  const outputTemplate = path.join(dir, `clip-router-bear-thumb-${Date.now()}-${safeShellName(metadata.titleZh || "twitter")}.%(ext)s`);
  const args = [
    "--no-playlist",
    "--skip-download",
    "--write-thumbnail",
    "--convert-thumbnails",
    "jpg",
    "-o",
    outputTemplate,
    "--print",
    "thumbnail",
    url
  ];
  await execFileAsync("yt-dlp", args, { timeout: 12000, maxBuffer: 1024 * 1024 * 2 });
  const files = await fs.readdir(dir);
  const prefix = path.basename(outputTemplate).replace("%(ext)s", "");
  const file = files
    .filter((name) => name.startsWith(prefix) && /\.(jpg|jpeg|png|webp)$/i.test(name))
    .sort()
    .at(-1);
  if (!file) throw new Error("yt-dlp 未返回视频缩略图");
  const filePath = path.join(dir, file);
  return {
    filePath,
    filename: file,
    mimeType: contentTypeForImagePath(filePath),
    size: await fileSize(filePath),
    source: "yt-dlp-thumbnail"
  };
}

function contentTypeForImagePath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
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

async function captureVideoThumbnail(videoUrl, baseName = "video") {
  if (!videoUrl) throw new Error("视频 URL 为空");
  const dir = path.join(os.tmpdir(), "chrome-clip-router-assets");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `clip-router-bear-frame-${Date.now()}-${safeShellName(baseName)}.jpg`);
  await execFileAsync("ffmpeg", [
    "-y",
    "-ss", "0",
    "-i", videoUrl,
    "-frames:v", "1",
    "-q:v", "3",
    filePath
  ], { timeout: 12000, maxBuffer: 1024 * 1024 * 2 });
  return {
    filePath,
    filename: path.basename(filePath),
    mimeType: "image/jpeg",
    size: await fileSize(filePath),
    source: "ffmpeg-first-frame"
  };
}

async function hasTwitterDownloadableVideo(url) {
  const { stdout } = await execFileAsync("yt-dlp", [
    "--no-playlist",
    "--skip-download",
    "--print",
    "%(url)s",
    url
  ], { timeout: 15000, maxBuffer: 1024 * 1024 });
  return /\.(mp4|m4v|mov|webm)(?:[?#]|$)/i.test(stdout)
    || /video|amplify_video|tweet_video|m3u8/i.test(stdout);
}

async function convertVideoToGif(videoPath, metadata) {
  const dir = path.join(os.tmpdir(), "chrome-clip-router-assets");
  await fs.mkdir(dir, { recursive: true });
  const base = safeShellName(metadata.titleZh || "x-video");
  const palettePath = path.join(dir, `${Date.now()}-${base}-palette.png`);
  const gifPath = path.join(dir, `${Date.now()}-${base}.gif`);
  const filters = "fps=10,scale=480:-1:flags=lanczos";
  try {
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
      size: stat.size,
      cleanupPaths: [palettePath, gifPath]
    };
  } catch (error) {
    await cleanupOwnedPaths([palettePath, gifPath]);
    throw error;
  }
}

async function cleanupOwnedPaths(paths) {
  await Promise.all([...new Set(paths)].map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
}

function isTwitterUrl(url) {
  const host = hostnameFromUrl(url);
  return host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com");
}

function isXiaohongshuUrl(url) {
  const host = hostnameFromUrl(url);
  return host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com");
}

function safeShellName(value) {
  return String(value || "asset").replace(/[^\w.-]+/g, "-").slice(0, 60) || "asset";
}

async function fileSize(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch (_error) {
    return 0;
  }
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
  const imageFilenames = Array.isArray(imageFilename) ? imageFilename.filter(Boolean) : [imageFilename].filter(Boolean);
  const readableDbPath = await copyDbForRead(dbPath);
  const countSql = `SELECT COUNT(*) AS count FROM ZSFNOTE WHERE ZTEXT LIKE '%${escaped}%';`;
  const matchSql = `SELECT ZTITLE AS title, substr(ZTEXT, max(length(ZTEXT)-1000, 1), 1000) AS tail FROM ZSFNOTE WHERE ZTEXT LIKE '%${escaped}%' LIMIT 3;`;
  const imageSql = imageFilenames.length
    ? `SELECT ${imageFilenames.map((filename) => `(CASE WHEN ZTEXT LIKE '%${escapeSqlLike(filename)}%' THEN 1 ELSE 0 END)`).join(" + ")} AS count FROM ZSFNOTE WHERE ZTEXT LIKE '%${escaped}%' ORDER BY ZMODIFICATIONDATE DESC LIMIT 1;`
    : "SELECT 0 AS count;";
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
  const noteId = normalizeBearNoteId(env.CLIP_ROUTER_BEAR_NOTE_ID) || DEFAULT_BEAR_NOTE_ID;
  if (!noteId) {
    throw new Error("请先在插件设置里填写 Bear 笔记链接");
  }
  return noteId;
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

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
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
