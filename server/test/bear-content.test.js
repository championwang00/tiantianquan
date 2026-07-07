import assert from "node:assert/strict";
import test from "node:test";
import { __resetBearTestHooks, __setBearTestHooks, __testBuildBearCandidates, __testBuildBearDraftParts, __testResolveBearCandidateAsset, confirmBearWrite } from "../src/adapters/bear.js";

test.afterEach(() => __resetBearTestHooks());

test("places structured article markdown before description and summary", () => {
  const payload = {
    url: "https://example.com/story",
    title: "Pangram",
    pageMeta: { description: "Publisher description" },
    pageContent: { articleHtml: "<article><h2>Actual body</h2><p>The quick brown fox.</p></article>" }
  };
  const draft = __testBuildBearDraftParts(payload, { summary: "Generated summary" }, null).full;

  assert.match(draft, /## Actual body/);
  assert.ok(draft.indexOf("## Actual body") < draft.indexOf("Publisher description"));
  assert.ok(draft.indexOf("Publisher description") < draft.indexOf("Generated summary"));
});

test("Instagram Bear drafts omit raw remote image markdown and use native attachments", () => {
  const draft = __testBuildBearDraftParts({
    url: "https://www.instagram.com/p/DaKqRpCCjbf",
    title: "AI OS",
    pageMeta: { description: "243 likes - AI OS" },
    pageContent: { markdown: "![unrelated](https://cdn.example/noise.jpg)\nOther page noise" }
  }, { summary: "AI OS concept" }, null).full;
  assert.doesNotMatch(draft, /!\[|cdn\.example|Other page noise/);
  assert.match(draft, /243 likes/);
  assert.match(draft, /AI OS concept/);
});

test("Bear and Eagle can consume the same Instagram carousel media set", async () => {
  const candidates = await __testBuildBearCandidates({
    url: "https://www.instagram.com/p/DaKqRpCCjbf",
    pageMeta: {},
    pageAssets: { carousel: [
      { index: 0, type: "video", src: "https://cdn.example/video.mp4", poster: "https://cdn.example/cover.jpg", description: "Video", duration: 17 },
      { index: 1, type: "image", src: "https://cdn.example/one.jpg", description: "One" },
      { index: 2, type: "image", src: "https://cdn.example/two.jpg", description: "Two" }
    ] }
  }, { titleZh: "AI OS" });
  assert.deepEqual(candidates.map((item) => item.kind), ["media-url", "asset-url", "asset-url"]);
  assert.deepEqual(candidates.map((item) => item.description), ["Video", "One", "Two"]);
});

test("all website videos are converted to GIF before Bear attachment", async () => {
  __setBearTestHooks({
    downloadVideo: async () => ({ filePath: "/tmp/instagram.mp4", cleanupPaths: ["/tmp/instagram.mp4"] }),
    convertVideo: async () => ({ filePath: "/tmp/instagram.gif", filename: "instagram.gif", mimeType: "image/gif", cleanupPaths: ["/tmp/instagram.gif"] })
  });
  const asset = await __testResolveBearCandidateAsset({
    kind: "media-url", sourceType: "webpage", mediaUrl: "https://cdn.example/video.mp4", label: "页面视频 1"
  }, { url: "https://example.com/video" }, { titleZh: "Video" });
  assert.equal(asset.kind, "gif");
  assert.equal(asset.mimeType, "image/gif");
  assert.deepEqual(asset.cleanupPaths, ["/tmp/instagram.gif", "/tmp/instagram.mp4"]);
});

test("generic websites expose captured videos and images through the same Bear media pipeline", async () => {
  const candidates = await __testBuildBearCandidates({
    url: "https://example.com/gallery",
    pageMeta: {},
    pageAssets: {
      videos: [
        { src: "https://github.com/user-attachments/assets/number-flow-demo", poster: "https://cdn.example/demo.jpg", label: "GitHub README demo", source: "performance", width: 1280, height: 720, duration: 6.5 },
        { src: "https://cdn.example/demo.mp4", poster: "https://cdn.example/demo.jpg", label: "Demo" }
      ],
      images: [{ src: "https://cdn.example/one.jpg", alt: "One" }]
    }
  }, { titleZh: "Gallery" });
  assert.deepEqual(candidates.map((item) => item.kind), ["media-url", "media-url", "asset-url"]);
  assert.equal(candidates[0].mediaUrl, "https://github.com/user-attachments/assets/number-flow-demo");
  assert.equal(candidates[0].source, "performance");
  assert.equal(candidates[0].duration, 6.5);
});

test("Bear lists every primary X image in the shared media grid", async () => {
  const candidates = await __testBuildBearCandidates({
    url: "https://x.com/angehyc/status/2072712904747729140",
    pageMeta: { image: "https://abs.twimg.com/rweb/ssr/default/v2/og/image.png" },
    pageAssets: {
      images: [
        { src: "https://pbs.twimg.com/media/one.jpg?format=jpg&name=orig", alt: "One", width: 1200, height: 900, tweetScope: "primary" },
        { src: "https://pbs.twimg.com/media/two.jpg?format=jpg&name=orig", alt: "Two", width: 1200, height: 900, tweetScope: "primary" },
        { src: "https://pbs.twimg.com/profile_images/avatar.jpg", alt: "Avatar", width: 400, height: 400, tweetScope: "" },
        { src: "https://pbs.twimg.com/media/three.jpg?format=jpg&name=orig", alt: "Three", width: 1200, height: 900, tweetScope: "primary" }
      ]
    }
  }, { titleZh: "X 多图" });

  assert.deepEqual(candidates.filter((item) => item.kind === "asset-url").map((item) => item.assetUrl), [
    "https://pbs.twimg.com/media/one.jpg?format=jpg&name=orig",
    "https://pbs.twimg.com/media/two.jpg?format=jpg&name=orig",
    "https://pbs.twimg.com/media/three.jpg?format=jpg&name=orig"
  ]);
});

test("materializes selected candidates in candidate order and writes all into one note", async () => {
  const events = [];
  __setBearTestHooks({
    resolveCandidate: async (candidate) => ({ filePath: `/tmp/${candidate.id}`, filename: `${candidate.id}.jpg`, label: candidate.id }),
    append: async (text) => events.push(["append", text]),
    addFile: async (_path, filename) => events.push(["file", filename]),
    indent: async () => {},
    wait: async () => {},
    verify: async () => ({ count: 1, imageRefCount: 2 })
  });
  const task = bearTask([candidate("first"), candidate("second"), candidate("third")]);

  const result = await confirmBearWrite(task, { candidateIds: ["third", "first"], includeScreenshot: true });

  assert.deepEqual(events.filter(([kind]) => kind === "file").map(([, value]) => value), ["first.jpg", "third.jpg"]);
  assert.equal(events.filter(([kind]) => kind === "append").length, 2);
  assert.equal(result.status, "success");
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.items.map((item) => item.id), ["first", "third"]);
});

test("continues after one attachment fails and reports per-item outcome", async () => {
  const files = [];
  __setBearTestHooks({
    resolveCandidate: async (candidate) => {
      if (candidate.id === "bad") throw new Error("download failed");
      return { filePath: `/tmp/${candidate.id}`, filename: `${candidate.id}.jpg` };
    },
    append: async () => {}, addFile: async (_path, filename) => files.push(filename), indent: async () => {}, wait: async () => {},
    verify: async () => ({ count: 1, imageRefCount: 1 })
  });
  const task = bearTask([candidate("good"), candidate("bad")]);

  const result = await confirmBearWrite(task, { candidateIds: ["bad", "good"] });

  assert.deepEqual(files, ["good.jpg"]);
  assert.equal(result.status, "partial_success");
  assert.equal(result.reason, "Bear 笔记已保存，附件 1/2 个成功，1 个失败");
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.items.map(({ id, status }) => [id, status]), [["good", "success"], ["bad", "failed"]]);
});

