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
  const valid = entries.filter((entry) => entry && entry.url);
  for (const entry of valid) {
    if (String(entry.display_id || "") !== postId || postIdFromUrl(entry.webpage_url) !== postId || entry.extractor_key !== "Twitter") {
      throw identityError("视频归属与当前 X 帖子不一致，已停止识别。");
    }
  }
  const expectedIds = mediaId ? [String(mediaId)] : mediaIds.map(String);
  const matches = expectedIds.length ? valid.filter((entry) => expectedIds.includes(String(entry.id))) : valid;
  if (!matches.length) throw identityError("没有找到与原帖及所选视频匹配的媒体，已停止识别。");
  if (matches.length !== 1) throw identityError("原帖关联多个视频，无法唯一确认所选媒体，请打开具体视频后重试。");
  const entry = matches[0];
  const videoUrl = new URL(entry.url);
  if (!/^https?:$/.test(videoUrl.protocol) || !/(^|\.)video\.twimg\.com$/.test(videoUrl.hostname)) {
    throw identityError("视频来源不是当前 X 帖子的媒体地址，已停止识别。");
  }
  const urlMediaId = twitterMediaId(entry.url);
  if (urlMediaId && urlMediaId !== String(entry.id)) throw identityError("视频地址与媒体 ID 不一致，已停止识别。");
  return {
    postId, mediaId: String(entry.id), videoUrl: entry.url,
    poster: entry.thumbnail || "", duration: Number(entry.duration || 0),
    width: Number(entry.width || 0), height: Number(entry.height || 0)
  };
}

export async function readTwitterVideoInfo(postUrl, options = {}) {
  const { stdout } = await execFileAsync("yt-dlp", [
    ...(options.proxyArgs || []), "--no-playlist", "--skip-download", "--dump-single-json", "--no-warnings", postUrl
  ], { timeout: 15000, maxBuffer: 1024 * 1024 * 8 });
  return selectTwitterVideoInfo(JSON.parse(stdout), postUrl, options);
}
