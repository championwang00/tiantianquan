import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generateClipMetadata } from "../utils/provider.js";
import { saveDataUrlAsset } from "../utils/assets.js";
import { buildChineseSummary, hostnameFromUrl } from "../utils/webpage.js";

const execFileAsync = promisify(execFile);
const EAGLE_API = "http://127.0.0.1:41595";

const FOLDERS = [
  { id: "LRTFG9BI1SY8U", name: "建筑和住宅", keywords: ["architecture", "building", "house", "home", "interior", "建筑", "住宅"] },
  { id: "LKC6VRUMQUVQA", name: "工业设计", keywords: ["car", "vehicle", "industrial", "product design", "汽车", "工业设计"] },
  { id: "LKBZ3R25YAJWK", name: "UI细节&交互细节", keywords: ["ui", "ux", "interaction", "button", "card", "app", "界面", "交互", "按钮", "卡片"] },
  { id: "LKBZ3YPUH2EDW", name: "品牌", keywords: ["brand", "logo", "identity", "branding", "品牌", "标志"] },
  { id: "MJ81BPW9MQX1Y", name: "Framer 资源", keywords: ["framer"] },
  { id: "LW7P0KKNOQAJ2", name: "figma插件", keywords: ["figma", "plugin", "插件"] },
  { id: "M90V82N8V2EPI", name: "前端动画&工具库", keywords: ["javascript", "react", "vue", "animation", "library", "github", "前端", "动效", "工具库"] },
  { id: "LLV2D5U2ZHZEB", name: "图标设计&库", keywords: ["icon", "icons", "图标"] },
  { id: "LLV2C9RLWMPOQ", name: "PPT排版", keywords: ["slides", "presentation", "ppt", "keynote", "排版"] },
  { id: "LKBZ4BPL2LY1F", name: "动态视频素材", keywords: ["video", "motion", "reel", "动画", "视频"] },
  { id: "MC3HKOISZAH46", name: "字体", keywords: ["font", "typeface", "typography", "字体"] },
  { id: "LR61KOZU1TLZL", name: "mockup", keywords: ["mockup"] },
  { id: "LKC6W3HQJGRWZ", name: "渐变素材", keywords: ["gradient", "渐变"] },
  { id: "MK6ASVD4I5P03", name: "配图", keywords: ["x.com", "twitter", "xiaohongshu", "media", "小红书", "推特"] },
  { id: "MAV8CC9QFV83G", name: "设计师&工作室", keywords: ["portfolio", "studio", "designer", "behance", "dribbble", "作品集", "工作室", "设计师"] }
];

export async function runEagleAdapter(payload) {
  const metadata = await buildEagleMetadata(payload);
  const folders = resolvePreviewFolders(payload, metadata);
  const annotation = buildAnnotation(payload, metadata);
  const candidates = await buildImportCandidates(payload, metadata);
  const importPlan = candidates.find((candidate) => candidate.selected) || candidates[0];
  const readiness = { ok: true, skipped: true };

  return {
    status: "needs_review",
    reason: readiness.ok ? "等待用户确认后再写入 Eagle" : `Eagle 连接待确认：${readiness.reason}`,
    folderIds: folders.map((folder) => folder.id),
    folders: folders.map((folder) => folder.name),
    annotation,
    metadata,
    importPlan: summarizeImportPlan(importPlan),
    candidates: summarizeCandidates(candidates),
    preview: buildEaglePreview(payload, metadata, folders, annotation, importPlan),
    previewFields: buildEaglePreviewFields(payload, metadata, folders, annotation, candidates),
    writePlan: { folders, metadata, annotation, importPlan, candidates },
    readiness
  };
}

async function buildEagleMetadata(payload) {
  const fallback = buildFastMetadata(payload);
  try {
    const generated = await withTimeout(
      generateClipMetadata(payload, "eagle"),
      8000,
      "Eagle metadata generation timed out"
    );
    return mergeMetadataWithFallback(generated, fallback, payload);
  } catch (_error) {
    return fallback;
  }
}

function mergeMetadataWithFallback(generated, fallback, payload) {
  const titleZh = cleanAiTitle(generated.titleZh, payload.title) || fallback.titleZh;
  const oneLine = cleanChineseIntro(generated.oneLine || generated.summary) || fallback.oneLine;
  return {
    ...fallback,
    ...generated,
    titleZh,
    oneLine,
    summary: cleanChineseIntro(generated.summary) || fallback.summary,
    tags: Array.isArray(generated.tags) && generated.tags.length ? generated.tags.slice(0, 6) : fallback.tags,
    whySaved: cleanChineseIntro(generated.whySaved) || fallback.whySaved
  };
}

function cleanAiTitle(value, originalTitle = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const original = String(originalTitle || "").replace(/\s+/g, " ").trim();
  if (!/[\u4e00-\u9fff]/.test(text) && original && text === original) return "";
  if (!/[\u4e00-\u9fff]/.test(text) && /[a-z]{3}/i.test(text)) return "";
  return text;
}