test("rejects explicit stale candidate ids instead of falling back to the first candidate", async () => {
  let resolved = 0;
  __setBearTestHooks({
    resolveCandidate: async () => { resolved += 1; return { filePath: "/tmp/unexpected.jpg", filename: "unexpected.jpg" }; },
    append: async () => {}, wait: async () => {}, verify: async () => ({ count: 1, imageRefCount: 0 })
  });

  await assert.rejects(
    confirmBearWrite(bearTask([candidate("current")]), { candidateIds: ["stale"] }),
    /所选 Bear 素材已失效/
  );
  assert.equal(resolved, 0);
});

test("reports failed when the note is saved but every selected attachment fails", async () => {
  __setBearTestHooks({
    resolveCandidate: async (entry) => ({ filePath: `/tmp/${entry.id}.jpg`, filename: `${entry.id}.jpg` }),
    append: async () => {}, addFile: async () => { throw new Error("attachment rejected"); }, wait: async () => {},
    verify: async () => ({ count: 1, imageRefCount: 0 })
  });

  const result = await confirmBearWrite(bearTask([candidate("one"), candidate("two")]), { candidateIds: ["one", "two"] });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "Bear 笔记已保存，但附件 0/2 个成功，2 个失败");
  assert.equal(result.succeeded, 0);
  assert.equal(result.failed, 2);
});

