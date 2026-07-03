import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

test("imports selected candidates in canonical order and continues after one fails", async () => {
  const candidates = [
    { id: "first", kind: "asset-url" },
    { id: "second", kind: "asset-url" },
    { id: "third", kind: "asset-url" }
  ];
  const attempts = [];
  const result = await __testHooks.executeCandidateBatch(candidates, async (candidate) => {
    attempts.push(candidate.id);
    if (candidate.id === "second") throw new Error("second exploded");
    return { candidateId: candidate.id, itemId: `item-${candidate.id}` };
  });

  assert.deepEqual(attempts, ["first", "second", "third"]);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.items.map((item) => [item.candidateId, item.status]), [
    ["first", "success"], ["second", "failed"], ["third", "success"]
  ]);
  assert.match(result.items[1].reason, /second exploded/);
});

test("legacy single candidateId resolves as a one-element selection", () => {
  const candidates = [{ id: "first" }, { id: "second" }, { id: "third" }];
  assert.deepEqual(
    __testHooks.normalizeSelectedCandidates({ candidates }, "second").map((candidate) => candidate.id),
    ["second"]
  );
});

test("explicit unknown candidate IDs resolve none instead of silently importing the first", () => {
  const candidates = [{ id: "first" }, { id: "second" }];
  assert.deepEqual(__testHooks.normalizeSelectedCandidates({ candidates }, ["missing"]), []);
});

test("fallback never consumes another explicitly selected candidate", async () => {
  const candidates = [
    { id: "video-a", kind: "media-url", selected: true },
    { id: "image-b", kind: "asset-url", selected: true },
    { id: "url-fallback", kind: "url", selected: false }
  ];
  const calls = [];
  const result = await __testHooks.importWithFallback(candidates[0], {
    payload: { options: { eagle: { captureMode: "top-image" } } },
    writePlan: { candidates },
    excludedCandidateIds: new Set(candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.id)),
    importCandidate: async (candidate) => {
      calls.push(candidate.id);
      if (candidate.id === "video-a") throw new Error("video failed");
      return { ok: true };
    }
  });
  assert.deepEqual(calls, ["video-a", "url-fallback"]);
  assert.equal(result.candidate.id, "url-fallback");
});