function cleanChineseIntro(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.slice(0, 90);
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

function buildFastMetadata(payload) {
  const host = hostnameFromUrl(payload.url);
  const description = String(payload.pageMeta?.description || "").trim();
  const title = String(payload.title || host || "网页素材").replace(/\s+/g, " ").trim();
  const contentType = detectSourceType(payload.url) === "twitter"
    ? "video"
    : detectSourceType(payload.url) === "xiaohongshu"
      ? "design_reference"
      : "design_reference";
  return {
    titleZh: localizeTitleFallback(title, host),
    oneLine: localizeIntroFallback(description, host),
    summary: localizeIntroFallback(description, host) || buildChineseSummary(payload),
    tags: inferFastTags(payload, contentType),
    contentType,
    whySaved: "作为网页、产品、设计或内容参考。"
  };
}

function localizeTitleFallback(title, host) {
  const cleaned = String(title || host || "网页素材").replace(/\s+/g, " ").trim();
  if (/[\u4e00-\u9fff]/.test(cleaned)) return cleaned;
  return `${cleaned}（${host} 素材参考）`;
}

function localizeIntroFallback(description, host) {
  const text = String(description || "").replace(/\s+/g, " ").trim();
  if (!text) return `${host} 上的网页素材参考`;
  if (/[\u4e00-\u9fff]/.test(text)) return text.slice(0, 90);
  return `来自 ${host} 的素材参考：${text.slice(0, 70)}`;
}

function inferFastTags(payload, contentType) {
  const host = hostnameFromUrl(payload.url);
  const tags = new Set(["网页素材"]);
  if (contentType === "video") tags.add("视频");
  if (host.includes("xiaohongshu")) tags.add("小红书");
  if (host === "x.com" || host.includes("twitter")) tags.add("X");
  if (/figma|ui|ux|interface|app|design|设计|界面/i.test(`${payload.title} ${payload.pageMeta?.description || ""}`)) tags.add("设计参考");
  return [...tags].slice(0, 6);
}

function resolvePreviewFolders(payload, metadata = {}) {
  const selectedIds = normalizeFolderIds(payload.options?.eagle?.folderIds || [payload.options?.eagle?.folderId].filter(Boolean));
  if (selectedIds.length) {
    const selected = selectedIds
      .map((id) => FOLDERS.find((folder) => folder.id === id))
      .filter(Boolean);
    if (selected.length) return selected;
  }
  return classifyFolders(payload, metadata);
}

export async function confirmEagleWrite(task, options = {}) {
  const result = task.results?.eagle;
  if (!result?.writePlan) {
    throw new Error("Eagle write plan not found on task");
  }

  await request("/api/application/info");
  const selectedFolders = await resolveFolders({
    ...task.payload,
    options: {
      ...(task.payload.options || {}),
      eagle: {
        ...(task.payload.options?.eagle || {}),
        folderIds: normalizeFolderIds(
          options.folderIds?.length
            ? options.folderIds
            : task.payload.options?.eagle?.folderIds?.length
              ? task.payload.options.eagle.folderIds
              : task.payload.options?.eagle?.folderId
                ? [task.payload.options.eagle.folderId]
                : result.writePlan.folders?.map((folder) => folder.id) || []
        )
      }
    }
  });

  const { metadata, annotation } = result.writePlan;
  const folders = selectedFolders.length ? selectedFolders : result.writePlan.folders;
  const candidates = normalizeSelectedCandidates(
    result.writePlan,
    options.candidateIds,
    task.payload.options?.eagle?.captureMode
  );
  if (!candidates.length) {
    throw new Error("请至少勾选一个 Eagle 候选素材。");
  }

  const beforeIds = await listItemIds();
  let activeBeforeIds = beforeIds;
  const primaryFolder = folders[0];
  const usedCandidateIds = new Set(candidates.map((candidate) => candidate.id));
  const batch = await executeCandidateBatch(candidates, async (candidate) => {
    const imported = await importWithFallback(candidate, {
      payload: task.payload,
      writePlan: result.writePlan,
      excludedCandidateIds: usedCandidateIds,
      importCandidate: (nextCandidate) => importToEagle(nextCandidate, task.payload, metadata, folders, annotation)
    });
    usedCandidateIds.add(imported.candidate.id);
    const response = imported.response;
    const importedCandidate = imported.candidate;
    const item = await resolveImportedItem(response, activeBeforeIds, task.payload, importedCandidate, metadata, folders);
    const itemId = item?.id || "";
    if (!itemId) {
      throw new Error(`Eagle ${importPlanLabel(importedCandidate)} 导入后未能验证到对应条目。`);
    }

    const freshItem = await waitForItemInfo(itemId);
    if (importedCandidate.kind === "media-file" && freshItem?.ext && !isExpectedMediaItem(freshItem, importedCandidate, task.payload)) {
      throw new Error(`Eagle 视频导入格式不匹配：期望 mp4 媒体文件，但验证到 ${freshItem.ext || "未知格式"}。`);
    }

    const verification = await verifyItem(itemId, task.payload, folders, freshItem);
    if (!verification.folderOk && primaryFolder) {
      throw new Error(`Eagle 已导入但未进入目标文件夹「${primaryFolder.name}」。itemId=${itemId}，实际文件夹：${verification.rawFolderNames.join("、") || verification.rawFolderIds.join("、") || "未知"}。`);
    }

    const metadataUpdate = await updateItemMetadata(itemId, task.payload, metadata, folders, annotation);
    const writtenItem = {
      candidateId: importedCandidate.id,
      requestedCandidateId: candidate.id,
      itemId,
      folderId: primaryFolder?.id || "",
      folderName: primaryFolder?.name || "",
      requestedFolderIds: folders.map((folder) => folder.id),
      requestedFolderNames: folders.map((folder) => folder.name),
      importPlan: summarizeImportPlan(importedCandidate),
      verification,
      metadataUpdate,
      fallbackReason: imported.fallbackReason || "",
      __cleanupCandidate: importedCandidate
    };
    activeBeforeIds = new Set([...activeBeforeIds, itemId]);
    return writtenItem;
  }, result.writePlan.candidates || candidates);
  const writtenItems = batch.items.filter((item) => item.status === "success");

  if (writtenItems.length) await revealEagle();
  return {
    ...result,
    status: batch.failed ? (batch.succeeded ? "partial_success" : "failed") : "success",
    reason: batch.failed ? `Eagle 写入完成：${batch.succeeded} 个成功，${batch.failed} 个失败` : "Eagle 写入并验证成功",
    succeeded: batch.succeeded,
    failed: batch.failed,
    items: batch.items,
    itemIds: writtenItems.map((item) => item.itemId),
    folderIds: folders.map((folder) => folder.id),
    folders: folders.map((folder) => folder.name),
    annotation,
    metadata,
    importPlan: writtenItems[0]?.importPlan || null,
    candidates: summarizeCandidates(result.writePlan.candidates || []),
    previewFields: buildEaglePreviewFields(task.payload, metadata, folders, annotation, result.writePlan.candidates || []),
    writtenItems,
    writtenAt: new Date().toISOString()
  };
}

export const __testHooks = {
  buildImportCandidates,
  instagramEntryMatchesCandidate,
  importWithFallback,
  executeCandidateBatch,
  normalizeSelectedCandidates,
  selectDefaultCandidates,
  summarizeCandidates
};

async function executeCandidateBatch(candidates, processCandidate, assetsToCleanup = candidates) {
  const items = [];
  const cleanupCandidates = new Set(assetsToCleanup);
  try {
    for (const candidate of candidates) {
      try {
        const processed = await processCandidate(candidate);
        const cleanupCandidate = processed?.__cleanupCandidate;
        if (cleanupCandidate) cleanupCandidates.add(cleanupCandidate);
        if (processed) delete processed.__cleanupCandidate;
        items.push({ ...processed, candidateId: candidate.id, status: "success", reason: "" });
      } catch (error) {
        items.push({ candidateId: candidate.id, status: "failed", reason: error?.message || String(error) });
      }
    }
  } finally {
    await cleanupOwnedCandidateAssets([...cleanupCandidates]);
  }
  return {
    succeeded: items.filter((item) => item.status === "success").length,
    failed: items.filter((item) => item.status === "failed").length,
    items
  };
}

async function cleanupOwnedCandidateAssets(candidateOrCandidates) {
  const tempRoot = path.resolve(os.tmpdir());
  const assetRoot = path.join(tempRoot, "chrome-clip-router-assets");
  const candidates = Array.isArray(candidateOrCandidates) ? candidateOrCandidates : [candidateOrCandidates];
  const paths = [...new Set(candidates.flatMap((candidate) => [candidate?.asset?.filePath, candidate?.thumbnail?.filePath]).filter(Boolean))];
  await Promise.all(paths.map(async (filePath) => {
    const resolved = path.resolve(filePath);
    const owned = resolved.startsWith(`${assetRoot}${path.sep}`)
      || (resolved.startsWith(`${tempRoot}${path.sep}`) && path.basename(resolved).startsWith("clip-router-"));
    if (!owned) return;
    await fs.unlink(resolved).catch(() => {});
  }));
}

async function checkEagleReadiness(url) {
  try {
    await request("/api/application/info");
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function buildImportPlan(payload, metadata) {
  const sourceType = detectSourceType(payload.url);
  const captureMode = payload.options?.eagle?.captureMode || "screenshot";
  if (captureMode === "url") return { kind: "url", sourceType };
  if (captureMode === "top-image" && !(sourceType === "instagram" && payload.pageAssets?.carousel?.length)) {
    const assetUrl = payload.pageMeta?.image || payload.pageAssets?.images?.[0]?.src || "";
    if (assetUrl) return { kind: "asset-url", sourceType, assetUrl };
  }

  if (sourceType === "twitter") {
    const media = await downloadTwitterMedia(payload.url, metadata).catch((error) => ({
      kind: "download_failed",
      reason: error.message
    }));
    if (media.filePath) return { kind: "media-file", sourceType, asset: media };
  }

  if (payload.screenshotDataUrl) {
    const screenshot = await saveDataUrlAsset(payload.screenshotDataUrl, metadata.titleZh || payload.title || "eagle-screenshot", "png");
    if (screenshot?.filePath) return { kind: "screenshot", sourceType, asset: screenshot };
  }

  if (payload.pageContent?.htmlSnapshot) {
    const html = await saveHtmlSnapshot(payload.pageContent.htmlSnapshot, metadata.titleZh || payload.title || "eagle-page");
    if (html?.filePath) return { kind: "html-snapshot", sourceType, asset: html };
  }

  return { kind: "url", sourceType };
}

async function buildImportCandidates(payload, metadata) {
  const sourceType = detectSourceType(payload.url);
  const captureMode = payload.options?.eagle?.captureMode || "screenshot";
  const candidates = [];

  if (sourceType === "twitter") {
    const hasVideo = await hasTwitterDownloadableVideo(payload.url).catch(() => false);
    if (hasVideo) {
      const thumbnail = await buildTwitterPreviewThumbnail(payload, metadata);
      candidates.push(makeCandidate({
        kind: "twitter-url",
        sourceType,
        mediaUrl: payload.url,
        poster: thumbnail?.filePath ? "" : "",
        thumbnail: thumbnail || null,
        selected: true,
        label: "X/Twitter 视频",
        id: `twitter-video:${safeShellName(payload.url)}`
      }));
    }
  }

  if (sourceType === "xiaohongshu") {
    const videoCandidates = await buildContentVideoCandidates(payload, sourceType, { selectedFirst: true, labelPrefix: "小红书视频" });
    candidates.push(...videoCandidates);
    const imageCandidates = buildContentImageCandidates(payload, sourceType, { selectedFirst: true, labelPrefix: "小红书图片" });
    candidates.push(...imageCandidates);
  } else if (sourceType === "instagram") {
    candidates.push(...buildInstagramCarouselCandidates(payload));
  } else {
    const imageCandidates = buildContentImageCandidates(payload, sourceType, { selectedFirst: captureMode === "top-image", labelPrefix: "内容图片" });
    candidates.push(...imageCandidates.slice(0, 6));
  }

  if (payload.screenshotDataUrl) {
    const screenshot = await saveDataUrlAsset(payload.screenshotDataUrl, metadata.titleZh || payload.title || "eagle-screenshot", "png");
    if (screenshot?.filePath) {
      candidates.push(makeCandidate({ kind: "screenshot", sourceType, asset: screenshot, selected: captureMode === "screenshot" && !hasSelectedCandidate(candidates) }));
    }
  }

  if (captureMode === "top-image") {
    const assetUrl = normalizeContentImageUrl(payload.pageMeta?.image || payload.pageAssets?.images?.[0]?.src || "", sourceType);
    if (assetUrl) {
      candidates.push(makeCandidate({ kind: "asset-url", sourceType, assetUrl, selected: !hasSelectedCandidate(candidates) }));
    }
  }

  if (payload.pageContent?.htmlSnapshot) {
    const html = await saveHtmlSnapshot(payload.pageContent.htmlSnapshot, metadata.titleZh || payload.title || "eagle-page");
    if (html?.filePath) {
      candidates.push(makeCandidate({ kind: "html-snapshot", sourceType, asset: html, selected: captureMode === "snapshot" && !hasSelectedCandidate(candidates) }));
    }
  }

  candidates.push(makeCandidate({ kind: "url", sourceType, selected: captureMode === "url" && !hasSelectedCandidate(candidates) }));
  return selectDefaultCandidates(candidates, captureMode);
}

function selectDefaultCandidates(candidates, captureMode = "screenshot") {
  const preferredKind = {
    screenshot: "screenshot",
    "top-image": "asset-url",
    snapshot: "html-snapshot",
    url: "url"
  }[captureMode];
  const preferred = preferredKind ? candidates.find((candidate) => candidate.kind === preferredKind) : null;
  if (preferred) {
    return candidates.map((candidate) => ({
      ...candidate,
      selected: candidate === preferred
    }));
  }
  if (hasSelectedCandidate(candidates)) return candidates;
  return candidates.map((candidate, index) => ({
    ...candidate,
    selected: index === 0
  }));
}

async function importWithFallback(candidate, context) {
  try {
    return {
      response: await context.importCandidate(candidate),
      candidate,
      fallbackReason: ""
    };
  } catch (error) {
    const fallback = selectFallbackCandidate(candidate, context.writePlan, context.payload, context.excludedCandidateIds);
    if (!fallback) throw error;
    return {
      response: await context.importCandidate(fallback),
      candidate: fallback,
      fallbackReason: error.message || String(error)
    };
  }
}

function selectFallbackCandidate(candidate, writePlan, payload, excludedCandidateIds = new Set()) {
  if (!["twitter-url", "media-url"].includes(candidate?.kind)) return null;
  const captureMode = payload?.options?.eagle?.captureMode || "screenshot";
  const candidates = Array.isArray(writePlan?.candidates) ? writePlan.candidates : [];
  const available = (nextCandidate) => nextCandidate.id !== candidate.id && !excludedCandidateIds.has(nextCandidate.id);
  const preferred = selectDefaultCandidates(candidates, captureMode)
    .find((nextCandidate) => nextCandidate.selected && available(nextCandidate));
  return preferred || candidates.find((nextCandidate) => {
    if (!available(nextCandidate)) return false;
    return ["screenshot", "html-snapshot", "asset-url", "url"].includes(nextCandidate.kind);
  }) || null;
}

function makeCandidate(candidate) {
  const filename = candidate.asset?.filename || candidate.assetUrl || candidate.kind;
  return {
    id: candidate.id || `${candidate.kind}:${safeShellName(filename)}`,
    ...candidate
  };
}

function hasSelectedCandidate(candidates) {
  return candidates.some((candidate) => candidate.selected);
}

async function fallbackImportPlan(payload, metadata, previousPlan) {
  if (previousPlan.kind !== "html-snapshot" && payload.pageContent?.htmlSnapshot) {
    const html = await saveHtmlSnapshot(payload.pageContent.htmlSnapshot, metadata.titleZh || payload.title || "eagle-page");
    if (html?.filePath) return { kind: "html-snapshot", sourceType: previousPlan.sourceType, asset: html, reason: `fallback_from_${previousPlan.kind}` };
  }
  return { kind: "url", sourceType: previousPlan.sourceType, reason: `fallback_from_${previousPlan.kind}` };
}

async function createUrlBookmark(payload, metadata, folders, annotation) {
  const response = await importUrlToEagle(payload, metadata, folders, annotation);
  await wait(1500);
  const itemId = extractResponseItemId(response) || (await findNewItemId(new Set()));
  if (!itemId) throw new Error("Eagle URL 兜底导入后仍未获取 item id");
  return { itemId, importPlan: { kind: "url", sourceType: detectSourceType(payload.url), reason: "degraded_after_format_mismatch" } };
}

function detectSourceType(url) {
  const host = hostnameFromUrl(url);
  if (host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com")) {
    return "twitter";
  }
  if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com")) return "xiaohongshu";
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
  if (host.includes("dribbble") || host.includes("behance")) return "portfolio";
  return "webpage";
}

function buildInstagramCarouselCandidates(payload) {
  const seen = new Set();
  const carouselVideoCount = (payload.pageAssets?.carousel || []).filter((asset) => asset.type === "video").length;
  const shortcode = (() => {
    try { return new URL(payload.url).pathname.match(/^\/p\/([^/]+)/)?.[1] || "post"; } catch (_error) { return "post"; }
  })();
  return (payload.pageAssets?.carousel || []).map((asset) => {
    const index = Number(asset.index);
    const type = asset.type === "video" ? "video" : "image";
    const url = type === "video" ? normalizeContentVideoUrl(asset.src || "") : normalizeContentImageUrl(asset.src || "", "instagram");
    const key = `${type}:${url || index}`;
    if ((type === "image" && !url) || seen.has(key) || !Number.isInteger(index) || index < 0) return null;
    seen.add(key);
    return makeCandidate({
      kind: type === "video" ? "media-url" : "asset-url",
      sourceType: "instagram",
      ...(type === "video" ? { mediaUrl: url } : { assetUrl: url }),
      poster: asset.poster || "",
      selected: true,
      label: `Instagram ${type === "video" ? "视频" : "图片"} ${index + 1}`,
      id: `instagram:${shortcode}:${index}:${type}`,
      carouselIndex: index,
      postUrl: payload.url,
      duration: Number(asset.duration || 0),
      mediaId: asset.mediaId || "",
      carouselVideoCount,
      width: Number(asset.width || 0),
      height: Number(asset.height || 0)
    });
  }).filter(Boolean).sort((a, b) => a.carouselIndex - b.carouselIndex);
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
        id: `content-image:${index + 1}:${safeShellName(src)}`,
        width: image.width || 0,
        height: image.height || 0
      });
    })
    .filter(Boolean)
    .slice(0, 8);
}

