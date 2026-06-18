importScripts("config.js", "routerClient.js");

const SESSION_TASKS_KEY = "clipRouterActiveTasks";

const MENU_ITEMS = [
  { id: "open-popup", title: "同步当前页面..." },
  { id: "send-eagle", title: "保存到 Eagle" },
  { id: "send-bear", title: "写入 Bear" },
  { id: "send-obsidian", title: "写入 Obsidian" }
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const item of MENU_ITEMS) {
      chrome.contextMenus.create({
        id: item.id,
        title: item.title,
        contexts: ["page", "selection", "link"]
      });
    }
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !tab.url) return;

  if (info.menuItemId === "open-popup") {
    chrome.action.openPopup();
    return;
  }

  const targetByMenu = {
    "send-eagle": "eagle",
    "send-bear": "bear",
    "send-obsidian": "obsidian"
  };
  const target = targetByMenu[info.menuItemId];
  if (!target) return;

  await chrome.storage.session.set({
    pendingTarget: target
  });
  chrome.action.openPopup();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PREPARE_TARGET") {
    prepareTargetInBackground(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message || String(error) }));
    return true;
  }

  if (message?.type !== "CAPTURE_VISIBLE_TAB") return false;

  chrome.tabs.captureVisibleTab({ format: "png" }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      sendResponse({ error: chrome.runtime.lastError.message });
      return;
    }
    sendResponse({ dataUrl });
  });

  return true;
});

async function prepareTargetInBackground(message) {
  const target = message.target;
  const tab = message.tab;
  const config = message.config || {};
  if (!target || !tab?.id || !tab.url) throw new Error("没有可采集的页面");

  const payload = await buildPayloadForBackground(target, tab, config);
  const result = await sendClip(payload);
  const taskState = {
    target,
    taskId: result.taskId,
    tabId: tab.id || 0,
    url: tab.url,
    title: tab.title || tab.url,
    task: {
      id: result.taskId,
      target,
      results: { [target]: { status: "queued" } }
    },
    updatedAt: Date.now()
  };
  await persistBackgroundTaskState(target, taskState);
  pollTaskInBackground(result.taskId, target, tab).catch(() => {});
  return { taskId: result.taskId, target };
}

async function buildPayloadForBackground(target, tab, config) {
  const isRichMedia = isRichMediaUrl(tab.url || "");
  const eagleCaptureMode = config.eagleCaptureMode || "screenshot";
  const needsScreenshot = (target === "eagle" && (eagleCaptureMode === "screenshot" || isRichMedia)) || target === "bear";
  const needsFullContent = target !== "eagle" || eagleCaptureMode === "snapshot";
  const needsDeepAssets = target !== "eagle" || isRichMedia || eagleCaptureMode === "top-image";
  const [screenshotDataUrl, pageContext] = await Promise.all([
    needsScreenshot ? captureVisibleTabInBackground(tab.windowId) : Promise.resolve(""),
    collectPageContextInBackground(tab, { fullContent: needsFullContent, deepAssets: needsDeepAssets })
  ]);

  return {
    source: "chrome-extension",
    url: tab.url,
    title: tab.title || tab.url,
    selectedText: "",
    userNote: "",
    targets: [target],
    options: {
      eagle: {
        hintFolders: [],
        forceScreenshot: needsScreenshot,
        captureMode: eagleCaptureMode,
        folderIds: []
      },
      bear: {
        noScreenshot: config.bearNoScreenshot === true
      },
      obsidian: {
        tags: []
      }
    },
    pageMeta: pageContext.meta,
    pageAssets: pageContext.assets,
    pageContent: pageContext.content,
    screenshotDataUrl,
    capturedAt: new Date().toISOString()
  };
}

async function captureVisibleTabInBackground(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (_error) {
    return "";
  }
}

