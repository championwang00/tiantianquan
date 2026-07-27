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

test("passes X post text to the metadata provider for translation and analysis", async () => {
  let prompt = "";
  __setProviderTestHooks({
    callProvider: async (value) => {
      prompt = value;
      return JSON.stringify({ titleZh: "Mehdi：将 Thinking Orbs 移植到 React Native", oneLine: "", summary: "", tags: [], contentType: "tweet", whySaved: "" });
    }
  });

  await generateClipMetadata({
    url: "https://x.com/mehdi_made/status/2080634451491438612",
    title: "Mehdi on X",
    pageMeta: {},
    pageContent: { text: "Loved these thinking orbs, so I ported them to React Native + Expo. All six states run on the UI thread with Skia + Reanimated." }
  }, "eagle");

  assert.match(prompt, /X 帖子正文：Loved these thinking orbs/);
  assert.match(prompt, /核心意思翻译成中文/);
  assert.match(prompt, /关键实现细节/);
});

test("uses X post text in the metadata cache key", async () => {
  let calls = 0;
  __setProviderTestHooks({
    callProvider: async () => {
      calls += 1;
      return JSON.stringify({ titleZh: "标题", oneLine: "简介", summary: "摘要", tags: [], contentType: "tweet", whySaved: "价值" });
    }
  });
  const base = { url: "https://x.com/example/status/1", title: "Example", pageMeta: {} };

  await generateClipMetadata({ ...base, pageContent: { text: "first post" } }, "eagle");
  await generateClipMetadata({ ...base, pageContent: { text: "second post" } }, "eagle");

  assert.equal(calls, 2);
});

test("uses the X page title as a fallback post body when DOM text is unavailable", async () => {
  let prompt = "";
  __setProviderTestHooks({
    callProvider: async (value) => {
      prompt = value;
      return JSON.stringify({ titleZh: "标题", oneLine: "简介", summary: "摘要", tags: [], contentType: "tweet", whySaved: "价值" });
    }
  });

  await generateClipMetadata({
    url: "https://x.com/mehdi_made/status/2080634451491438612",
    title: "X 上的 Mehdi：“loved these thinking orbs, so I ported them to react native + expo. all six states, running on the ui thread with skia + reanimated.” / X",
    pageMeta: {},
    pageContent: { text: "" }
  }, "eagle");

  assert.match(prompt, /X 帖子正文：loved these thinking orbs/i);
});
