import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import test from "node:test";
import { __testHooks, confirmEagleWrite } from "../src/adapters/eagle.js";
import { __resetProviderTestHooks, __setProviderTestHooks } from "../src/utils/provider.js";

test.afterEach(() => __resetProviderTestHooks());

test("waits for the first Eagle translation instead of falling back before the provider timeout", async () => {
  __setProviderTestHooks({
    callProvider: async () => {
      await new Promise((resolve) => setTimeout(resolve, 8100));
      return JSON.stringify({
        titleZh: "首次即可得到中文标题",
        oneLine: "首次即可得到中文描述",
        summary: "中文摘要",
        tags: ["测试"],
        contentType: "article",
        whySaved: "用于验证首次翻译"
      });
    }
  });

  const metadata = await __testHooks.buildEagleMetadata({
    url: "https://example.com/english-article",
    title: "English article title",
    pageMeta: { description: "English article description" }
  });

  assert.equal(metadata.titleZh, "首次即可得到中文标题");
  assert.equal(metadata.oneLine, "首次即可得到中文描述");
});

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

test("metadata update reapplies selected Eagle folders after import", () => {
  const body = __testHooks.buildItemUpdateBody(
    "item-1",
    { url: "https://example.com/path?utm_source=noise&ref=sidebar" },
    { tags: ["Design"] },
    [{ id: "folder-a", name: "Design" }, { id: "folder-b", name: "Components" }],
    "annotation"
  );

  assert.equal("folders" in body, false);
  assert.deepEqual(body.tags, ["网页收藏", "Design", "Components"]);
  assert.equal(body.url, "https://example.com/path?ref=sidebar");
});

test("Eagle URL imports keep every selected folder id", () => {
  const body = __testHooks.buildEagleBody(
    { url: "https://example.com/article" },
    { titleZh: "Article", oneLine: "Reference", tags: [] },
    [{ id: "folder-a", name: "A" }, { id: "folder-b", name: "B" }],
    "annotation",
    { url: "file:///tmp/capture.png", website: "https://example.com/article" }
  );

  assert.deepEqual(body.folderIds, ["folder-a", "folder-b"]);
  assert.equal("folderId" in body, false);
  assert.equal(body.website, "https://example.com/article");
});

test("Eagle annotation keeps useful project value and omits router boilerplate", () => {
  const annotation = __testHooks.buildAnnotation({}, {
    summary: "包含网页应用中最基本的过渡效果，可直接复制粘贴到任何项目中。",
    whySaved: "可作为网页动效实现时的轻量代码参考。"
  });

  assert.equal(annotation, [
    "- 核心内容：包含网页应用中最基本的过渡效果，可直接复制粘贴到任何项目中。",
    "- 保存价值：可作为网页动效实现时的轻量代码参考。"
  ].join("\n"));
  assert.doesNotMatch(annotation, /Router 记录|待补充/);
});

test("Eagle annotation falls back to the summary instead of a placeholder reason", () => {
  const annotation = __testHooks.buildAnnotation({}, {
    summary: "可复制的网页过渡效果代码合集。",
    whySaved: "待补充保存原因。"
  });

  assert.equal(annotation, [
    "- 核心内容：可复制的网页过渡效果代码合集。",
    "- 适用场景：前端开发与实现参考。"
  ].join("\n"));
});

test("Eagle annotation omits the generic fallback reason", () => {
  const annotation = __testHooks.buildAnnotation({}, {
    summary: "可复制的网页过渡效果代码合集。",
    whySaved: "作为网页、产品、设计或内容参考。"
  });

  assert.equal(annotation, [
    "- 核心内容：可复制的网页过渡效果代码合集。",
    "- 适用场景：前端开发与实现参考。"
  ].join("\n"));
});

