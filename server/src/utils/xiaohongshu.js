import { parseHTML } from "linkedom";

function identityError(message) {
  return Object.assign(new Error(message), { code: "XIAOHONGSHU_IDENTITY_MISMATCH" });
}

function unavailableError(message) {
  return Object.assign(new Error(message), { code: "XIAOHONGSHU_VIDEO_UNAVAILABLE" });
}

export function xiaohongshuPostId(value) {
  try {
    const url = new URL(value);
    if (!(url.hostname === "xiaohongshu.com" || url.hostname.endsWith(".xiaohongshu.com"))) return "";
    return url.pathname.match(/^\/explore\/([^/]+)/)?.[1] || "";
  } catch (_error) {
    return "";
  }
}

function normalizeCdnUrl(value, kind) {
  const url = new URL(String(value || ""));
  if (!/^https?:$/.test(url.protocol) || !(url.hostname === "xhscdn.com" || url.hostname.endsWith(".xhscdn.com"))) {
    throw identityError(`${kind}不是小红书媒体地址，已停止识别。`);
  }
  if (kind === "视频" && !/\.(?:mp4|m4v|mov|webm|m3u8)$/i.test(url.pathname)) {
    throw identityError("小红书视频格式无法确认，已停止识别。");
  }
  url.protocol = "https:";
  return url.toString();
}

function durationSeconds(value) {
  const text = String(value || "").trim();
  const iso = text.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso) return Number(iso[1] || 0) * 3600 + Number(iso[2] || 0) * 60 + Number(iso[3] || 0);
  const parts = text.split(":").map(Number);
  if (parts.length >= 2 && parts.every(Number.isFinite)) return parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(Number(text)) ? Number(text) : 0;
}

function videoObjects(value) {
  if (Array.isArray(value)) return value.flatMap(videoObjects);
  if (!value || typeof value !== "object") return [];
  const type = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  const current = type.some((item) => String(item).toLowerCase() === "videoobject") ? [value] : [];
  return [...current, ...videoObjects(value["@graph"] || [])];
}

export function parseXiaohongshuVideoInfo(html, postUrl) {
  const postId = xiaohongshuPostId(postUrl);
  if (!postId) throw identityError("无法确认小红书帖子 ID。");
  const { document } = parseHTML(String(html || ""));
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "";
  if (canonical && xiaohongshuPostId(canonical) !== postId) {
    throw identityError("页面内容与请求的小红书帖子不一致，已停止识别。");
  }
  const objects = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .flatMap((script) => {
      try { return videoObjects(JSON.parse(script.textContent || "null")); } catch (_error) { return []; }
    });
  const item = objects.find((object) => object.contentUrl);
  if (!item) throw unavailableError("小红书页面没有可确认的视频信息。");
  const thumbnail = Array.isArray(item.thumbnailUrl) ? item.thumbnailUrl[0] : item.thumbnailUrl;
  return {
    postId,
    videoUrl: normalizeCdnUrl(item.contentUrl, "视频"),
    poster: thumbnail ? normalizeCdnUrl(thumbnail, "封面") : "",
    duration: durationSeconds(item.duration),
    title: String(item.name || "").trim()
  };
}

export async function readXiaohongshuVideoInfo(postUrl, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8000);
  try {
    const response = await (options.fetchImpl || fetch)(postUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome Clip Router",
        Accept: "text/html,application/xhtml+xml"
      }
    });
    if (!response.ok) throw new Error(`小红书页面读取失败：${response.status}`);
    return parseXiaohongshuVideoInfo(await response.text(), postUrl);
  } finally {
    clearTimeout(timer);
  }
}
