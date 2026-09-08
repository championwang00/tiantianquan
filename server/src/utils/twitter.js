import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function postIdFromUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)(x|twitter)\.com$/.test(url.hostname) ? url.pathname.match(/\/status\/(\d+)/)?.[1] || "" : "";
  } catch { return ""; }
}

export function twitterMediaId(value) {
  return String(value || "").match(/\/(?:amplify_video|ext_tw_video)(?:_thumb)?\/(\d+)\//)?.[1] || "";
}

function identityError(message) {
  return Object.assign(new Error(message), { code: "TWITTER_IDENTITY_MISMATCH" });
}

export function selectTwitterVideoInfo(info, postUrl, { mediaId = "", mediaIds = [] } = {}) {
  const postId = postIdFromUrl(postUrl);
  if (!postId) throw identityError("无法确认 X 帖子 ID。");
  const entries = Array.isArray(info.entries) ? info.entries : [info];
  const valid = entries
    .filter(Boolean)
    .map((entry) => ({ entry, media: resolveTwitterEntryMedia(entry) }))
    .filter(({ media }) => media.url);
  for (const { entry } of valid) {
    if (String(entry.display_id || "") !== postId || postIdFromUrl(entry.webpage_url) !== postId || entry.extractor_key !== "Twitter") {
      throw identityError("视频归属与当前 X 帖子不一致，已停止识别。");
    }
  }
  const expectedIds = mediaId ? [String(mediaId)] : mediaIds.map(String);
  const matches = expectedIds.length ? valid.filter(({ entry }) => expectedIds.includes(String(entry.id))) : valid;
  if (!matches.length) throw identityError("没有找到与原帖及所选视频匹配的媒体，已停止识别。");
  if (matches.length !== 1) throw identityError("原帖关联多个视频，无法唯一确认所选媒体，请打开具体视频后重试。");
  const { entry, media } = matches[0];
  const videoUrl = new URL(media.url);
  if (!/^https?:$/.test(videoUrl.protocol) || !/(^|\.)video\.twimg\.com$/.test(videoUrl.hostname)) {
    throw identityError("视频来源不是当前 X 帖子的媒体地址，已停止识别。");
  }
  const urlMediaId = twitterMediaId(media.url);
  if (urlMediaId && urlMediaId !== String(entry.id)) throw identityError("视频地址与媒体 ID 不一致，已停止识别。");
  return {
    postId, mediaId: String(entry.id), videoUrl: media.url,
    poster: entry.thumbnail || "", duration: Number(entry.duration || 0),
    width: Number(entry.width || media.width || 0), height: Number(entry.height || media.height || 0)
  };
}

function resolveTwitterEntryMedia(entry) {
  const directUrl = String(entry?.url || "").trim();
  if (directUrl) return { url: directUrl, width: entry.width, height: entry.height };

  const formats = [...(entry?.formats || []), ...(entry?.requested_formats || [])]
    .filter((format) => format && String(format.url || "").trim())
    .filter((format) => format.vcodec !== "none" && (Number(format.width || 0) > 0 || Number(format.height || 0) > 0 || format.vcodec))
    .map((format) => ({ ...format, url: String(format.url).trim(), score: twitterFormatScore(format) }))
    .sort((a, b) => b.score - a.score);
  const best = formats[0];
  return best ? { url: best.url, width: best.width, height: best.height } : { url: "", width: 0, height: 0 };
}

function twitterFormatScore(format) {
  let directMp4 = 0;
  try {
    directMp4 = new URL(format.url).pathname.endsWith(".mp4") && !String(format.protocol || "").startsWith("m3u8") ? 1 : 0;
  } catch (_error) {
    return -1;
  }
  return directMp4 * 1e12
    + Number(format.width || 0) * Number(format.height || 0) * 1000
    + Number(format.tbr || 0);
}

export async function readTwitterVideoInfo(postUrl, options = {}) {
  const { stdout } = await execFileAsync("yt-dlp", [
    ...(options.proxyArgs || []), "--no-playlist", "--skip-download", "--dump-single-json", "--no-warnings", postUrl
  ], { timeout: 15000, maxBuffer: 1024 * 1024 * 8 });
  return selectTwitterVideoInfo(JSON.parse(stdout), postUrl, options);
}
