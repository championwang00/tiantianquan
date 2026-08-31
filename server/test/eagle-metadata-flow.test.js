import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { parseHTML } from "linkedom";
import { __testHooks, runEagleAdapter } from "../src/adapters/eagle.js";
import { __resetProviderTestHooks, __setProviderTestHooks, generateClipMetadata } from "../src/utils/provider.js";

const payload = {
  url: "https://x.com/example/status/123",
  title: "(8) X 上的 Example：“Went fishing and made a website.” / X",
  pageMeta: {},
  pageContent: { text: "Went fishing and made a website." }
};
const translated = {
  titleZh: "去钓鱼，也做了一个网站",
  oneLine: "作者分享钓鱼与网站制作的经历。",
  summary: "作者分享自己去钓鱼并做了一个网站，未说明网站的具体功能。",
  tags: ["网站设计"],
  contentType: "tweet",
  whySaved: "收集个人网站创作的表达方式。"
};

test.afterEach(() => __resetProviderTestHooks());

test("first Eagle preview waits for a translation that takes longer than twelve seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  __setProviderTestHooks({ callProvider: () => new Promise((resolve) => {
    setTimeout(() => resolve(JSON.stringify(translated)), 16000);
  }) });
  const pending = __testHooks.buildEagleMetadata(payload);
  t.mock.timers.tick(16000);
  const result = await pending;
  assert.equal(result.titleZh, "去钓鱼，也做了一个网站");
  assert.equal(result.providerError, undefined);
});

test("failed translation cannot become an Eagle confirmation preview", async () => {
  __setProviderTestHooks({ callProvider: async () => { throw new Error("Provider metadata generation timed out"); } });
  await assert.rejects(runEagleAdapter({ ...payload, url: "https://example.com/post" }), /翻译.*(?:失败|未完成|超时)/);
});

test("a stalled provider request is cancelled and a later attempt can succeed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestSignal;
  __setProviderTestHooks({ callProvider: (_prompt, options) => {
    requestSignal = options?.signal;
    return new Promise(() => {});
  } });
  const pending = generateClipMetadata(payload, "eagle");
  t.mock.timers.tick(60000);
  const failed = await pending;
  assert.match(failed.providerError, /timed out/);
  assert.equal(requestSignal?.aborted, true);
  __setProviderTestHooks({ callProvider: async () => JSON.stringify(translated) });
  const recovered = await generateClipMetadata(payload, "eagle");
  assert.equal(recovered.titleZh, "去钓鱼，也做了一个网站");
  assert.equal(recovered.providerError, undefined);
});

test("Eagle descriptions preserve the final sentence beyond ninety characters", async () => {
  const summary = "作者分享一个横向两步变形菜单的交互设计，说明它与常见的纵向胶囊变形不同，并将演示放在完整组件套件中。该帖子没有提供实现代码，也没有说明使用了哪一种动画框架，因此不能从这条文字判断实现方法。组件套件链接在原帖中。";
  __setProviderTestHooks({ callProvider: async () => JSON.stringify({ ...translated, summary }) });
  const metadata = await __testHooks.buildEagleMetadata(payload);
  assert.equal(metadata.summary, summary);
  assert.match(__testHooks.buildAnnotation(payload, metadata), /组件套件链接在原帖中。/);
});

test("English words containing ai do not turn a menu animation into an AI programming reference", () => {
  const annotation = __testHooks.buildAnnotation({
    title: "We said enough. So we created this horizontal 2-step morphing menu animation."
  }, {
    ...translated,
    summary: "作者介绍横向两步变形菜单动画。",
    tags: ["交互动效"]
  });
  assert.match(annotation, /适用场景：网页动效与交互实现参考/);
  assert.doesNotMatch(annotation, /AI 编程/);
});

const extensionDir = path.resolve(import.meta.dirname, "../../extension");

function extensionContext(file, html) {
  const { document, window } = parseHTML(html);
  const noop = () => {};
  const context = vm.createContext({
    document, window, Node: window.Node, URL,
    location: new URL(payload.url),
    performance: { getEntriesByType: () => [] },
    importScripts: noop,
    confirmObsidian: noop,
    chrome: {
      runtime: { onInstalled: { addListener: noop }, onMessage: { addListener: noop } },
      contextMenus: { onClicked: { addListener: noop } },
      scripting: { executeScript: async ({ func, args }) => func ? [{ result: await func(...args) }] : [] }
    }
  });
  const source = fs.readFileSync(path.join(extensionDir, file), "utf8").replace(/^init\(\);$/m, "");
  vm.runInContext(source, context);
  return context;
}

for (const [file, collector] of [["background.js", "collectPageContextInBackground"], ["popup.js", "collectPageContext"]]) {
  test(`${file}: lightweight Eagle capture includes only the primary X post text`, async () => {
    const context = extensionContext(file, `<html><body><main data-testid="primaryColumn">
      <article data-testid="tweet"><a href="https://x.com/reply/status/1234">Other post</a><div data-testid="tweetText">Unrelated reply</div></article>
      <article data-testid="tweet"><a href="https://x.com/example/status/123">Original</a><div data-testid="tweetText">Went fishing and made a website.</div>
        <div role="link"><div data-testid="tweetText">A quoted post</div></div><button>Reply</button>
      </article>
    </main></body></html>`);
    const result = await context[collector]({ id: 1 }, { fullContent: false, deepAssets: true });
    assert.equal(result.content.text, "Went fishing and made a website.");
    assert.equal(result.content.htmlSnapshot, "");
  });

  test(`${file}: a missing primary X post does not use another post as its body`, async () => {
    const context = extensionContext(file, `<html><body><main><article data-testid="tweet">
      <a href="https://x.com/reply/status/999">Reply</a><div data-testid="tweetText">An unrelated reply</div>
    </article></main></body></html>`);
    const result = await context[collector]({ id: 1 }, { fullContent: true, deepAssets: false });
    assert.equal(result.content.text, "");
    let prompt = "";
    __setProviderTestHooks({ callProvider: async (value) => { prompt = value; return JSON.stringify(translated); } });
    await generateClipMetadata({ ...payload, pageContent: result.content }, "eagle");
    assert.doesNotMatch(prompt, /An unrelated reply/);
  });
}

test("popup keeps polling while a slow first translation is still running", async () => {
  const source = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  const loop = source.slice(source.indexOf("async function pollTaskLoop("), source.indexOf("async function restoreActiveTasks("));
  let elapsed = 0;
  let finalStatus;
  let shownTimeout = false;
  const context = vm.createContext({
    Date: { now: () => elapsed },
    setTimeout: (resolve, ms) => { elapsed += ms; resolve(); },
    currentTasks: {},
    getTask: async () => ({ id: "slow", results: { eagle: { status: elapsed >= 40000 ? "needs_review" : "running" } } }),
    persistTaskState: async () => {},
    renderTaskForTarget: (task) => { finalStatus = task.results.eagle.status; },
    setShellState: () => {}, setCardBusy: () => {}, setCardConfirmState: () => {},
    setCardStatus: (_target, status) => { if (status === "超时") shownTimeout = true; },
    setCardInlineState: () => {}
  });
  vm.runInContext(loop, context);
  await context.pollTaskLoop("slow", "eagle");
  assert.equal(shownTimeout, false);
  assert.equal(finalStatus, "needs_review");
});
