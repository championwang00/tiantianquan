import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseHTML } from "linkedom";

const execFileAsync = promisify(execFile);
const CAROUSEL_CACHE_TTL_MS = 5 * 60 * 1000;
const COOKIE_CACHE_TTL_MS = 15 * 60 * 1000;
const carouselCache = new Map();
let cookieCache = null;
const defaultInstagramDependencies = {
  fetchAuthenticated: fetchAuthenticatedInstagramCarousel,
  fetchHtml: fetchInstagramCarouselFromHtml,
  now: () => Date.now()
};
let instagramDependencies = { ...defaultInstagramDependencies };

export function __setInstagramTestHooks(hooks = {}) {
  instagramDependencies = { ...instagramDependencies, ...hooks };
}

export function __resetInstagramTestHooks() {
  instagramDependencies = { ...defaultInstagramDependencies };
  carouselCache.clear();
  cookieCache = null;
}

export async function enrichInstagramPayload(payload) {
  if (!isInstagramPost(payload?.url) || payload.pageAssets?.carousel?.length) return payload;
  try {
    const shortcode = String(payload.url).match(/\/p\/([^/?#]+)/)?.[1] || "";
    const cached = carouselCache.get(shortcode);
    let carousel = cached && cached.expiresAt > instagramDependencies.now() ? cached.carousel : [];
    if (!carousel.length) carousel = await instagramDependencies.fetchAuthenticated(payload.url);
    if (!carousel.length) carousel = await instagramDependencies.fetchHtml(payload.url);
    if (!carousel.length) return payload;
    carouselCache.set(shortcode, { carousel, expiresAt: instagramDependencies.now() + CAROUSEL_CACHE_TTL_MS });
    return {
      ...payload,
      pageAssets: { ...(payload.pageAssets || {}), carousel }
    };
  } catch (_error) {
    return payload;
  }
}

async function fetchInstagramCarouselFromHtml(pageUrl) {
  const args = [
    ...await resolveCurlProxyArgs(),
    "-L", "--compressed", "--max-time", "12", "--fail", "--silent", "--show-error", pageUrl
  ];
  const { stdout } = await execFileAsync("curl", args, { timeout: 15000, maxBuffer: 1024 * 1024 * 8 });
  return extractInstagramCarouselFromHtml(stdout, pageUrl);
}

export function instagramShortcodeToMediaId(shortcode) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let value = 0n;
  for (const character of String(shortcode || "")) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return "";
    value = value * 64n + BigInt(digit);
  }
  return value ? value.toString() : "";
}

export function extractInstagramCarouselFromGraphql(response, shortcode) {
  const items = response?.data?.xdt_api__v1__media__media_id_web_info?.items;
  const post = Array.isArray(items) ? items.find((item) => item?.code === shortcode) || items[0] : null;
  const media = Array.isArray(post?.carousel_media) ? post.carousel_media : post ? [post] : [];
  return media.map(normalizeMedia).filter(Boolean);
}

async function fetchAuthenticatedInstagramCarousel(pageUrl) {
  if (process.platform !== "darwin") return [];
  const shortcode = String(pageUrl || "").match(/\/p\/([^/?#]+)/)?.[1] || "";
  const mediaId = instagramShortcodeToMediaId(shortcode);
  if (!mediaId) return [];
  const profile = path.join(os.homedir(), "Library", "Application Support", "Dia", "User Data", "Default");
  let cookies = cookieCache && cookieCache.expiresAt > Date.now() ? cookieCache.cookies : null;
  if (!cookies) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clip-router-instagram-"));
    const cookieFile = path.join(tempDir, "cookies.txt");
    try {
    await execFileAsync("yt-dlp", [
      "--cookies-from-browser", `chrome:${profile}`,
      "--cookies", cookieFile,
      "--skip-download",
      "https://www.instagram.com/"
    ], { timeout: 30000, maxBuffer: 1024 * 1024 * 2 }).catch(async (error) => {
      const exported = await fs.stat(cookieFile).then((stat) => stat.size > 0).catch(() => false);
      if (!exported) throw error;
    });
      cookies = Object.fromEntries((await fs.readFile(cookieFile, "utf8")).split(/\r?\n/)
      .filter((line) => line.startsWith(".instagram.com\t"))
      .map((line) => line.split("\t"))
      .filter((parts) => parts.length >= 7)
      .map((parts) => [parts[5], parts[6]]));
      cookieCache = { cookies, expiresAt: Date.now() + COOKIE_CACHE_TTL_MS };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  try {
    const proxyArgs = await resolveCurlProxyArgs();
    const variables = JSON.stringify({ mediaId });
    const { stdout } = await execFileAsync("curl", [
      ...proxyArgs,
      "--compressed", "--max-time", "20", "--fail", "--silent", "--show-error",
      "--header", `Cookie: ${Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ")}`,
      "--user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36",
      "--header", "X-IG-App-ID: 936619743392459",
      "--header", "X-ASBD-ID: 129477",
      "--header", "X-FB-LSD: AVqbxe3J_YA",
      "--header", `X-CSRFToken: ${cookies.csrftoken || ""}`,
      "--header", "X-FB-Friendly-Name: PolarisPostActionLoadPostQueryMediaIdQuery",
      "--header", `Referer: ${pageUrl}`,
      "--data-urlencode", "__user=0",
      "--data-urlencode", `av=${cookies.ds_user_id || ""}`,
      "--data-urlencode", "doc_id=27211511638502089",
      "--data-urlencode", `variables=${variables}`,
      "https://www.instagram.com/graphql/query"
    ], { timeout: 25000, maxBuffer: 1024 * 1024 * 8 });
    return extractInstagramCarouselFromGraphql(JSON.parse(stdout), shortcode);
  } catch (error) {
    cookieCache = null;
    throw error;
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
  const videos = Array.isArray(media?.video_versions) ? media.video_versions : [];
  const isVideo = videos.length > 0 || Number(media?.media_type) === 2 || /VideoMedia/i.test(String(media?.__typename || ""));
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