test("keeps an added attachment successful when optional indentation fails", async () => {
  __setBearTestHooks({
    resolveCandidate: async (candidate) => ({ filePath: `/tmp/${candidate.id}`, filename: `${candidate.id}.jpg` }),
    append: async () => {}, addFile: async () => {}, indent: async () => { throw new Error("format failed"); }, wait: async () => {},
    verify: async (_url, filenames) => ({ count: 1, imageRefCount: filenames.length })
  });

  const result = await confirmBearWrite(bearTask([candidate("good")]), { candidateIds: ["good"] });

  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.items[0].status, "success");
  assert.deepEqual(result.items[0].warnings, [{ stage: "indent", error: "format failed" }]);
});

test("escapes hostile metadata fields while preserving article markdown", () => {
  const payload = {
    url: "https://example.com/story",
    title: "[bad](javascript:alert(1))\n# forged",
    pageMeta: { description: "desc\n* injected [x](javascript:boom)" },
    pageContent: { articleHtml: "<article><h2>Safe article</h2><p><strong>kept</strong></p></article>" }
  };
  const draft = __testBuildBearDraftParts(payload, { oneLine: "line\nbreak", summary: "sum\n* injected" }, [{
    label: "[label](javascript:bad)\nnext", filename: "evil]\n* file.jpg"
  }]).full;

  assert.match(draft, /## Safe article\n\s+\*\*kept\*\*/);
  assert.doesNotMatch(draft, /\]\(javascript:/);
  assert.doesNotMatch(draft, /\n# forged|\n\* injected|\nnext/);
  assert.match(draft, /\\\[bad\\\]/);
});

test("cleans only explicitly owned materialization artifacts on success", async () => {
  const removed = [];
  __setBearTestHooks({
    resolveCandidate: async () => ({ filePath: "/tmp/derived.jpg", filename: "derived.jpg", cleanupPaths: ["/tmp/raw.jpg", "/tmp/derived.jpg"] }),
    append: async () => {}, addFile: async () => {}, indent: async () => {}, wait: async () => {}, verify: async () => ({ count: 1, imageRefCount: 1 }),
    cleanup: async (paths) => removed.push(...paths)
  });

  await confirmBearWrite(bearTask([candidate("owned")]), { candidateIds: ["owned"] });

  assert.deepEqual(removed, ["/tmp/raw.jpg", "/tmp/derived.jpg"]);
});

test("cleans owned artifacts after write failure but never an unowned filePath", async () => {
  const removed = [];
  __setBearTestHooks({
    resolveCandidate: async () => ({ filePath: "/Users/me/photo.jpg", filename: "photo.jpg", cleanupPaths: ["/tmp/generated.gif"] }),
    append: async () => { throw new Error("Bear unavailable"); }, wait: async () => {}, cleanup: async (paths) => removed.push(...paths)
  });

  await assert.rejects(confirmBearWrite(bearTask([candidate("owned")]), { candidateIds: ["owned"] }), /Bear unavailable/);
  assert.deepEqual(removed, ["/tmp/generated.gif"]);
});

function candidate(id) { return { id, kind: "asset-url", assetUrl: `https://example.com/${id}.jpg`, selected: true }; }
function bearTask(candidates) {
  const payload = { url: "https://example.com/story", title: "Story", pageMeta: {}, pageContent: {} };
  const metadata = { summary: "Summary" };
  return { payload, results: { bear: { draft: "draft", draftNoScreenshot: "draft", metadata, writePlan: { metadata, candidates } } } };
}