test("batch defers and deduplicates owned temp cleanup until every candidate is processed", async () => {
  const dir = path.join(os.tmpdir(), "chrome-clip-router-assets");
  fs.mkdirSync(dir, { recursive: true });
  const shared = path.join(dir, `batch-shared-${Date.now()}.png`);
  fs.writeFileSync(shared, "asset");
  const candidates = [
    { id: "first", asset: { filePath: shared } },
    { id: "second", asset: { filePath: shared } }
  ];
  const observed = [];
  await __testHooks.executeCandidateBatch(candidates, async (candidate) => {
    observed.push([candidate.id, fs.existsSync(shared)]);
    return { itemId: candidate.id };
  });
  assert.deepEqual(observed, [["first", true], ["second", true]]);
  assert.equal(fs.existsSync(shared), false);
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

test("extracts every Instagram carousel item from embedded Relay data when the post has no article DOM", () => {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../extension/instagramCarousel.js"), "utf8"), context);
  const embedded = JSON.stringify({
    require: [["RelayPrefetchedStreamCache", "next", [], [{
      result: { data: { xig_polaris_media: {
        code: "DaKqRpCCjbf",
        if_not_gated_logged_out: {
          code: "DaKqRpCCjbf",
          carousel_media: [
            {
              __typename: "XIGPolarisVideoMedia",
              media_type: 2,
              pk: "video-pk",
              code: "video-code",
              display_uri: "https://cdn.example/video-cover.jpg",
              original_width: 1080,
              original_height: 1350,
              accessibility_caption: "Animated AI OS interface",
              video_versions: [{ url: "https://cdn.example/video.mp4", width: 720, height: 900 }]
            },
            {
              __typename: "XIGPolarisImageMedia",
              media_type: 1,
              pk: "image-1",
              code: "image-code-1",
              display_uri: "https://cdn.example/image-1.jpg",
              original_width: 1024,
              original_height: 1280,
              accessibility_caption: "AI radio interface"
            },
            {
              __typename: "XIGPolarisImageMedia",
              media_type: 1,
              pk: "image-2",
              code: "image-code-2",
              image_versions2: { candidates: [{ url: "https://cdn.example/image-2.jpg", width: 1024, height: 1280 }] },
              accessibility_caption: "AI search interface"
            }
          ]
        }
      } } }
    }]]]
  });

  const assets = context.globalThis.extractInstagramEmbeddedCarousel(
    ["not json", embedded],
    "https://www.instagram.com/p/DaKqRpCCjbf?img_index=1&utm_source=muzli"
  );

  assert.deepEqual(JSON.parse(JSON.stringify(assets)), [
    {
      index: 0,
      type: "video",
      src: "https://cdn.example/video.mp4",
      poster: "https://cdn.example/video-cover.jpg",
      mediaId: "video-pk",
      shortcode: "video-code",
      description: "Animated AI OS interface",
      duration: 0,
      width: 1080,
      height: 1350
    },
    {
      index: 1,
      type: "image",
      src: "https://cdn.example/image-1.jpg",
      poster: "",
      mediaId: "image-1",
      shortcode: "image-code-1",
      description: "AI radio interface",
      duration: 0,
      width: 1024,
      height: 1280
    },
    {
      index: 2,
      type: "image",
      src: "https://cdn.example/image-2.jpg",
      poster: "",
      mediaId: "image-2",
      shortcode: "image-code-2",
      description: "AI search interface",
      duration: 0,
      width: 1024,
      height: 1280
    }
  ]);
});

test("Instagram fallback accepts only the exact playlist index and captured video metadata", () => {
  const candidate = { carouselIndex: 3, duration: 8.2, width: 1080, height: 1920 };
  assert.equal(__testHooks.instagramEntryMatchesCandidate({ playlist_index: 4, duration: 8.1, width: 1080, height: 1920 }, candidate), true);
  assert.equal(__testHooks.instagramEntryMatchesCandidate({ playlist_index: 3, duration: 8.1, width: 1080, height: 1920 }, candidate), false);
  assert.equal(__testHooks.instagramEntryMatchesCandidate({ playlist_index: 4, duration: 21, width: 1080, height: 1920 }, candidate), false);
  assert.equal(__testHooks.instagramEntryMatchesCandidate({ id: "video-b", playlist_index: 4, duration: 8.1, width: 1080, height: 1920 }, { ...candidate, carouselVideoCount: 2, mediaId: "video-a" }), false);
  assert.equal(__testHooks.instagramEntryMatchesCandidate({ id: "video-a", playlist_index: 4, duration: 8.1, width: 1080, height: 1920 }, { ...candidate, carouselVideoCount: 2, mediaId: "video-a" }), true);
});

test("reads the active macOS HTTPS proxy for yt-dlp media downloads", () => {
  assert.equal(__testHooks.parseMacProxy(`
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
}`), "http://127.0.0.1:7897");
  assert.equal(__testHooks.parseMacProxy("HTTPEnable : 0\nHTTPSEnable : 1\nHTTPSPort : 7897\nHTTPSProxy : 127.0.0.1"), "http://127.0.0.1:7897");
  assert.equal(__testHooks.parseMacProxy("HTTPSEnable : 0\nHTTPSPort : 7897\nHTTPSProxy : 127.0.0.1"), "");
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

test("MV3 collectors inject the shared traversal file before use and never use dynamic code evaluation", () => {
  for (const relative of ["../../extension/background.js", "../../extension/popup.js"]) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, relative), "utf8");
    const injection = source.indexOf('files: ["instagramCarousel.js"]');
    const collector = source.indexOf("const traverseCarousel = globalThis.traverseInstagramCarousel", injection);
    assert.ok(injection >= 0 && collector > injection);
    assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\b/);
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

test("carousel traversal applies independent 30-step backward and forward caps", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../extension/instagramCarousel.js"), "utf8"), context);
  const slides = Array.from({ length: 90 }, (_, index) => [{ type: "image", src: `slide-${index}` }]);
  let position = 45;
  let previousClicks = 0;
  let nextClicks = 0;
  const assets = await context.globalThis.traverseInstagramCarousel({
    read: () => slides[position],
    signature: () => slides[position][0].src,
    clickPrevious: () => { previousClicks += 1; position -= 1; return true; },
    clickNext: () => { nextClicks += 1; position += 1; return true; },
    waitForChange: async () => slides[position][0].src,
    maxTransitions: 30
  });
  assert.equal(previousClicks, 30);
  assert.equal(nextClicks, 30);
  assert.equal(assets.length, 31);
  assert.equal(assets[0].src, "slide-15");
  assert.equal(assets.at(-1).src, "slide-45");
});

test("carousel restoration is bounded and falls back to the opposite direction", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../extension/instagramCarousel.js"), "utf8"), context);
  let position = 1;
  let collecting = true;
  let restorePreviousClicks = 0;
  let restoreNextClicks = 0;
  const slides = ["first", "initial", "last"];
  const result = await context.globalThis.traverseInstagramCarousel({
    read: () => [{ type: "image", src: slides[position] }],
    signature: () => slides[position],
    clickPrevious: () => {
      if (position === 1) { position = 0; return true; }
      if (position === 2) { collecting = false; restorePreviousClicks += 1; position = 0; return true; }
      if (!collecting) restorePreviousClicks += 1;
      return false;
    },
    clickNext: () => {
      if (!collecting) restoreNextClicks += 1;
      if (position >= 2) return false;
      position += 1;
      return true;
    },
    waitForChange: async () => slides[position],
    maxTransitions: 30
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)).map((asset) => asset.src), slides);
  assert.equal(position, 1);
  assert.ok(restorePreviousClicks <= 30);
  assert.ok(restoreNextClicks <= 30);
  assert.equal(restoreNextClicks, 1);
});

test("carousel restoration caps both directions at 30 when signatures keep changing but initial is never reached", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(import.meta.dirname, "../../extension/instagramCarousel.js"), "utf8"), context);
  let current = "initial";
  let discoveryPrevious = true;
  let collectionNext = true;
  let restorePreviousClicks = 0;
  let fallbackNextClicks = 0;
  await context.globalThis.traverseInstagramCarousel({
    read: () => [{ type: "image", src: current }],
    signature: () => current,
    clickPrevious: () => {
      if (discoveryPrevious) { discoveryPrevious = false; return false; }
      restorePreviousClicks += 1;
      current = `restore-previous-${restorePreviousClicks}`;
      return true;
    },
    clickNext: () => {
      if (collectionNext) { collectionNext = false; current = "collection-end"; return true; }
      if (current === "collection-end") return false;
      fallbackNextClicks += 1;
      current = `fallback-next-${fallbackNextClicks}`;
      return true;
    },
    waitForChange: async () => current,
    maxTransitions: 30
  });
  assert.equal(restorePreviousClicks, 30);
  assert.equal(fallbackNextClicks, 30);
  assert.notEqual(current, "initial");
});