async function collectPageContextInBackground(tab, options = {}) {
  if (!tab?.id) return emptyPageContext();

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [{ fullContent: options.fullContent !== false, deepAssets: options.deepAssets === true }],
      func: ({ fullContent, deepAssets }) => {
        const metaContent = (selector) => document.querySelector(selector)?.content?.trim() || "";
        const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name)?.trim() || "";
        const mainTweetRoot = findMainTweetRoot();
        const article = findReadableRoot(mainTweetRoot);
        const visibleText = getVisibleText(article);
        const images = collectImages(deepAssets, mainTweetRoot).slice(0, deepAssets ? 20 : 6);
        const videos = deepAssets ? collectVideos(mainTweetRoot).slice(0, 10) : [];
        const videoRects = deepAssets ? collectVideoRects(mainTweetRoot).slice(0, 5) : [];
        const content = fullContent
          ? {
              text: (visibleText || getVisibleText(document.body)).slice(0, 60000),
              markdown: nodeToMarkdown(article).replace(/\n{3,}/g, "\n\n").trim().slice(0, 80000),
              htmlSnapshot: `<!doctype html>\n${document.documentElement.outerHTML}`.slice(0, 240000)
            }
          : { text: "", markdown: "", htmlSnapshot: "" };
        return {
          meta: {
            description: metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]'),
            author: metaContent('meta[name="author"]') || metaContent('meta[property="article:author"]'),
            siteName: metaContent('meta[property="og:site_name"]'),
            image: normalizeMetaImage(metaContent('meta[property="og:image"]') || metaContent('meta[name="twitter:image"]')),
            canonical: attr('link[rel="canonical"]', "href"),
            published: metaContent('meta[property="article:published_time"]') || metaContent('meta[name="article:published_time"]')
          },
          assets: {
            images,
            videos,
            videoRects,
            viewport: {
              width: window.innerWidth || document.documentElement.clientWidth || 0,
              height: window.innerHeight || document.documentElement.clientHeight || 0,
              devicePixelRatio: window.devicePixelRatio || 1
            }
          },
          content
        };

        function findReadableRoot(scopeRoot = null) {
          if (scopeRoot) return scopeRoot;
          const socialRoot = findSocialContentRoot();
          if (socialRoot) return socialRoot;
          const candidates = [
            ...document.querySelectorAll("article, main, [role='main'], .article, .post, .entry-content, .markdown-body, .content")
          ].filter(Boolean);
          return candidates
            .map((node) => ({ node, score: readableScore(node) }))
            .sort((a, b) => b.score - a.score)[0]?.node || document.body;
        }

        function findSocialContentRoot(scopeRoot = document) {
          const tweetTextNodes = [...scopeRoot.querySelectorAll('[data-testid="tweetText"], [lang][dir="auto"]')]
            .filter((node) => (node.innerText || "").trim().length > 8);
          if (!tweetTextNodes.length) return null;
          const container = document.createElement("div");
          container.dataset.syntheticReadableRoot = "social";
          for (const node of tweetTextNodes.slice(0, 12)) {
            const block = document.createElement("p");
            block.textContent = getVisibleText(node);
            container.append(block);
          }
          return container;
        }

        function getVisibleText(node) {
          return (node?.innerText || node?.textContent || "")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/[ \t]{2,}/g, " ")
            .trim();
        }

        function readableScore(node) {
          const textLength = (node.innerText || "").trim().length;
          const paragraphCount = node.querySelectorAll("p, li, blockquote, pre, h1, h2, h3").length;
          const imageCount = node.querySelectorAll("img").length;
          return textLength + paragraphCount * 180 + imageCount * 80;
        }

        function findMainTweetRoot() {
          const statusId = location.pathname.match(/\/status\/(\d+)/)?.[1] || "";
          if (!statusId) return null;
          const primaryColumn = document.querySelector('[data-testid="primaryColumn"], main');
          const articles = [...(primaryColumn || document).querySelectorAll('article[data-testid="tweet"], article')];
          const byStatusLink = articles.find((article) => [...article.querySelectorAll('a[href*="/status/"]')]
            .some((link) => {
              try {
                return new URL(link.href, location.href).pathname.includes(`/status/${statusId}`);
              } catch (_error) {
                return false;
              }
            }));
          if (byStatusLink) return byStatusLink;
          return articles.find((article) => article.querySelector('[data-testid="tweetText"], [data-testid="tweetPhoto"], video, img[src*="pbs.twimg.com/media"]')) || null;
        }

        function collectImages(deep, scopeRoot = null) {
          const seen = new Set();
          const items = [];
          const push = (src, alt = "", width = 0, height = 0) => {
            const normalized = absolutize(src);
            if (!normalized || seen.has(normalized)) return;
            if (normalized.startsWith("data:") || normalized.startsWith("blob:")) return;
            if (isXDefaultOgImage(normalized)) return;
            seen.add(normalized);
            items.push({ src: normalized, alt, width, height });
          };

          const imageNodes = scopeRoot ? [...scopeRoot.querySelectorAll("img")].filter((image) => image.closest("article") === scopeRoot) : [...document.images];
          const documentImages = deep ? imageNodes : imageNodes.slice(0, 80);
          for (const image of documentImages) {
            const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || "";
            const fromSrcset = pickLargestSrcset(srcset);
            push(
              fromSrcset || image.currentSrc || image.getAttribute("data-src") || image.getAttribute("data-original") || image.src,
              image.alt || "",
              image.naturalWidth || image.width || 0,
              image.naturalHeight || image.height || 0
            );
          }

          if (deep) {
            const styledNodes = scopeRoot ? [...scopeRoot.querySelectorAll("[style]")] : [...document.querySelectorAll("[style]")];
            for (const node of styledNodes) {
              const match = String(node.getAttribute("style") || "").match(/url\((['"]?)(.*?)\1\)/);
              if (match?.[2]) push(match[2], node.getAttribute("aria-label") || "", node.clientWidth || 0, node.clientHeight || 0);
            }
          }

          return items
            .filter((image) => image.width >= 180 || image.height >= 180 || /xiaohongshu|xhscdn|sns-webpic|sns-img/i.test(image.src))
            .sort((a, b) => (b.width * b.height) - (a.width * a.height));
        }

        function normalizeMetaImage(src) {
          const normalized = absolutize(src || "");
          return isXDefaultOgImage(normalized) ? "" : normalized;
        }

        function isXDefaultOgImage(src) {
          return /abs\.twimg\.com\/rweb\/ssr\/default\/v\d+\/og\/image\.png/i.test(String(src || ""));
        }

        function collectVideos(scopeRoot = null) {
          const seen = new Set();
          const items = [];
          const push = (src, label = "", poster = "") => {
            const normalized = absolutize(cleanEscapedUrl(src));
            if (!normalized || seen.has(normalized)) return;
            if (normalized.startsWith("data:") || normalized.startsWith("blob:")) return;
            if (!isLikelyVideoUrl(normalized)) return;
            seen.add(normalized);
            items.push({ src: normalized, label, poster: normalizeMetaImage(poster || "") });
          };

          const videoNodes = scopeRoot ? [...scopeRoot.querySelectorAll("video")].filter((video) => video.closest("article") === scopeRoot) : [...document.querySelectorAll("video")];
          for (const video of videoNodes) {
            push(video.currentSrc || video.src, video.getAttribute("aria-label") || video.title || "页面视频", video.poster || "");
            for (const source of [...video.querySelectorAll("source")]) {
              push(source.src || source.getAttribute("src"), source.type || "页面视频", video.poster || "");
            }
          }

          if (!scopeRoot) for (const selector of [
            'meta[property="og:video"]',
            'meta[property="og:video:url"]',
            'meta[property="og:video:secure_url"]',
            'meta[name="og:video"]',
            'meta[name="og:video:url"]',
            'meta[name="og:video:secure_url"]',
            'meta[name="twitter:player:stream"]',
            'meta[name="twitter:player"]'
          ]) {
            const value = metaContent(selector);
            push(value, "页面视频", normalizeMetaImage(metaContent('meta[property="og:image"]') || metaContent('meta[name="twitter:image"]')));
          }

          const scriptText = scopeRoot ? "" : [...document.scripts]
            .map((script) => script.textContent || "")
            .filter((text) => /mp4|m3u8|video|stream/i.test(text))
            .join("\n")
            .slice(0, 800000);
          for (const url of extractVideoUrls(scriptText)) push(url, "页面视频");

          return items;
        }

        function collectVideoRects(scopeRoot = null) {
          const videoNodes = scopeRoot ? [...scopeRoot.querySelectorAll("video")].filter((video) => video.closest("article") === scopeRoot) : [...document.querySelectorAll("video")];
          return videoNodes
            .map((video, index) => {
              const rect = video.getBoundingClientRect();
              const left = Math.max(0, rect.left);
              const top = Math.max(0, rect.top);
              const right = Math.min(window.innerWidth || document.documentElement.clientWidth || 0, rect.right);
              const bottom = Math.min(window.innerHeight || document.documentElement.clientHeight || 0, rect.bottom);
              const width = Math.max(0, right - left);
              const height = Math.max(0, bottom - top);
              return {
                x: left,
                y: top,
                width,
                height,
                naturalWidth: video.videoWidth || 0,
                naturalHeight: video.videoHeight || 0,
                label: video.getAttribute("aria-label") || video.title || `页面视频 ${index + 1}`
              };
            })
            .filter((rect) => rect.width >= 120 && rect.height >= 80)
            .sort((a, b) => (b.width * b.height) - (a.width * a.height));
        }

        function extractVideoUrls(text) {
          const urls = new Set();
          const directPattern = /https?:\\?\/\\?\/[^"'\s<>]+?(?:\.mp4|\.m3u8)(?:\?[^"'\s<>]*)?/gi;
          for (const match of text.matchAll(directPattern)) urls.add(match[0]);
          const escapedPattern = /https?:\\\\\/\\\\\/[^"'\s<>]+?(?:\.mp4|\.m3u8)(?:\\[^"'\s<>]*)?/gi;
          for (const match of text.matchAll(escapedPattern)) urls.add(match[0]);
          return [...urls].map(cleanEscapedUrl);
        }

        function cleanEscapedUrl(value) {
          return String(value || "")
            .replace(/\\u002F/g, "/")
            .replace(/\\\//g, "/")
            .replace(/&amp;/g, "&")
            .replace(/\\u0026/g, "&")
            .replace(/\\u003D/g, "=")
            .replace(/\\u003F/g, "?");
        }

        function isLikelyVideoUrl(url) {
          return /\.(mp4|m4v|mov|webm|m3u8)(?:[?#]|$)/i.test(url)
            || /video|stream|m3u8|mp4|sns-video|xhscdn/i.test(url);
        }

        function pickLargestSrcset(srcset) {
          if (!srcset) return "";
          return srcset
            .split(",")
            .map((part) => {
              const [src, size] = part.trim().split(/\s+/);
              const weight = Number(String(size || "").replace(/[^\d.]/g, "")) || 0;
              return { src, weight };
            })
            .filter((item) => item.src)
            .sort((a, b) => b.weight - a.weight)[0]?.src || "";
        }

        function absolutize(src) {
          if (!src) return "";
          try {
            return new URL(src, location.href).toString();
          } catch (_error) {
            return src;
          }
        }

        function nodeToMarkdown(root) {
          const blocks = [];
          walk(root, blocks, new Set());
          return blocks.join("\n\n");
        }

        function walk(node, blocks, seen) {
          if (!node) return;
          if (node.nodeType === Node.TEXT_NODE) return;
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const tag = node.tagName.toLowerCase();
          if (["script", "style", "noscript", "svg", "nav", "footer", "aside", "form"].includes(tag)) return;
          const text = node.innerText?.trim().replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ") || "";
          if (tag.match(/^h[1-6]$/) && text) {
            pushUnique(blocks, seen, `${"#".repeat(Number(tag[1]))} ${text}`);
            return;
          }
          if (tag === "p" && text) {
            pushUnique(blocks, seen, inlineMarkdown(node) || text);
            return;
          }
          if (tag === "img") {
            const src = node.currentSrc || node.src;
            if (src && (node.naturalWidth || node.width || 0) >= 160) pushUnique(blocks, seen, `![${node.alt || ""}](${src})`);
            return;
          }
          if (tag === "li" && text) {
            pushUnique(blocks, seen, `- ${inlineMarkdown(node) || text}`);
            return;
          }
          if (tag === "blockquote" && text) {
            pushUnique(blocks, seen, text.split("\n").map((line) => `> ${line}`).join("\n"));
            return;
          }
          if (["pre", "code"].includes(tag) && text) {
            pushUnique(blocks, seen, `\`\`\`\n${text}\n\`\`\``);
            return;
          }
          for (const child of node.children) walk(child, blocks, seen);
        }

        function inlineMarkdown(node) {
          const pieces = [];
          for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              pieces.push(child.textContent || "");
            } else if (child.nodeType === Node.ELEMENT_NODE) {
              const tag = child.tagName.toLowerCase();
              if (tag === "a") {
                const text = child.innerText?.trim() || child.href;
                pieces.push(child.href ? `[${text}](${child.href})` : text);
              } else if (tag === "img") {
                const src = child.currentSrc || child.src;
                if (src) pieces.push(`![${child.alt || ""}](${src})`);
              } else {
                pieces.push(child.innerText || "");
              }
            }
          }
          return pieces.join("").replace(/[ \t]{2,}/g, " ").trim();
        }

        function pushUnique(blocks, seen, value) {
          const normalized = String(value || "").replace(/\s+/g, " ").trim();
          if (!normalized || seen.has(normalized)) return;
          seen.add(normalized);
          blocks.push(value);
        }
      }
    });
    return result || emptyPageContext();
  } catch (_error) {
    return emptyPageContext();
  }
}

function emptyPageContext() {
  return { meta: {}, assets: { images: [], videos: [], videoRects: [] }, content: { text: "", markdown: "", htmlSnapshot: "" } };
}

function isRichMediaUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "x.com"
      || host === "twitter.com"
      || host.endsWith(".x.com")
      || host.endsWith(".twitter.com")
      || host === "xiaohongshu.com"
      || host.endsWith(".xiaohongshu.com");
  } catch (_error) {
    return false;
  }
}

async function pollTaskInBackground(taskId, target, tab, attempt = 0) {
  if (!taskId || attempt > 50) return;
  await new Promise((resolve) => setTimeout(resolve, attempt < 2 ? 300 : attempt < 8 ? 800 : 1500));
  const task = await getTask(taskId);
  if (!task) return;
  await persistBackgroundTaskState(target, {
    target,
    taskId,
    tabId: tab.id || 0,
    url: tab.url,
    title: tab.title || tab.url,
    task: { ...task, target },
    updatedAt: Date.now()
  });
  const status = task.results?.[target]?.status;
  if (["queued", "running"].includes(status)) await pollTaskInBackground(taskId, target, tab, attempt + 1);
}

async function persistBackgroundTaskState(target, state) {
  const result = await chrome.storage.session.get({ [SESSION_TASKS_KEY]: {} });
  const activeTasks = result[SESSION_TASKS_KEY] && typeof result[SESSION_TASKS_KEY] === "object" ? result[SESSION_TASKS_KEY] : {};
  activeTasks[target] = state;
  await chrome.storage.session.set({ [SESSION_TASKS_KEY]: activeTasks });
}
