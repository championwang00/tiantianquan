import assert from "node:assert/strict";
import test from "node:test";
import { __resetProviderTestHooks, __setProviderTestHooks, generateClipMetadata } from "../src/utils/provider.js";

test.afterEach(() => __resetProviderTestHooks());

test("reuses metadata for the same page across Eagle and Bear previews", async () => {
  let calls = 0;
  __setProviderTestHooks({
    callProvider: async () => {
      calls += 1;
      return JSON.stringify({ titleZh: "AI OS", oneLine: "概念设计", summary: "摘要", tags: ["AI"], contentType: "design_reference", whySaved: "参考" });
    },
    now: () => 1000
  });
  const payload = { url: "https://www.instagram.com/p/DaKqRpCCjbf", title: "AI OS", pageMeta: {} };
  const eagle = await generateClipMetadata(payload, "eagle");
  const bear = await generateClipMetadata(payload, "bear");
  assert.equal(eagle.titleZh, "AI OS");
  assert.equal(bear.titleZh, "AI OS");
  assert.equal(calls, 1);
});