function buildContentVideoCandidates(payload, sourceType, options = {}) {
  const seen = new Set();
  const candidates = (payload.pageAssets?.videos || [])
    .filter((video) => sourceType !== "twitter" || video.tweetScope === "primary")
    .map((video, index) => {
      const src = normalizeContentVideoUrl(video.src || "");
      if (!src || seen.has(src)) return null;
      seen.add(src);
      return makeCandidate({
        kind: "media-url",
        sourceType,
        mediaUrl: src,
        poster: video.poster || "",
        selected: Boolean(options.selectedFirst && index === 0),
        label: video.label || `${options.labelPrefix || "内容视频"} ${index + 1}`,
        id: `content-video:${index + 1}:${safeShellName(src)}`
      });
    })
    .filter(Boolean)
    .slice(0, 4);
  return Promise.all(candidates.map(async (candidate) => {
    if (candidate.poster) return candidate;
    const thumbnail = await captureVideoThumbnail(candidate.mediaUrl, `${options.labelPrefix || "video"}-${candidate.id}`).catch(() => null);
    return thumbnail?.filePath ? { ...candidate, thumbnail } : candidate;
  }));
}

async function buildTwitterPreviewThumbnail(payload, metadata) {
  const cropped = await cropVideoFrameFromScreenshot(payload, metadata).catch(() => null);
  if (cropped?.filePath) return cropped;

  const downloaded = await captureTwitterDownloadedFrame(payload, metadata).catch(() => null);
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
  return captureTwitterThumbnail(payload.url, metadata).catch(() => null);
}