test("Eagle annotation adds a concise use case when it can infer one", () => {
  const annotation = __testHooks.buildAnnotation({
    title: "Transitions.dev Skill",
    pageMeta: { description: "A skill that teaches AI about product motion." }
  }, {
    summary: "教会 AI 理解产品动效与过渡效果的技能包。",
    whySaved: "用于为 AI 编程工具补充动效设计规范。",
    contentType: "tool"
  });

  assert.match(annotation, /- 核心内容：教会 AI 理解产品动效与过渡效果的技能包。/);
  assert.match(annotation, /- 适用场景：AI 编程、产品动效与交互设计参考。/);
  assert.match(annotation, /- 保存价值：用于为 AI 编程工具补充动效设计规范。/);
});

test("builds an Eagle item deep link for the imported item", () => {
  assert.equal(__testHooks.buildEagleItemLink("item-123"), "eagle://item/item-123");
  assert.equal(__testHooks.buildEagleItemLink(""), "");
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

test("confirm updates Eagle item folders before final folder verification", async () => {
  const originalFetch = globalThis.fetch;
  const originalOpen = process.env.PATH;
  const requests = [];
  const items = new Map();
  const candidate = {
    id: "page-url",
    kind: "url",
    sourceType: "website",
    selected: true
  };
  const folder = { id: "folder-a", name: "Design" };
  const task = {
    payload: {
      url: "https://example.com/gallery",
      title: "Gallery",
      options: { eagle: { folderIds: [folder.id], captureMode: "url" } },
      pageMeta: {},
      pageAssets: {},
      pageContent: {}
    },
    results: {
      eagle: {
        writePlan: {
          folders: [folder],
          metadata: { titleZh: "Gallery", oneLine: "Reference", tags: [] },
          annotation: "annotation",
          importPlan: candidate,
          candidates: [candidate]
        }
      }
    }
  };

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path: parsed.pathname, body });
    if (parsed.pathname === "/api/application/info") return jsonResponse({ status: "success", data: {} });
    if (parsed.pathname === "/api/folder/list") return jsonResponse({ status: "success", data: [folder] });
    if (parsed.pathname === "/api/item/list") return jsonResponse({ status: "success", data: [...items.values()] });
    if (parsed.pathname === "/api/item/addFromURL") {
      const item = {
        id: "item-1",
        name: body.name,
        url: body.url,
        website: body.website,
        folders: body.folderIds || []
      };
      items.set(item.id, item);
      return jsonResponse({ status: "success", data: { id: item.id } });
    }
    if (parsed.pathname === "/api/item/info") {
      const item = items.get(parsed.searchParams.get("id"));
      return jsonResponse({ status: "success", data: item || { id: parsed.searchParams.get("id") } });
    }
    if (parsed.pathname === "/api/item/update") {
      const current = items.get(body.id);
      items.set(body.id, { ...current, ...body });
      return jsonResponse({ status: "success", data: items.get(body.id) });
    }
    return jsonResponse({ status: "success", data: {} });
  };

  try {
    const result = await confirmEagleWrite(task, { folderIds: [folder.id], candidateIds: [candidate.id] });
    assert.equal(result.status, "success");
    assert.deepEqual(items.get("item-1").folders, [folder.id]);
    assert.ok(requests.find((request) => request.path === "/api/item/update"));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.PATH = originalOpen;
  }
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

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

test("Instagram falls back to captured page media when carousel discovery is empty", async () => {
  const candidates = await __testHooks.buildImportCandidates({
    url: "https://www.instagram.com/p/DaKqRpCCjbf?img_index=1",
    options: { eagle: { captureMode: "screenshot" } },
    pageMeta: { image: "https://cdn.example/video-cover.jpg" },
    pageAssets: {
      carousel: [],
      videos: [{ src: "https://cdn.example/video.mp4", poster: "https://cdn.example/video-cover.jpg", label: "AI OS video" }],
      images: [
        { src: "https://cdn.example/video-cover.jpg", alt: "AI OS cover", width: 1080, height: 1350 },
        { src: "https://cdn.example/slide-2.jpg", alt: "AI OS slide 2", width: 1080, height: 1350 }
      ]
    },
    pageContent: {}
  }, { titleZh: "AI OS" });

  const media = __testHooks.summarizeCandidates(candidates).filter((candidate) => ["media-url", "asset-url"].includes(candidate.kind));
  assert.deepEqual(media.map((candidate) => candidate.kind), ["media-url", "asset-url"]);
  assert.equal(media[0].poster, "https://cdn.example/video-cover.jpg");
});

test("X image posts expose every primary tweet image as grid candidates", async () => {
  const candidates = await __testHooks.buildImportCandidates({
    url: "https://x.com/angehyc/status/2072712904747729140",
    options: { eagle: { captureMode: "top-image" } },
    pageMeta: { image: "https://abs.twimg.com/rweb/ssr/default/v2/og/image.png" },
    pageAssets: {
      images: [
        { src: "https://pbs.twimg.com/media/one.jpg?format=jpg&name=orig", alt: "First", width: 1200, height: 900, tweetScope: "primary" },
        { src: "https://pbs.twimg.com/media/two.jpg?format=jpg&name=orig", alt: "Second", width: 1200, height: 900, tweetScope: "primary" },
        { src: "https://pbs.twimg.com/media/three.jpg?format=jpg&name=orig", alt: "Third", width: 1200, height: 900, tweetScope: "primary" },
        { src: "https://pbs.twimg.com/profile_images/avatar.jpg", alt: "Avatar", width: 400, height: 400, tweetScope: "" }
      ],
      videos: []
    },
    pageContent: {}
  }, { titleZh: "X 多图" });

  const media = __testHooks.summarizeCandidates(candidates).filter((candidate) => candidate.kind === "asset-url");
  assert.deepEqual(media.map((candidate) => candidate.assetUrl), [
    "https://pbs.twimg.com/media/one.jpg?format=jpg&name=orig",
    "https://pbs.twimg.com/media/two.jpg?format=jpg&name=orig",
    "https://pbs.twimg.com/media/three.jpg?format=jpg&name=orig"
  ]);
  assert.equal(media[0].selected, true);
});

test("generic websites expose captured videos alongside images", async () => {
  const candidates = await __testHooks.buildImportCandidates({
    url: "https://example.com/gallery",
    options: { eagle: { captureMode: "top-image" } },
    pageMeta: {},
    pageAssets: {
      videos: [
        { src: "https://github.com/user-attachments/assets/number-flow-demo", poster: "https://cdn.example/demo.jpg", label: "GitHub README demo", source: "performance", width: 1280, height: 720, duration: 6.5 },
        { src: "https://cdn.example/demo.mp4", poster: "https://cdn.example/demo.jpg", label: "Demo" }
      ],
      images: [{ src: "https://cdn.example/one.jpg", alt: "One" }]
    },
    pageContent: {}
  }, { titleZh: "Gallery" });
  const media = __testHooks.summarizeCandidates(candidates).filter((item) => ["media-url", "asset-url"].includes(item.kind));
  assert.deepEqual(media.map((item) => item.kind), ["media-url", "media-url", "asset-url"]);
  assert.equal(media[0].mediaUrl, "https://github.com/user-attachments/assets/number-flow-demo");
  assert.equal(media[0].source, "performance");
  assert.equal(media[0].duration, 6.5);
});

test("rejects scripts and icons that contain video-like host names", async () => {
  const candidates = await __testHooks.buildImportCandidates({
    url: "https://example.com/gallery",
    options: { eagle: { captureMode: "screenshot" } },
    pageMeta: {},
    pageAssets: {
      videos: [
        { src: "https://fe-static.xhscdn.com/formula-static/video-player.js", poster: "https://cdn.example/cover.jpg" },
        { src: "https://fe-video-qc.xhscdn.com/fe-platform/site.ico", poster: "https://cdn.example/cover.jpg" },
        { src: "https://sns-video-qc.xhscdn.com/stream/original.mp4?sign=test", poster: "https://cdn.example/cover.jpg" }
      ],
      images: []
    },
    pageContent: {}
  }, { titleZh: "Gallery" });
  const videos = __testHooks.summarizeCandidates(candidates).filter((candidate) => candidate.kind === "media-url");
  assert.deepEqual(videos.map((candidate) => candidate.mediaUrl), [
    "https://sns-video-qc.xhscdn.com/stream/original.mp4?sign=test"
  ]);
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

test("background and popup mark X primary tweet images for media grids", () => {
  for (const relative of ["../../extension/background.js", "../../extension/popup.js"]) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, relative), "utf8");
    assert.match(source, /tweetScopeForImage/);
    assert.match(source, /tweetScope: scope/);
    assert.match(source, /parsed\.hostname === "pbs\.twimg\.com"/);
    assert.match(source, /parsed\.searchParams\.set\("name", "orig"\)/);
  }
});

