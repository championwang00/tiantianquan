import assert from "node:assert/strict";
import test from "node:test";
import { __testHooks } from "../src/adapters/eagle.js";

const postUrl = "https://x.com/steveruizok/status/2072651350719058088";
const original = {
  id: "2072646212214267904", display_id: "2072651350719058088", extractor_key: "Twitter",
  webpage_url: postUrl, url: "https://video.twimg.com/amplify_video/2072646212214267904/vid/960x540/original.mp4",
  thumbnail: "https://pbs.twimg.com/amplify_video_thumb/2072646212214267904/img/original.jpg",
  duration: 8.383, width: 960, height: 540
};
const quote = { ...original, id: "999", url: "https://video.twimg.com/amplify_video/999/vid/quote.mp4" };

test("Twitter media id is distinct from post id and remains attached to the verified post", async () => {
  const { selectTwitterVideoInfo } = await import("../src/utils/twitter.js");
  const video = selectTwitterVideoInfo(original, postUrl);
  assert.equal(video.postId, "2072651350719058088");
  assert.equal(video.mediaId, "2072646212214267904");
  assert.equal(video.videoUrl, original.url);
  assert.equal(video.poster, original.thumbnail);
});

test("multiple Twitter videos require identity instead of silently choosing the last file", async () => {
  const { selectTwitterVideoInfo } = await import("../src/utils/twitter.js");
  const info = { _type: "playlist", entries: [original, quote] };
  assert.throws(() => selectTwitterVideoInfo(info, postUrl), /多个|唯一/);
  const video = selectTwitterVideoInfo(info, postUrl, { mediaId: "2072646212214267904" });
  assert.equal(video.mediaId, "2072646212214267904");
});

test("Twitter rejects another post or a replacement for the previewed media", async () => {
  const { selectTwitterVideoInfo } = await import("../src/utils/twitter.js");
  assert.throws(() => selectTwitterVideoInfo({ ...original, display_id: "888" }, postUrl), /归属|不一致/);
  assert.throws(() => selectTwitterVideoInfo({ ...original, webpage_url: "https://x.com/other/status/888" }, postUrl), /归属|不一致/);
  assert.throws(() => selectTwitterVideoInfo(original, postUrl, { mediaId: "999" }), /匹配|不一致/);
});

test("Twitter media selection matches primary DOM video ids instead of a quoted video", async () => {
  const { selectTwitterVideoInfo } = await import("../src/utils/twitter.js");
  const video = selectTwitterVideoInfo({ entries: [quote, original] }, postUrl, { mediaIds: ["2072646212214267904"] });
  assert.equal(video.videoUrl, original.url);
});

test("a Twitter identity failure is not converted into an unrelated fallback save", async () => {
  const error = Object.assign(new Error("视频归属不一致"), { code: "TWITTER_IDENTITY_MISMATCH" });
  let fallbackCalled = false;
  await assert.rejects(__testHooks.importWithFallback({ id: "video", kind: "twitter-url" }, {
    payload: { options: { eagle: { captureMode: "screenshot" } } },
    writePlan: { candidates: [{ id: "screenshot", kind: "screenshot" }] },
    importCandidate: async (candidate) => {
      if (candidate.id === "video") throw error;
      fallbackCalled = true;
      return { ok: true };
    }
  }), /视频归属/);
  assert.equal(fallbackCalled, false);
});
