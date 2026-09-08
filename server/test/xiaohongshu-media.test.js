import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { parseHTML } from "linkedom";
import { __testHooks } from "../src/adapters/eagle.js";
import { parseXiaohongshuVideoInfo } from "../src/utils/xiaohongshu.js";

const postUrl = "https://www.xiaohongshu.com/explore/6a9cf9340000000028037b90?xsec_token=test";
const videoUrl = "https://sns-video-qc.xhscdn.com/stream/1/110/259/original.mp4?sign=test";
const poster = "https://sns-webpic-qc.xhscdn.com/cover/original.jpg";

function pageHtml() {
  return `<!doctype html><html><head>
    <title>Sports Life System Coming soon - 小红书</title>
    <link rel="canonical" href="https://www.xiaohongshu.com/explore/6a9cf9340000000028037b90">
    <meta property="og:image" content="https://picasso-static.xiaohongshu.com/fe-platform/app-icon.png">
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "VideoObject",
      name: "Sports Life System Coming soon - 小红书",
      contentUrl: videoUrl,
      thumbnailUrl: poster.replace("https:", "http:"),
      duration: "PT10.6S"
    })}</script>
    <script src="https://fe-static.xhscdn.com/formula-static/video-runtime.js"></script>
    <link rel="icon" href="https://fe-video-qc.xhscdn.com/fe-platform/site.ico">
  </head><body>
    <main><img src="https://sns-webpic-qc.xhscdn.com/feed/unrelated.jpg" width="640" height="853"></main>
    <div id="noteContainer" class="note-container" data-type="video">
      <div class="media-container">
        <video src="blob:https://www.xiaohongshu.com/player" width="400" height="600"></video>
        <div class="xgplayer-poster" style="background-image:url('${poster.replace("https:", "http:")}')"></div>
      </div>
      <img class="avatar-item" src="https://sns-avatar-qc.xhscdn.com/avatar/user" width="120" height="120">
    </div>
  </body></html>`;
}

function extensionContext(file) {
  const { document, window } = parseHTML(pageHtml());
  for (const video of document.querySelectorAll("video")) {
    video.src = video.getAttribute("src");
    video.getBoundingClientRect = () => ({ left: 10, top: 20, right: 410, bottom: 620, width: 400, height: 600 });
  }
  const noop = () => {};
  const context = vm.createContext({
    document, window, Node: window.Node, URL,
    location: new URL(postUrl),
    performance: { getEntriesByType: () => [
      { name: "https://fe-static.xhscdn.com/formula-static/video-player.js", initiatorType: "script" },
      { name: "https://fe-video-qc.xhscdn.com/fe-platform/site.ico", initiatorType: "link" }
    ] },
    importScripts: noop, confirmObsidian: noop,
    chrome: {
      runtime: { onInstalled: { addListener: noop }, onMessage: { addListener: noop } },
      contextMenus: { onClicked: { addListener: noop } },
      scripting: { executeScript: async ({ func, args }) => func ? [{ result: await func(...args) }] : [] }
    }
  });
  const source = fs.readFileSync(path.resolve(import.meta.dirname, `../../extension/${file}`), "utf8").replace(/^init\(\);$/m, "");
  vm.runInContext(source, context);
  return context;
}

test("parses the exact Xiaohongshu post video, cover and duration from JSON-LD", () => {
  const video = parseXiaohongshuVideoInfo(pageHtml(), postUrl);
  assert.deepEqual(video, {
    postId: "6a9cf9340000000028037b90",
    videoUrl,
    poster,
    duration: 10.6,
    title: "Sports Life System Coming soon - 小红书"
  });
});

test("rejects Xiaohongshu media when the canonical post identity differs", () => {
  const html = pageHtml().replaceAll("6a9cf9340000000028037b90", "other-post");
  assert.throws(() => parseXiaohongshuVideoInfo(html, postUrl), /帖子.*不一致|归属.*不一致/);
});

test("builds one verified Xiaohongshu video candidate and ignores captured scripts, icons and feed images", async () => {
  const candidates = await __testHooks.buildImportCandidates({
    url: postUrl,
    title: "Sports Life System Coming soon",
    options: { eagle: { captureMode: "screenshot" } },
    pageMeta: { image: "https://picasso-static.xiaohongshu.com/fe-platform/app-icon.png" },
    pageAssets: {
      videos: [
        { src: "https://fe-static.xhscdn.com/formula-static/video-runtime.js" },
        { src: "https://fe-video-qc.xhscdn.com/fe-platform/site.ico" }
      ],
      images: [{ src: "https://sns-webpic-qc.xhscdn.com/feed/unrelated.jpg" }],
      videoRects: [{ width: 400, height: 600 }]
    },
    pageContent: {}
  }, { titleZh: "运动生活系统" }, {
    readXiaohongshuVideoInfo: async () => ({
      postId: "6a9cf9340000000028037b90",
      videoUrl,
      poster,
      duration: 10.6
    })
  });

  const media = __testHooks.summarizeCandidates(candidates)
    .filter((candidate) => candidate.kind !== "url");
  assert.deepEqual(media.map((candidate) => candidate.kind), ["xiaohongshu-url"]);
  assert.equal(media[0].id, "xiaohongshu-video:6a9cf9340000000028037b90");
  assert.equal(media[0].mediaUrl, videoUrl);
  assert.equal(media[0].poster, poster);
  assert.equal(media[0].duration, 10.6);
  assert.equal(media[0].selected, true);
});

test("does not fall back to stale captured media when Xiaohongshu post identity mismatches", async () => {
  await assert.rejects(() => __testHooks.buildImportCandidates({
    url: postUrl,
    options: { eagle: { captureMode: "screenshot" } },
    pageMeta: {},
    pageAssets: { videos: [{ src: videoUrl }], images: [], videoRects: [] },
    pageContent: {}
  }, {}, {
    readXiaohongshuVideoInfo: async () => {
      throw Object.assign(new Error("帖子不一致"), { code: "XIAOHONGSHU_IDENTITY_MISMATCH" });
    }
  }), /帖子不一致/);
});

for (const [file, collector] of [["background.js", "collectPageContextInBackground"], ["popup.js", "collectPageContext"]]) {
  test(`${file}: Xiaohongshu scans only the post media and reads its structured cover`, async () => {
    const context = extensionContext(file);
    const result = await context[collector]({ id: 1 }, { fullContent: false, deepAssets: true });
    assert.deepEqual(Array.from(result.assets.videos, (video) => video.src), [videoUrl]);
    assert.equal(result.assets.videos[0].poster, poster);
    assert.equal(result.assets.videos[0].duration, 10.6);
    assert.deepEqual(Array.from(result.assets.images, (image) => image.src), []);
    assert.equal(result.meta.image, poster);
  });
}
