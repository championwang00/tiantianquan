import assert from "node:assert/strict";
import test from "node:test";
import { __resetInstagramTestHooks, __setInstagramTestHooks, enrichInstagramPayload, extractInstagramCarouselFromGraphql, extractInstagramCarouselFromHtml, instagramShortcodeToMediaId } from "../src/utils/instagram.js";

test.afterEach(() => __resetInstagramTestHooks());

test("extracts the complete Instagram carousel from server-fetched Relay HTML", () => {
  const relay = {
    result: { data: { xig_polaris_media: { code: "DaKqRpCCjbf", if_not_gated_logged_out: {
      code: "DaKqRpCCjbf",
      carousel_media: [
        { media_type: 2, pk: "v1", code: "video", display_uri: "https://cdn.example/cover.jpg", video_versions: [{ url: "https://cdn.example/video.mp4" }] },
        { media_type: 1, pk: "i1", code: "one", display_uri: "https://cdn.example/one.jpg" },
        { media_type: 1, pk: "i2", code: "two", display_uri: "https://cdn.example/two.jpg" }
      ]
    } } } }
  };
  const html = `<html><script type="application/json">${JSON.stringify(relay)}</script></html>`;
  const assets = extractInstagramCarouselFromHtml(html, "https://www.instagram.com/p/DaKqRpCCjbf?img_index=1");
  assert.deepEqual(assets.map(({ type, src }) => ({ type, src })), [
    { type: "video", src: "https://cdn.example/video.mp4" },
    { type: "image", src: "https://cdn.example/one.jpg" },
    { type: "image", src: "https://cdn.example/two.jpg" }
  ]);
});

test("decodes an Instagram shortcode and extracts its authenticated GraphQL carousel", () => {
  assert.equal(instagramShortcodeToMediaId("DaKqRpCCjbf"), "3930139555076388575");
  const response = {
    data: { xdt_api__v1__media__media_id_web_info: { items: [{
      code: "DaKqRpCCjbf",
      carousel_media: [
        { media_type: 1, pk: "v1", code: "video", image_versions2: { candidates: [{ url: "https://cdn.example/cover.jpg", width: 1080, height: 1350 }] }, video_versions: [{ url: "https://cdn.example/video.mp4", width: 720, height: 900 }] },
        { media_type: 1, pk: "i1", code: "image", image_versions2: { candidates: [{ url: "https://cdn.example/image.jpg", width: 1080, height: 1350 }] } }
      ]
    }] } }
  };
  const assets = extractInstagramCarouselFromGraphql(response, "DaKqRpCCjbf");
  assert.deepEqual(assets.map(({ type, src, poster }) => ({ type, src, poster })), [
    { type: "video", src: "https://cdn.example/video.mp4", poster: "https://cdn.example/cover.jpg" },
    { type: "image", src: "https://cdn.example/image.jpg", poster: "" }
  ]);
});

test("Instagram enrichment uses authenticated data first and reuses a short-lived carousel cache", async () => {
  let authenticatedCalls = 0;
  let htmlCalls = 0;
  const carousel = [{ index: 0, type: "image", src: "https://cdn.example/one.jpg" }];
  __setInstagramTestHooks({
    fetchAuthenticated: async () => { authenticatedCalls += 1; return carousel; },
    fetchHtml: async () => { htmlCalls += 1; return []; },
    now: () => 1000
  });
  const payload = { url: "https://www.instagram.com/p/DaKqRpCCjbf", pageAssets: {} };
  const first = await enrichInstagramPayload(payload);
  const second = await enrichInstagramPayload(payload);
  assert.deepEqual(first.pageAssets.carousel, carousel);
  assert.deepEqual(second.pageAssets.carousel, carousel);
  assert.equal(authenticatedCalls, 1);
  assert.equal(htmlCalls, 0);
});
