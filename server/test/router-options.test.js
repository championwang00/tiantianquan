import assert from "node:assert/strict";
import test from "node:test";
import { __testHooks } from "../src/router.js";

test("normalizes legacy candidateId and scalar candidateIds", () => {
  assert.deepEqual(__testHooks.normalizeCandidateIds({ candidateId: "legacy" }), ["legacy"]);
  assert.deepEqual(__testHooks.normalizeCandidateIds({ candidateIds: "scalar" }), ["scalar"]);
  assert.deepEqual(__testHooks.normalizeCandidateIds({ candidateIds: ["a", 2, "b"] }), ["a", "b"]);
});

test("keeps structured media fields used by grid candidates", () => {
  const payload = __testHooks.validatePayload({
    url: "https://www.instagram.com/p/ABC123/",
    targets: ["eagle"],
    pageAssets: {
      images: [{ src: "https://cdn.example/one.jpg", tweetScope: "primary" }],
      videos: [{ src: "https://cdn.example/one.mp4" }],
      carousel: [
        { index: 0, type: "image", src: "https://cdn.example/a.jpg" },
        { index: 1, type: "video", src: "https://cdn.example/b.mp4" }
      ]
    },
    pageContent: {
      markdown: "body",
      articleHtml: "<article>body</article>",
      htmlSnapshot: "<html></html>"
    }
  });

  assert.equal(payload.pageAssets.images[0].tweetScope, "primary");
  assert.deepEqual(payload.pageAssets.carousel.map((item) => item.type), ["image", "video"]);
  assert.equal(payload.pageContent.articleHtml, "<article>body</article>");
});
