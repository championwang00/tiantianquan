import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { parseHTML } from "linkedom";
import { __testHooks as routerHooks } from "../src/router.js";

const extensionDir = path.resolve(import.meta.dirname, "../../extension");
const postUrl = "https://x.com/steveruizok/status/2072651350719058088";
const postId = "2072651350719058088";
const videoUrl = "https://video.twimg.com/amplify_video/2072646212214267904/vid/960x540/original.mp4";
const poster = "https://pbs.twimg.com/amplify_video_thumb/2072646212214267904/img/original.jpg";
const ownPost = `<article data-testid="tweet">
  <a href="${postUrl}"><time>Today</time></a>
  <div data-testid="tweetText">My formula for a perfect concentric radius.</div>
  <video src="${videoUrl}" poster="${poster}" width="400" height="225"></video>
  <div role="link"><a href="https://x.com/other/status/999"><time>Yesterday</time></a>
    <div data-testid="tweetText">An unrelated quoted post.</div>
    <video src="https://video.twimg.com/amplify_video/999/vid/quoted.mp4" width="600" height="400"></video>
    <img src="https://pbs.twimg.com/media/quoted.jpg" width="600" height="400">
  </div>
</article>`;

function harness(file, body, url = postUrl) {
  const { document, window } = parseHTML(`<html><head><title>stale title from another X post</title>
    <meta name="author" content="Wrong author"><meta property="og:image" content="https://pbs.twimg.com/media/previous.jpg">
    <link rel="canonical" href="https://x.com/other/status/888"></head><body>
    <main data-testid="primaryColumn">${body}</main></body></html>`);
  Object.defineProperty(document, "images", { get: () => [...document.querySelectorAll("img")] });
  Object.defineProperty(document, "scripts", { get: () => [...document.querySelectorAll("script")] });
  window.innerWidth = 1000;
  window.innerHeight = 800;
  for (const video of document.querySelectorAll("video")) {
    video.src = video.getAttribute("src");
    video.poster = video.getAttribute("poster") || "";
    video.getBoundingClientRect = () => ({ left: 10, top: 20, right: 10 + Number(video.getAttribute("width")), bottom: 20 + Number(video.getAttribute("height")), width: Number(video.getAttribute("width")), height: Number(video.getAttribute("height")) });
  }
  const noop = () => {};
  const tab = { id: 1, windowId: 1, active: true, url, title: "stale title from another X post" };
  const context = vm.createContext({
    document, window, Node: window.Node, URL, setTimeout, clearTimeout,
    location: new URL(url), performance: { getEntriesByType: () => [] },
    importScripts: noop, confirmObsidian: noop,
    chrome: {
      runtime: { onInstalled: { addListener: noop }, onMessage: { addListener: noop } },
      contextMenus: { onClicked: { addListener: noop } },
      tabs: { get: async () => tab, captureVisibleTab: async () => "data:image/png;base64,capture" },
      scripting: { executeScript: async ({ func, args }) => func ? [{ result: await func(...args) }] : [] }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(extensionDir, "routerClient.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(extensionDir, file), "utf8").replace(/^init\(\);$/m, ""), context);
  if (file === "popup.js") vm.runInContext(`activeTab = ${JSON.stringify(tab)}`, context);
  return { context, tab };
}

for (const [file, collector] of [["background.js", "collectPageContextInBackground"], ["popup.js", "collectPageContext"]]) {
  test(`${file}: a reply quoting the requested post is not the primary post`, async () => {
    const reply = `<article data-testid="tweet"><a href="https://x.com/other/status/888"><time>Today</time></a>
      <div data-testid="tweetText">Wrong reply body.</div>
      <div role="link"><a href="${postUrl}"><time>Today</time></a></div></article>`;
    const { context } = harness(file, reply + ownPost);
    const result = await context[collector]({ id: 1 }, { fullContent: false, deepAssets: true });
    assert.equal(result.content.text, "My formula for a perfect concentric radius.");
  });

  test(`${file}: quoted media cannot supply the original post's video or thumbnail crop`, async () => {
    const { context } = harness(file, ownPost);
    const result = await context[collector]({ id: 1 }, { fullContent: false, deepAssets: true });
    assert.deepEqual(Array.from(result.assets.videos, (video) => video.src), [videoUrl]);
    assert.equal(result.assets.videos[0].tweetScope, "primary");
    assert.equal(result.assets.videos[0].sourcePostId, postId);
    assert.equal(result.assets.videoRects.length, 1);
    assert.equal(result.assets.videoRects[0].sourcePostId, postId);
    assert.equal(result.assets.videoRects[0].poster, poster);
    assert.equal(result.assets.images.length, 0);
  });

  test(`${file}: when the primary post is absent, reply media is not collected`, async () => {
    const { context } = harness(file, `<article data-testid="tweet"><a href="https://x.com/other/status/888"><time>Today</time></a>
      <div data-testid="tweetText">Wrong reply body.</div><video src="https://video.twimg.com/other.mp4" width="600" height="400"></video></article>`);
    const result = await context[collector]({ id: 1 }, { fullContent: false, deepAssets: true });
    assert.equal(result.assets.videos.length, 0);
    assert.equal(result.assets.videoRects.length, 0);
    assert.equal(result.capture.postId, postId);
    assert.equal(result.capture.primaryPostId, "");
  });

  test(`${file}: payload uses the verified post text instead of a stale browser title`, async () => {
    const { context, tab } = harness(file, ownPost);
    const result = file === "popup.js" ? await context.buildPayload("eagle") : await context.buildPayloadForBackground("eagle", tab, {});
    assert.equal(result.url, postUrl);
    assert.equal(result.title, "My formula for a perfect concentric radius.");
    assert.equal(result.pageCapture.primaryPostId, postId);
    assert.equal(result.pageMeta.author, "");
    assert.equal(result.pageMeta.image, "");
    assert.equal(result.pageMeta.canonical, postUrl);
  });

  test(`${file}: navigation during capture rejects the mixed-page payload`, async () => {
    const { context, tab } = harness(file, ownPost);
    context.chrome.tabs.get = async () => ({ ...tab, url: "https://x.com/other/status/888" });
    await assert.rejects(file === "popup.js" ? context.buildPayload("eagle") : context.buildPayloadForBackground("eagle", tab, {}), /页面.*(?:变化|改变|切换)/);
  });
}

test("server rejects X content whose captured post differs from the requested post", () => {
  assert.throws(() => routerHooks.validatePayload({
    url: postUrl, targets: ["eagle"], pageCapture: { url: "https://x.com/other/status/888", postId: "888", primaryPostId: "888" }
  }), /帖子.*不一致|页面.*不一致/);
});

test("late polling results cannot replace a newer Eagle preview", async () => {
  const source = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
  const loop = source.slice(source.indexOf("async function pollTaskLoop("), source.indexOf("async function restoreActiveTasks("));
  const context = vm.createContext({
    currentTasks: { eagle: { id: "new-task" } },
    setTimeout: (resolve) => resolve(),
    getTask: async () => ({ id: "old-task", results: { eagle: { status: "needs_review" } } }),
    persistTaskState: async () => {}, renderTaskForTarget: () => {}
  });
  vm.runInContext(loop, context);
  await context.pollTaskLoop("old-task", "eagle");
  assert.equal(context.currentTasks.eagle.id, "new-task");
});
