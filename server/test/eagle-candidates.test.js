import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { __testHooks } from "../src/adapters/eagle.js";

test("prefers the visible screenshot for X posts when Eagle is in screenshot mode", async () => {
  const candidates = await __testHooks.buildImportCandidates({
    url: "https://x.com/nickarceco/status/2067371464957825157",
    title: "Nicholas Arce on X",
    options: { eagle: { captureMode: "screenshot" } },
    pageMeta: {},
    pageAssets: {
      images: [],
      videos: [],
      videoRects: []
    },
    pageContent: {},
    screenshotDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw2NqgAAAABJRU5ErkJggg=="
  }, {
    titleZh: "Nicholas Arce X",
    oneLine: "X post",
    summary: "X post",
    tags: ["X"],
    contentType: "tweet",
    whySaved: "Reference"
  });

  const summarized = __testHooks.summarizeCandidates(candidates);
  const selected = summarized.filter((candidate) => candidate.selected).map((candidate) => candidate.kind);

  assert.deepEqual(selected, ["screenshot"]);
});

test("selects the screenshot candidate over an X video candidate in screenshot mode", () => {
  const candidates = __testHooks.selectDefaultCandidates([
    { id: "twitter-video:1", kind: "twitter-url", selected: true },
    { id: "screenshot:1", kind: "screenshot", selected: false },
    { id: "url:1", kind: "url", selected: false }
  ], "screenshot");

  assert.deepEqual(candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.kind), ["screenshot"]);
});

test("falls back to the screenshot candidate when a selected X video import fails", async () => {
  const calls = [];
  const writePlan = {
    candidates: [
      { id: "twitter-video:1", kind: "twitter-url", selected: true },
      { id: "screenshot:1", kind: "screenshot", selected: false, asset: { filePath: "/tmp/fallback.png" } },
      { id: "url:1", kind: "url", selected: false }
    ]
  };

  const result = await __testHooks.importWithFallback(writePlan.candidates[0], {
    payload: { options: { eagle: { captureMode: "screenshot" } } },
    writePlan,
    importCandidate: async (candidate) => {
      calls.push(candidate.kind);
      if (candidate.kind === "twitter-url") throw new Error("yt-dlp timed out");
      return { ok: true };
    }
  });

  assert.deepEqual(calls, ["twitter-url", "screenshot"]);
  assert.equal(result.response.ok, true);
  assert.equal(result.candidate.kind, "screenshot");
  assert.match(result.fallbackReason, /yt-dlp timed out/);
});

test("preserves Instagram carousel order, deduplicates media, and includes carousel metadata", async () => {
  const candidates = await __testHooks.buildImportCandidates({
    url: "https://www.instagram.com/p/ABC123/",
    title: "Instagram post",
    options: { eagle: { captureMode: "top-image" } },
    pageMeta: { image: "https://cdn.example/avatar.jpg" },
    pageAssets: {
      carousel: [
        { index: 0, type: "image", src: "https://cdn.example/one.jpg", width: 1080, height: 1350 },
        { index: 1, type: "video", src: "https://cdn.example/two.mp4", poster: "https://cdn.example/two.jpg", duration: 4.2, width: 1080, height: 1920 },
        { index: 1, type: "video", src: "https://cdn.example/two.mp4", poster: "https://cdn.example/two.jpg" },
        { index: 2, type: "image", src: "https://cdn.example/three.jpg", width: 1080, height: 1080 }
      ],
      images: [{ src: "https://cdn.example/comment-avatar.jpg" }],
      videos: []
    },
    pageContent: {}
  }, { titleZh: "Instagram 帖子" });

  const carousel = __testHooks.summarizeCandidates(candidates)
    .filter((candidate) => candidate.carouselIndex !== undefined);
  assert.deepEqual(carousel.map((candidate) => candidate.kind), ["asset-url", "media-url", "asset-url"]);
  assert.deepEqual(carousel.map((candidate) => candidate.carouselIndex), [0, 1, 2]);
  assert.deepEqual(carousel.map((candidate) => candidate.postUrl), Array(3).fill("https://www.instagram.com/p/ABC123/"));
  assert.equal(new Set(carousel.map((candidate) => candidate.id)).size, 3);
  assert.equal(carousel[1].duration, 4.2);
  assert.deepEqual(carousel.map((candidate) => candidate.id), [
    "instagram:ABC123:0:image",
    "instagram:ABC123:1:video",
    "instagram:ABC123:2:image"
  ]);
});