test("background and popup preserve commas inside CDN srcset URLs", () => {
  for (const relative of ["../../extension/background.js", "../../extension/popup.js"]) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, relative), "utf8");
    const helper = source.match(/function pickLargestSrcset\(srcset\) \{[\s\S]*?\n        \}/)?.[0] || "";
    assert.match(helper, /\.split\(\/,\\s\+\/\)/);
    assert.doesNotMatch(helper, /\.split\(","\)/);
  }
});

test("background and popup read Xiaohongshu's standard video meta tag", () => {
  for (const relative of ["../../extension/background.js", "../../extension/popup.js"]) {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, relative), "utf8");
    assert.match(source, /meta\[name="video"\]/);
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

test('X article includes and selects all embedded article images in screenshot mode', async () => {
  const result = await __testHooks.buildImportCandidates({
    url: 'https://x.com/author/status/123', title: 'X 帖子',
    options: {eagle:{captureMode:'screenshot'}}, pageMeta:{}, pageCapture:{url:'https://x.com/author/status/123'},
    pageAssets:{images:[],videos:[],videoRects:[]},
    pageContent:{text:'', markdown:'## Article\n\n![one](https://pbs.twimg.com/media/one?format=jpg&name=900x900)\n\n![two](https://pbs.twimg.com/media/two?format=jpg&name=900x900)'},
    screenshotDataUrl:'data:image/png;base64,aGVsbG8='
  }, {titleZh:'文章',oneLine:'说明',tags:[]});
  assert.equal(result.filter(c => c.kind === 'asset-url' && c.selected).length, 2);
});

test('a cleaned screenshot can be recreated for a later save', async () => {
  const candidate = {kind:'screenshot',asset:{filePath:'/tmp/clip-router-missing-test.png'}};
  await __testHooks.restoreOwnedAsset(candidate, {screenshotDataUrl:'data:image/png;base64,aGVsbG8='}, {titleZh:'test'});
  assert.equal(await fs.promises.readFile(candidate.asset.filePath, 'utf8'), 'hello');
  await fs.promises.unlink(candidate.asset.filePath);
});

test('recognizes a previously imported identical screenshot without matching other assets', () => {
  const payload = {url:'https://x.com/example/status/123'};
  const plan = {kind:'screenshot',asset:{size:439093}};
  const metadata = {titleZh:'标题',oneLine:'描述'};
  const item = {url:payload.url,name:'标题 — 描述',size:439093,ext:'png'};
  assert.equal(__testHooks.isMatchingScreenshot(item, payload, plan, metadata), true);
  assert.equal(__testHooks.isMatchingScreenshot({...item,size:439094}, payload, plan, metadata), false);
  assert.equal(__testHooks.isMatchingScreenshot({...item,url:'https://other.example'}, payload, plan, metadata), false);
});
