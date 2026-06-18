import assert from "node:assert/strict";
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