test("Instagram carousel IDs do not change when signed CDN URLs rotate", async () => {
  const payload = (token) => ({
    url: "https://www.instagram.com/p/ABC123/?img_index=2",
    options: { eagle: { captureMode: "top-image" } }, pageMeta: {}, pageContent: {},
    pageAssets: { carousel: [{ index: 0, type: "image", src: `https://scontent.cdn/one.jpg?token=${token}` }] }
  });
  const first = await __testHooks.buildImportCandidates(payload("old"), { titleZh: "IG" });
  const second = await __testHooks.buildImportCandidates(payload("new"), { titleZh: "IG" });
  assert.equal(first[0].id, second[0].id);
});

test("Instagram fallback accepts only the exact playlist index and captured video metadata", () => {
  const candidate = { carouselIndex: 3, duration: 8.2, width: 1080, height: 1920 };
  assert.equal(__testHooks.instagramEntryMatchesCandidate({ playlist_index: 4, duration: 8.1, width: 1080, height: 1920 }, candidate), true);
  assert.equal(__testHooks.instagramEntryMatchesCandidate({ playlist_index: 3, duration: 8.1, width: 1080, height: 1920 }, candidate), false);
  assert.equal(__testHooks.instagramEntryMatchesCandidate({ playlist_index: 4, duration: 21, width: 1080, height: 1920 }, candidate), false);
  assert.equal(__testHooks.instagramEntryMatchesCandidate({ id: "video-b", playlist_index: 4, duration: 8.1, width: 1080, height: 1920 }, { ...candidate, carouselVideoCount: 2, mediaId: "video-a" }), false);
  assert.equal(__testHooks.instagramEntryMatchesCandidate({ id: "video-a", playlist_index: 4, duration: 8.1, width: 1080, height: 1920 }, { ...candidate, carouselVideoCount: 2, mediaId: "video-a" }), true);
});

test("background and popup Instagram capture keep transition, cap, restoration, and semantic scope safeguards", () => {
  for (const relative of ["../../extension/background.js", "../../extension/popup.js"]) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, relative), "utf8");
    assert.match(source, /traverseCarousel/);
    assert.match(source, /waitForChange/);
    assert.match(source, /maxTransitions: 30/);
    assert.match(source, /header, nav, aside/);
    assert.match(source, /svg title/);
    assert.doesNotMatch(source, /carouselRoot/);
    assert.match(source, /\.\.\.root\.querySelectorAll\('video, img'\)/);
  }
});

test("carousel traversal starts at first, orders and dedupes assets, stops at end, and restores a middle slide", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../extension/instagramCarousel.js"), "utf8"), context);
  const traverse = context.globalThis.traverseInstagramCarousel;
  const slides = [
    [{ type: "image", src: "first" }, { type: "image", src: "unrelated", excluded: true }],
    [{ type: "video", src: "current", mediaId: "v2" }, { type: "video", src: "current", mediaId: "v2" }],
    [{ type: "image", src: "last" }]
  ];
  let position = 1;
  let wrapper = { connected: true, assets: slides[position], buttons: [{ kind: "mute", navigation: false }] };
  const replaceWrapper = (next) => { wrapper.connected = false; position = next; wrapper = { connected: true, assets: slides[position], buttons: [{ kind: "tag", navigation: false }] }; };
  const transition = async (before) => slides[position][0].src === before ? "" : slides[position][0].src;
  const assets = await traverse({
    read: () => wrapper.connected ? wrapper.assets.filter((asset) => !asset.excluded) : [],
    signature: () => slides[position][0].src,
    clickPrevious: () => position > 0 ? (replaceWrapper(position - 1), true) : false,
    clickNext: () => position < slides.length - 1 ? (replaceWrapper(position + 1), true) : false,
    waitForChange: transition
  });
  assert.deepEqual(JSON.parse(JSON.stringify(assets)).map(({ src, index }) => ({ src, index })), [
    { src: "first", index: 0 }, { src: "current", index: 1 }, { src: "last", index: 2 }
  ]);
  assert.equal(position, 1);
});
