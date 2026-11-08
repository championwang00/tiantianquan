import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { parseHTML } from "linkedom";
const extensionDir = path.resolve(import.meta.dirname, "../../extension");
function harness(file, body, url = "https://design.google/library/the-next-interface-gemini") {
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
  test(`${file}: structured HTML and preview text capture the same main article`, async () => {
    const { context } = harness(file, `<h1>The next interface</h1>${"<p>Gemini conversation about human agency and creativity.</p>".repeat(12)}<article><h2>Related</h2><a href="/other">Unrelated recommendation</a></article>`);
    const result = await context[collector]({ id: 1 }, { fullContent: true, deepAssets: false });
    assert.match(result.content.text, /Gemini conversation/);
    assert.match(result.content.articleHtml, /Gemini conversation/);
    assert.match(result.content.articleHtml, /The next interface/);
  });
}