async function captureTwitterDownloadedFrame(payload, metadata) {
  const media = await withTimeout(
    downloadTwitterMedia(payload.url, metadata),
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
  const filePath = path.join(dir, `clip-router-video-frame-${Date.now()}-${safeShellName(metadata.titleZh || "twitter")}.jpg`);
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

function normalizeContentVideoUrl(url) {
  const text = String(url || "").trim();
  if (!text || text.startsWith("data:") || text.startsWith("blob:")) return "";
  try {
    return new URL(text).toString();
  } catch (_error) {
    return text;
  }
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

async function downloadTwitterMedia(url, metadata) {
  const outputTemplate = path.join(os.tmpdir(), `clip-router-eagle-${Date.now()}-${safeShellName(metadata.titleZh || "twitter-media")}.%(ext)s`);
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
  if (!filePath) throw new Error("yt-dlp 未返回下载文件路径");
  return {
    filePath,
    filename: path.basename(filePath),
    source: "yt-dlp",
    size: await fileSize(filePath)
  };
}

async function hasTwitterDownloadableVideo(url) {
  const { stdout } = await execFileAsync("yt-dlp", [
    "--no-playlist",
    "--skip-download",
    "--print",
    "%(duration)s|%(ext)s|%(format_id)s|%(protocol)s|%(url)s",
    url
  ], { timeout: 15000, maxBuffer: 1024 * 1024 });
  const text = stdout.trim();
  if (!text) return false;
  const [duration, ext, formatId, protocol, mediaUrl] = text.split("|");
  return Number(duration) > 0
    || /^(mp4|m4v|mov|webm)$/i.test(ext || "")
    || /video|hls|dash|m3u8/i.test(`${formatId || ""} ${protocol || ""}`)
    || /\.(mp4|m4v|mov|webm)(?:[?#]|$)/i.test(mediaUrl || "")
    || /video|amplify_video|tweet_video|m3u8/i.test(mediaUrl || "");
}

async function downloadMediaUrl(mediaUrl, metadata, sourceType = "media") {
  const outputTemplate = path.join(os.tmpdir(), `clip-router-eagle-${Date.now()}-${safeShellName(metadata.titleZh || `${sourceType}-media`)}.%(ext)s`);
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
    mediaUrl
  ];
  const { stdout } = await execFileAsync("yt-dlp", args, { timeout: 120000, maxBuffer: 1024 * 1024 * 2 });
  const filePath = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!filePath) throw new Error("yt-dlp 未返回下载文件路径");
  return {
    filePath,
    filename: path.basename(filePath),
    source: "yt-dlp",
    size: await fileSize(filePath)
  };
}

async function captureTwitterThumbnail(url, metadata) {
  const dir = path.join(os.tmpdir(), "chrome-clip-router-assets");
  await fs.mkdir(dir, { recursive: true });
  const outputTemplate = path.join(dir, `clip-router-thumb-${Date.now()}-${safeShellName(metadata.titleZh || "twitter")}.%(ext)s`);
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

async function captureVideoThumbnail(videoUrl, baseName = "video") {
  if (!videoUrl) throw new Error("视频 URL 为空");
  const dir = path.join(os.tmpdir(), "chrome-clip-router-assets");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `clip-router-frame-${Date.now()}-${safeShellName(baseName)}.jpg`);
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

function contentTypeForImagePath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

async function importToEagle(importPlan, payload, metadata, folders, annotation) {
  if (importPlan.kind === "twitter-url") {
    const asset = await downloadTwitterMedia(payload.url, metadata);
    importPlan.asset = asset;
    return importPathToEagle(asset.filePath, payload, metadata, folders, annotation);
  }
  if (importPlan.kind === "media-url") {
    const asset = await downloadMediaUrl(importPlan.mediaUrl, metadata, importPlan.sourceType).catch((error) => {
      if (importPlan.sourceType !== "instagram" || !importPlan.postUrl || !Number.isInteger(importPlan.carouselIndex)) throw error;
      return downloadInstagramCarouselVideo(importPlan.postUrl, importPlan, metadata);
    });
    importPlan.asset = asset;
    return importPathToEagle(asset.filePath, payload, metadata, folders, annotation);
  }
  if (importPlan.kind === "asset-url") {
    const asset = await downloadRemoteAsset(importPlan.assetUrl, metadata, importPlan.sourceType).catch(() => null);
    if (asset?.filePath) {
      importPlan.asset = asset;
      return importPathToEagle(asset.filePath, payload, metadata, folders, annotation);
    }
    return importAssetUrlToEagle(importPlan.assetUrl, payload, metadata, folders, annotation);
  }
  if (importPlan.kind === "media-file" || importPlan.kind === "screenshot" || importPlan.kind === "html-snapshot") {
    return importPathToEagle(importPlan.asset.filePath, payload, metadata, folders, annotation);
  }
  return importUrlToEagle(payload, metadata, folders, annotation);
}

async function downloadInstagramCarouselVideo(postUrl, candidate, metadata) {
  const carouselIndex = candidate.carouselIndex;
  const { stdout: jsonText } = await execFileAsync("yt-dlp", ["--skip-download", "--dump-single-json", postUrl], { timeout: 30000, maxBuffer: 1024 * 1024 * 8 });
  const info = JSON.parse(jsonText);
  const entries = Array.isArray(info.entries) ? info.entries : [info];
  const entry = entries.find((item) => Number(item?.playlist_index) === carouselIndex + 1);
  if (!entry || !instagramEntryMatchesCandidate(entry, candidate)) {
    throw new Error(`Instagram 第 ${carouselIndex + 1} 项无法与采集视频精确匹配`);
  }
  const outputTemplate = path.join(os.tmpdir(), `clip-router-instagram-${carouselIndex}-${Date.now()}-${safeShellName(metadata.titleZh || "video")}.%(ext)s`);
  const { stdout } = await execFileAsync("yt-dlp", [
    "--playlist-items", String(carouselIndex + 1),
    "--merge-output-format", "mp4",
    "-f", "bv*+ba/b",
    "-o", outputTemplate,
    "--print", "after_move:filepath",
    postUrl
  ], { timeout: 120000, maxBuffer: 1024 * 1024 * 2 });
  const paths = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (paths.length !== 1) throw new Error(`Instagram 第 ${carouselIndex + 1} 项视频兜底未返回唯一文件`);
  return { filePath: paths[0], filename: path.basename(paths[0]), source: "yt-dlp-instagram-carousel", size: await fileSize(paths[0]) };
}

function instagramEntryMatchesCandidate(entry, candidate) {
  if (!entry || !candidate || Number(entry.playlist_index) !== Number(candidate.carouselIndex) + 1) return false;
  const close = (actual, expected, tolerance) => !expected || (actual && Math.abs(Number(actual) - Number(expected)) <= tolerance);
  if (candidate.carouselVideoCount > 1 && (!candidate.mediaId || !entry.id || String(candidate.mediaId) !== String(entry.id))) return false;
  return close(entry.duration, candidate.duration, 1)
    && close(entry.width, candidate.width, 4)
    && close(entry.height, candidate.height, 4);
}

async function downloadRemoteAsset(assetUrl, metadata, sourceType = "asset") {
  if (!assetUrl) throw new Error("远程素材 URL 为空");
  const response = await fetch(assetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 Chrome Clip Router",
      Referer: sourceType === "xiaohongshu" ? "https://www.xiaohongshu.com/" : undefined
    }
  });
  if (!response.ok) {
    throw new Error(`远程素材下载失败：${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("远程素材内容为空");

  const dir = path.join(os.tmpdir(), "chrome-clip-router-assets");
  await fs.mkdir(dir, { recursive: true });
  const contentType = response.headers.get("content-type") || "";
  const ext = extensionFromContentType(contentType) || extensionFromUrl(assetUrl) || "jpg";
  const filename = `${Date.now()}-${safeShellName(metadata.titleZh || sourceType)}-${Math.random().toString(16).slice(2, 8)}.${ext}`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, buffer);
  return {
    filePath,
    filename,
    source: "remote-url",
    sourceUrl: assetUrl,
    mimeType: contentType,
    size: buffer.length
  };
}

function extensionFromContentType(contentType) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov"
  };
  return map[type] || "";
}

function extensionFromUrl(assetUrl) {
  try {
    const ext = path.extname(new URL(assetUrl).pathname).replace(".", "").toLowerCase();
    return ["jpg", "jpeg", "png", "webp", "gif", "mp4", "webm", "mov", "m4v"].includes(ext) ? ext : "";
  } catch (_error) {
    return "";
  }
}

async function importPathToEagle(filePath, payload, metadata, folders, annotation) {
  const website = normalizeWebsite(payload.url);
  return request("/api/item/addFromPath", {
    method: "POST",
    body: {
      path: filePath,
      name: buildName(payload, metadata),
      website,
      annotation: trimField(annotation, 1800),
      tags: buildTags(payload, folders, metadata),
      folderIds: folders.map((folder) => folder.id).filter(Boolean)
    }
  });
}

async function importUrlToEagle(payload, metadata, folders, annotation) {
  return request("/api/item/addFromURL", {
    method: "POST",
    body: buildEagleBody(payload, metadata, folders, annotation, { url: payload.url })
  });
}

async function importAssetUrlToEagle(assetUrl, payload, metadata, folders, annotation) {
  return request("/api/item/addFromURL", {
    method: "POST",
    body: buildEagleBody(payload, metadata, folders, annotation, { url: assetUrl })
  });
}

function buildEagleBody(payload, metadata, folders, annotation, source, options = {}) {
  const includeFolderId = options.includeFolderId !== false;
  const website = normalizeWebsite(payload.url);
  const body = {
    ...source,
    name: buildName(payload, metadata),
    annotation: trimField(annotation, 1800),
    tags: buildTags(payload, folders, metadata)
  };
  if (includeFolderId) body.folderIds = folders.map((folder) => folder.id).filter(Boolean);
  if (source.url === payload.url) body.website = website;
  if (source.path) body.website = website;
  return body;
}

function trimField(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeWebsite(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith("utm_") || key.includes("adapter") || key.includes("router")) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return url;
  }
}

function summarizeImportPlan(importPlan) {
  return {
    id: importPlan.id || "",
    kind: importPlan.kind,
    sourceType: importPlan.sourceType,
    filename: importPlan.asset?.filename || "",
    filePath: importPlan.asset?.filePath || "",
    size: importPlan.asset?.size || 0,
    assetUrl: importPlan.assetUrl || "",
    mediaUrl: importPlan.mediaUrl || "",
    poster: importPlan.poster || "",
    thumbnailPath: importPlan.thumbnail?.filePath || importPlan.thumbnailPath || "",
    thumbnailFilename: importPlan.thumbnail?.filename || importPlan.thumbnailFilename || "",
    width: importPlan.width || 0,
    height: importPlan.height || 0,
    duration: importPlan.duration || 0,
    carouselIndex: importPlan.carouselIndex,
    postUrl: importPlan.postUrl || "",
    mediaId: importPlan.mediaId || "",
    reason: importPlan.reason || ""
  };
}

function summarizeCandidates(candidates) {
  return candidates.map((candidate) => ({
    ...summarizeImportPlan(candidate),
    label: importPlanLabel(candidate),
    selected: Boolean(candidate.selected),
    downloadable: ["media-file", "twitter-url", "screenshot", "html-snapshot"].includes(candidate.kind)
  }));
}

function buildEaglePreview(payload, metadata, folders, annotation, importPlan) {
  const assetLines = payload.pageAssets?.images?.slice(0, 5).map((image, index) => (
    `${index + 1}. ${image.alt || image.src} ${image.width && image.height ? `(${image.width}x${image.height})` : ""}`
  )) || [];
  return [
    `名称：${buildName(payload, metadata)}`,
    `入库方式：${importPlanLabel(importPlan)}`,
    `文件夹：${folders.map((folder) => folder.name).join(" / ")}`,
    `标签：${buildTags(payload, folders, metadata).join("、")}`,
    "",
    "注释：",
    annotation,
    assetLines.length ? ["", "页面候选图片：", ...assetLines].join("\n") : ""
  ].filter(Boolean).join("\n");
}

function buildEaglePreviewFields(payload, metadata, folders, annotation, importPlan = null) {
  return [
    { label: "标题", value: buildName(payload, metadata), kind: "text" },
    buildImportPreviewField(importPlan),
    { label: "描述", value: annotation, kind: "longtext" },
    { label: "链接", value: payload.url, kind: "url" },
    { label: "标签", value: buildTags(payload, folders, metadata), kind: "tags" },
    { label: "文件夹", value: folders.map((folder) => folder.name), kind: "tags" }
  ].filter(Boolean);
}

function importPlanLabel(importPlan) {
  if (importPlan.kind === "twitter-url") return "X/Twitter 视频";
  if (importPlan.kind === "media-file") return `媒体文件 ${importPlan.asset?.filename || ""}`.trim();
  if (importPlan.kind === "media-url" && importPlan.sourceType === "xiaohongshu") return `小红书视频 ${importPlan.mediaUrl || ""}`.trim();
  if (importPlan.kind === "media-url") return `页面视频 ${importPlan.mediaUrl || ""}`.trim();
  if (importPlan.kind === "screenshot") return `当前可见区域截图 ${importPlan.asset?.filename || ""}`.trim();
  if (importPlan.kind === "html-snapshot") return `网页快照 ${importPlan.asset?.filename || ""}`.trim();
  if (importPlan.kind === "asset-url" && importPlan.sourceType === "xiaohongshu") return `小红书图片 ${importPlan.assetUrl || ""}`.trim();
  if (importPlan.kind === "asset-url" && importPlan.label) return `${importPlan.label} ${importPlan.assetUrl || ""}`.trim();
  if (importPlan.kind === "asset-url") return `页面首图 ${importPlan.assetUrl || ""}`.trim();
  return "网页 URL 元数据";
}

function normalizeSelectedCandidates(writePlan, candidateIds = [], captureMode = "") {
  const candidates = Array.isArray(writePlan.candidates) && writePlan.candidates.length
    ? writePlan.candidates
    : [writePlan.importPlan].filter(Boolean);
  const selectedIds = new Set((Array.isArray(candidateIds) ? candidateIds : [candidateIds]).filter(Boolean));
  if (!selectedIds.size && captureMode) {
    return selectDefaultCandidates(candidates, captureMode).filter((candidate) => candidate.selected);
  }
  const selected = selectedIds.size
    ? candidates.filter((candidate) => selectedIds.has(candidate.id))
    : candidates.filter((candidate) => candidate.selected);
  if (selectedIds.size) return selected;
  return selected.length ? selected : candidates.slice(0, 1);
}

async function listItemIds() {
  try {
    const response = await request("/api/item/list?limit=120");
    const items = response?.data || response?.items || [];
    return new Set(items.map((item) => item.id).filter(Boolean));
  } catch (_error) {
    return new Set();
  }
}

async function findNewItemId(beforeIds) {
  try {
    const response = await request("/api/item/list?limit=20");
    const items = response?.data || response?.items || [];
    const fresh = items.find((item) => item.id && !beforeIds.has(item.id));
    return fresh?.id || "";
  } catch (_error) {
    return "";
  }
}

async function resolveImportedItem(response, beforeIds, payload, importPlan, metadata, folders = []) {
  const responseId = extractResponseItemId(response);
  if (responseId) {
    const item = await getItemInfo(responseId).catch(() => null);
    if (!item || isPlausibleImportedItem(item, payload, importPlan, metadata, folders)) return { id: responseId, ...item };
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await wait(attempt < 3 ? 900 : 1500);
    const items = await listItems(80).catch(() => []);
    const created = items.filter((item) => item.id && !beforeIds.has(item.id));
    const exact = created.find((item) => isExpectedLocalAssetItem(item, importPlan, payload) && itemHasAnyFolder(item, folders))
      || created.find((item) => isPlausibleImportedItem(item, payload, importPlan, metadata, folders))
      || created.find((item) => isExpectedLocalAssetItem(item, importPlan, payload));
    if (exact) return exact;
  }

  if (["media-file", "twitter-url", "media-url", "asset-url"].includes(importPlan.kind)) {
    const media = await findExistingLocalAssetItem(payload, importPlan).catch(() => null);
    if (media) return media;
  }

  if (importPlan.kind !== "media-file" && importPlan.kind !== "twitter-url") {
    const newId = await findNewItemId(beforeIds);
    if (newId) return { id: newId };
  }

  return null;
}

function extractResponseItemId(response) {
  if (typeof response?.data === "string") return response.data;
  if (Array.isArray(response?.data)) return response.data.find((id) => typeof id === "string") || "";
  return response?.data?.id || response?.id || "";
}

async function findExistingLocalAssetItem(payload, importPlan) {
  const items = await listItems(5000);
  return items.find((item) => isExpectedLocalAssetItem(item, importPlan, payload)) || null;
}

async function listItems(limit = 50) {
  const response = await request(`/api/item/list?limit=${encodeURIComponent(limit)}`);
  return response?.data || response?.items || [];
}

async function findLikelyImportedItem(beforeIds, payload, importPlan, metadata) {
  try {
    const items = await listItems(50);
    const created = items.filter((item) => item.id && !beforeIds.has(item.id));
    const expectedName = buildName(payload, metadata);
    return created.find((item) => item.url === payload.url || item.website === payload.url)?.id
      || created.find((item) => item.name === expectedName)?.id
      || created.find((item) => item.name?.includes(metadata.titleZh || payload.title))?.id
      || created.find((item) => importPlan.asset?.filename && JSON.stringify(item).includes(importPlan.asset.filename))?.id
      || created[0]?.id
      || "";
  } catch (_error) {
    return "";
  }
}

async function getItemInfo(itemId) {
  const response = await request(`/api/item/info?id=${encodeURIComponent(itemId)}`);
  const item = response?.data || response?.item || response;
  return item?.id ? item : { id: itemId, ...item };
}

async function waitForItemInfo(itemId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const item = await getItemInfoFromAnySource(itemId).catch(() => null);
    if (item?.id && (item.ext || item.folders || item.folderIds)) return item;
    await wait(attempt < 3 ? 700 : 1400);
  }
  return getItemInfoFromAnySource(itemId).catch(() => ({ id: itemId }));
}

async function getItemInfoFromAnySource(itemId) {
  const direct = await getItemInfo(itemId).catch(() => null);
  if (direct?.id && (direct.ext || direct.folders || direct.folderIds)) return direct;
  const items = await listItems(500).catch(() => []);
  const listed = items.find((item) => item.id === itemId);
  return listed || direct || { id: itemId };
}

function isPlausibleImportedItem(item, payload, importPlan, metadata, folders = []) {
  if (!item) return false;
  if (isExpectedLocalAssetItem(item, importPlan, payload)) return true;
  const expectedName = buildName(payload, metadata);
  const contentOk = item.url === payload.url
    || item.website === payload.url
    || item.name === expectedName
    || Boolean(importPlan.asset?.filename && JSON.stringify(item).includes(importPlan.asset.filename));
  return contentOk && (!folders.length || itemHasAnyFolder(item, folders));
}

function isExpectedMediaItem(item, importPlan, payload) {
  if (!item || !["media-file", "twitter-url", "media-url"].includes(importPlan?.kind)) return false;
  const itemText = JSON.stringify(item);
  const filename = importPlan.asset?.filename || "";
  const expectedSize = Number(importPlan.asset?.size || 0);
  const itemSize = Number(item.size || 0);
  const extOk = ["mp4", "mov", "m4v", "webm"].includes(String(item.ext || "").toLowerCase());
  const sourceOk = item.url === payload.url
    || item.website === payload.url
    || (filename && itemText.includes(filename))
    || (importPlan.mediaUrl && itemText.includes(importPlan.mediaUrl));
  const sizeOk = expectedSize > 0 && itemSize > 0 && Math.abs(itemSize - expectedSize) < Math.max(8192, expectedSize * 0.05);
  return extOk && (sourceOk || sizeOk || importPlan.kind === "media-url" || importPlan.kind === "twitter-url");
}

function isExpectedLocalAssetItem(item, importPlan, payload) {
  if (isExpectedMediaItem(item, importPlan, payload)) return true;
  if (!item || importPlan?.kind !== "asset-url" || !importPlan.asset?.filePath) return false;
  const itemText = JSON.stringify(item);
  const filename = importPlan.asset?.filename || "";
  const expectedSize = Number(importPlan.asset?.size || 0);
  const itemSize = Number(item.size || 0);
  const extOk = ["jpg", "jpeg", "png", "webp", "gif"].includes(String(item.ext || "").toLowerCase());
  const sourceOk = item.url === payload.url
    || item.website === payload.url
    || (filename && itemText.includes(filename))
    || (importPlan.assetUrl && itemText.includes(importPlan.assetUrl));
  const sizeOk = expectedSize > 0 && itemSize > 0 && Math.abs(itemSize - expectedSize) < Math.max(8192, expectedSize * 0.05);
  return extOk && (sourceOk || sizeOk);
}

function buildImportPreviewField(importPlan) {
  if (!importPlan) return null;
  const label = "保存形式";
  if (Array.isArray(importPlan)) {
    return {
      label,
      kind: "candidate-list",
      value: summarizeCandidates(importPlan)
    };
  }
  if (importPlan.kind === "media-file") {
    return {
      label,
      value: importPlan.asset?.filename || "X/Twitter 视频",
      kind: "video",
      src: importPlan.asset?.filePath || "",
      size: importPlan.asset?.size || 0
    };
  }
  if (importPlan.kind === "twitter-url") {
    return {
      label,
      value: "确认收录时下载 X/Twitter 视频",
      kind: "remote-video",
      src: "",
      poster: importPlan.poster || ""
    };
  }
  if (importPlan.kind === "media-url") {
    return {
      label,
      value: importPlanLabel(importPlan),
      kind: "remote-video",
      src: importPlan.mediaUrl || "",
      poster: importPlan.poster || ""
    };
  }
  return { label, value: importPlanLabel(importPlan), kind: "text" };
}

export async function listEagleFolders() {
  await request("/api/application/info");
  const response = await request("/api/folder/list");
  return normalizeFolderList(response?.data || response?.folders || []);
}

async function resolveFolders(payload, metadata = {}) {
  return resolveFoldersWithMetadata(payload, metadata);
}

async function resolveFoldersWithMetadata(payload, metadata = {}) {
  const liveFolders = await listEagleFolders().catch(() => []);
  const selectedIds = normalizeFolderIds(payload.options?.eagle?.folderIds || [payload.options?.eagle?.folderId].filter(Boolean));
  if (selectedIds.length) {
    const selected = selectedIds
      .map((id) => liveFolders.find((folder) => folder.id === id))
      .filter(Boolean);
    if (selected.length) return selected;
  }

  const classified = classifyFolders(payload, metadata);
  if (!liveFolders.length) return classified;

  const liveMatches = classified
    .map((folder) => liveFolders.find((live) => live.id === folder.id) || liveFolders.find((live) => live.name.trim() === folder.name.trim()))
    .filter(Boolean);
  return liveMatches.length ? [liveMatches[0]] : [liveFolders.find((folder) => folder.id === "LKBZ3R25YAJWK") || liveFolders[0]];
}

function normalizeFolderIds(value) {
  const ids = Array.isArray(value) ? value : [value].filter(Boolean);
  return [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
}

function normalizeFolderList(folders, depth = 0) {
  const result = [];
  for (const folder of folders) {
    if (!folder?.id) continue;
    const name = String(folder.name || folder.id).trim();
    result.push({
      id: folder.id,
      name,
      depth,
      label: `${"  ".repeat(depth)}${name}`,
      pinyin: folder.pinyin || ""
    });
    if (Array.isArray(folder.children) && folder.children.length) {
      result.push(...normalizeFolderList(folder.children, depth + 1));
    }
  }
  return result;
}

function classifyFolders(payload, metadata = {}) {
  const text = [
    payload.title,
    payload.url,
    payload.selectedText,
    payload.userNote,
    metadata.titleZh,
    metadata.oneLine,
    metadata.summary,
    metadata.contentType,
    ...(metadata.tags || [])
  ].join(" ").toLowerCase();
  const matches = FOLDERS.filter((folder) => folder.keywords.some((keyword) => text.includes(keyword.toLowerCase())));
  return matches.length ? matches : [FOLDERS.find((folder) => folder.id === "LKBZ3R25YAJWK")];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyItem(itemId, payload, folders, knownItem = null) {
  const item = knownItem?.id ? knownItem : await waitForItemInfo(itemId);
  const itemFolders = item.folderIds || item.folders || [];
  const expectedFolderIds = folders.map((folder) => folder.id);
  const liveFolders = await listEagleFolders().catch(() => []);
  const rawFolderNames = normalizeItemFolderIds(itemFolders)
    .map((id) => liveFolders.find((folder) => folder.id === id)?.name || "")
    .filter(Boolean);
  return {
    id: itemId,
    urlOk: item.url === payload.url || item.website === payload.url || item.url === undefined,
    annotationOk: typeof item.annotation === "string" ? /[\u4e00-\u9fff]/.test(item.annotation) : true,
    folderOk: expectedFolderIds.some((id) => normalizeItemFolderIds(itemFolders).includes(id)),
    rawFolderIds: normalizeItemFolderIds(itemFolders),
    rawFolderNames
  };
}

async function updateItemMetadata(itemId, payload, metadata, folders, annotation) {
  try {
    await request("/api/item/update", {
      method: "POST",
      body: {
        id: itemId,
        annotation: trimField(annotation, 1800),
        tags: buildTags(payload, folders, metadata),
        url: normalizeWebsite(payload.url)
      }
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function fileSize(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch (_error) {
    return 0;
  }
}

function itemHasAnyFolder(item, folders) {
  if (!folders.length) return true;
  const itemFolderIds = normalizeItemFolderIds(item.folderIds || item.folders || []);
  return folders.some((folder) => itemFolderIds.includes(folder.id));
}

function normalizeItemFolderIds(value) {
  const folders = Array.isArray(value) ? value : [value].filter(Boolean);
  return folders.map((folder) => {
    if (typeof folder === "string") return folder;
    if (folder?.id) return String(folder.id);
    return "";
  }).filter(Boolean);
}

function safeShellName(value) {
  return String(value || "asset").replace(/[^\w.-]+/g, "-").slice(0, 60) || "asset";
}

function buildName(payload, metadata) {
  const host = hostnameFromUrl(payload.url);
  const title = metadata.titleZh || payload.title?.trim() || host;
  return `${title} — ${metadata.oneLine || "网页素材参考"}`;
}

function buildAnnotation(payload, metadata) {
  return [
    metadata.summary || buildChineseSummary(payload),
    `保存价值：${metadata.whySaved || "作为网页、产品、设计或内容参考。"}`,
    "Router 记录：由 Chaopi Link Router 自动入库。"
  ].join("\n");
}

function buildTags(payload, folders, metadata) {
  const tags = new Set(["网页收藏", ...folders.map((folder) => folder.name), ...(metadata.tags || [])]);
  if (payload.userNote) tags.add("有备注");
  if (payload.selectedText) tags.add("有摘录");
  return [...tags];
}

async function saveHtmlSnapshot(html, title) {
  const dir = path.join(os.tmpdir(), "chrome-clip-router-assets");
  await fs.mkdir(dir, { recursive: true });
  const filename = `${safeShellName(title)}.html`;
  const filePath = path.join(dir, `${Date.now()}-${filename}`);
  await fs.writeFile(filePath, html, "utf8");
  return { filePath, filename, source: "html-snapshot" };
}

async function revealEagle() {
  await execFileAsync("open", ["-a", "Eagle"], { timeout: 5000 }).catch(() => {});
}

async function request(path, options = {}) {
  const response = await fetch(`${EAGLE_API}${path}`, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.status === "error") {
    throw new Error(data.message || `Eagle API ${path} failed with ${response.status}`);
  }

  return data;
}
