import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseHTML } from "linkedom";

const execFileAsync = promisify(execFile);

export async function enrichInstagramPayload(payload) {
  if (!isInstagramPost(payload?.url) || payload.pageAssets?.carousel?.length) return payload;
  try {
    const args = [
      ...await resolveCurlProxyArgs(),
      "-L", "--compressed", "--max-time", "20", "--fail", "--silent", "--show-error", payload.url
    ];
    const { stdout } = await execFileAsync("curl", args, { timeout: 25000, maxBuffer: 1024 * 1024 * 8 });
    const carousel = extractInstagramCarouselFromHtml(stdout, payload.url);
    if (!carousel.length) return payload;
    return {
      ...payload,
      pageAssets: { ...(payload.pageAssets || {}), carousel }
    };
  } catch (_error) {
    return payload;
  }
}

export function extractInstagramCarouselFromHtml(html, pageUrl) {
  const shortcode = String(pageUrl || "").match(/\/p\/([^/?#]+)/)?.[1] || "";
  if (!shortcode) return [];
  const { document } = parseHTML(String(html || ""));
  let carousel = null;
  const walk = (value, depth = 0) => {
    if (carousel || value == null || depth > 18 || typeof value !== "object") return;
    if (value.code === shortcode && Array.isArray(value.carousel_media)) {
      carousel = value.carousel_media;
      return;
    }
    const children = Array.isArray(value) ? value : Object.values(value);
    for (let index = 0; index < Math.min(children.length, 500); index += 1) walk(children[index], depth + 1);
  };
  for (const script of document.querySelectorAll("script")) {
    const text = script.textContent || "";
    if (!text.includes(shortcode)) continue;
    try { walk(JSON.parse(text)); } catch (_error) { /* Ignore executable scripts. */ }
    if (carousel) break;
  }
  return (carousel || []).map(normalizeMedia).filter(Boolean);
}

function normalizeMedia(media, index) {
  const isVideo = Number(media?.media_type) === 2 || /VideoMedia/i.test(String(media?.__typename || ""));
  const videos = Array.isArray(media?.video_versions) ? media.video_versions : [];
  const video = videos.slice().sort(byArea)[0];
  const images = Array.isArray(media?.image_versions2?.candidates) ? media.image_versions2.candidates : [];
  const image = images.slice().sort(byArea)[0];
  const src = isVideo ? String(video?.url || "") : String(media?.display_uri || image?.url || "");
  if (!/^https?:\/\//i.test(src)) return null;
  const duration = String(media?.video_dash_manifest || "").match(/mediaPresentationDuration="PT([\d.]+)S"/i)?.[1];
  return {
    index,
    type: isVideo ? "video" : "image",
    src,
    poster: isVideo ? String(media?.display_uri || image?.url || "") : "",
    mediaId: String(media?.pk || media?.id || "").replace(/^POLARIS_/, ""),
    shortcode: String(media?.code || ""),
    description: String(media?.accessibility_caption || "").trim(),
    duration: Number(duration || media?.video_duration || 0),
    width: Number(media?.original_width || video?.width || image?.width || 0),
    height: Number(media?.original_height || video?.height || image?.height || 0)
  };
}

function byArea(a, b) {
  return Number(b?.width || 0) * Number(b?.height || 0) - Number(a?.width || 0) * Number(a?.height || 0);
}

function isInstagramPost(value) {
  try {
    const url = new URL(value);
    return (url.hostname === "instagram.com" || url.hostname.endsWith(".instagram.com")) && /\/p\/[^/]+/.test(url.pathname);
  } catch (_error) {
    return false;
  }
}

async function resolveCurlProxyArgs() {
  const configured = process.env.CLIP_ROUTER_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy;
  if (configured) return ["--proxy", configured];
  if (process.platform !== "darwin") return [];
  try {
    const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--proxy"], { timeout: 3000 });
    for (const prefix of ["HTTPS", "HTTP"]) {
      const enabled = stdout.match(new RegExp(`(?:^|\\n)\\s*${prefix}Enable\\s*:\\s*1`));
      const host = stdout.match(new RegExp(`(?:^|\\n)\\s*${prefix}Proxy\\s*:\\s*([^\\s]+)`))?.[1];
      const port = stdout.match(new RegExp(`(?:^|\\n)\\s*${prefix}Port\\s*:\\s*(\\d+)`))?.[1];
      if (enabled && host && port) return ["--proxy", `http://${host}:${port}`];
    }
  } catch (_error) { /* Direct curl remains available as a fallback. */ }
  return [];
}
