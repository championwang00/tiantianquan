importScripts("config.js", "routerClient.js", "instagramCarousel.js");

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

function isXPostUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)(x|twitter)\.com$/i.test(parsed.hostname) && /\/status\/\d+/.test(parsed.pathname);
  } catch (_error) {
    return false;
  }
}

async function buildPayloadForBackground(target, tab, config) {
  const isRichMedia = isRichMediaUrl(tab.url || "");
  const eagleCaptureMode = config.eagleCaptureMode || "screenshot";
  const bearIncludesMedia = target === "bear";
  const needsScreenshot = (target === "eagle" && (eagleCaptureMode === "screenshot" || isRichMedia)) || bearIncludesMedia;
  const needsFullContent = target !== "eagle" || eagleCaptureMode === "snapshot" || isXPostUrl(tab.url);
  const needsDeepAssets = target === "bear"
    ? bearIncludesMedia
    : target !== "eagle" || isRichMedia || eagleCaptureMode === "top-image";
  const [screenshotDataUrl, pageContext] = await Promise.all([
    needsScreenshot ? captureVisibleTabInBackground(tab.windowId) : Promise.resolve(""),
    collectPageContextInBackground(tab, { fullContent: needsFullContent, deepAssets: needsDeepAssets })
  ]);
  await verifyPageCapture(tab, pageContext.capture);

  return {
    source: "chrome-extension",
    url: tab.url,
    title: pageContext.capture.title || tab.title || tab.url,
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
    pageCapture: pageContext.capture,
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
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["instagramCarousel.js"]
    });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [{ fullContent: options.fullContent !== false, deepAssets: options.deepAssets === true }],
      func: async ({ fullContent, deepAssets }) => {
        const traverseCarousel = globalThis.traverseInstagramCarousel;
        const extractEmbeddedCarousel = globalThis.extractInstagramEmbeddedCarousel;
        const metaContent = (selector) => document.querySelector(selector)?.content?.trim() || "";
        const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name)?.trim() || "";
        const mainTweetRoot = findMainTweetRoot();
        const isTweet = /(^|\.)(x|twitter)\.com$/.test(location.hostname) && /\/status\/\d+/.test(location.pathname);
        const postId = isTweet ? location.pathname.match(/\/status\/(\d+)/)[1] : "";
        const isXiaohongshuPost = /(^|\.)xiaohongshu\.com$/.test(location.hostname) && /^\/explore\/[^/]+/.test(location.pathname);
        const xiaohongshuRoot = isXiaohongshuPost ? document.querySelector("#noteContainer, .note-container") : null;
        const xiaohongshuMediaRoot = xiaohongshuRoot?.querySelector(".media-container") || xiaohongshuRoot;
        const structuredVideos = isXiaohongshuPost ? collectStructuredVideos() : [];
        const weChatRoot = findWeChatArticleRoot();
        const article = isTweet
          ? mainTweetRoot?.cloneNode(true) || document.createElement("div")
          : isXiaohongshuPost
            ? xiaohongshuRoot?.cloneNode(true) || document.createElement("div")
            : findReadableRoot(weChatRoot);
        if (isTweet) for (const quote of article.querySelectorAll('[data-testid="quoteTweet"], div[role="link"]')) quote.remove();
        const structuredArticle = isTweet || isXiaohongshuPost ? article : weChatRoot || findArticleRoot();
        const visibleText = isTweet
          ? getVisibleText(article.querySelector('[data-testid="tweetText"]'))
          : getVisibleText(article);
        const mediaRoot = isTweet ? mainTweetRoot : xiaohongshuMediaRoot;
        const images = isXiaohongshuPost && structuredVideos.length
          ? []
          : collectImages(deepAssets, mediaRoot).slice(0, deepAssets ? 20 : 6);
        const videos = deepAssets ? collectVideos(mediaRoot, structuredVideos).slice(0, 10) : [];
        const videoRects = deepAssets ? collectVideoRects(mediaRoot).slice(0, 5) : [];
        const carousel = deepAssets ? await collectInstagramCarousel() : [];
        const content = fullContent
          ? {
              text: (isTweet ? visibleText : visibleText || getVisibleText(document.body)).slice(0, 60000),
              markdown: nodeToMarkdown(article).replace(/\n{3,}/g, "\n\n").trim().slice(0, 80000),
              articleHtml: structuredArticle?.outerHTML?.slice(0, 240000) || "",
              htmlSnapshot: `<!doctype html>\n${document.documentElement.outerHTML}`.slice(0, 240000)
            }
          : { text: visibleText.slice(0, 12000), markdown: "", articleHtml: "", htmlSnapshot: "" };
        return {
          capture: { url: location.href, title: isTweet ? visibleText || "X 帖子" : document.title, postId, primaryPostId: mainTweetRoot ? postId : "" },
          meta: {
            description: isTweet ? visibleText : metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]'),
            author: isTweet ? getVisibleText(mainTweetRoot?.querySelector('[data-testid="User-Name"]')) : metaContent('meta[name="author"]') || metaContent('meta[property="article:author"]'),
            siteName: metaContent('meta[property="og:site_name"]'),
            image: isTweet ? "" : structuredVideos[0]?.poster || normalizeMetaImage(metaContent('meta[property="og:image"]') || metaContent('meta[name="twitter:image"]')),
            canonical: isTweet ? location.href : attr('link[rel="canonical"]', "href"),
            published: metaContent('meta[property="article:published_time"]') || metaContent('meta[name="article:published_time"]')
          },
          assets: {
            images,
            videos,
            videoRects,
            carousel,
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
          const weChatRoot = findWeChatArticleRoot();
          if (weChatRoot) return weChatRoot;
          const candidates = [
            ...document.querySelectorAll("#js_content, .rich_media_content, article, main, [role='main'], .article, .post, .entry-content, .markdown-body, .content")
          ].filter(Boolean);
          return candidates
            .map((node) => ({ node, score: readableScore(node) }))
            .sort((a, b) => b.score - a.score)[0]?.node || document.body;
        }

        function findArticleRoot() {
          const preferred = findWeChatArticleRoot()
            || document.querySelector("article")
            || document.querySelector("[role='main'] article")
            || document.querySelector("main");
          if (preferred) return preferred;
          let bestNode = null;
          let bestScore = -1;
          const candidates = document.querySelectorAll("section, div");
          const limit = Math.min(candidates.length, 500);
          for (let index = 0; index < limit; index += 1) {
            const node = candidates[index];
            const textLength = (node.innerText || "").trim().length;
            if (textLength < 200) continue;
            const score = textLength
              + node.querySelectorAll("p, li, blockquote, pre, h1, h2, h3").length * 180
              + node.querySelectorAll("img").length * 80;
            if (score > bestScore) {
              bestNode = node;
              bestScore = score;
            }
          }
          return bestNode || document.body;
        }

        function findWeChatArticleRoot() {
          if (!/(^|\.)mp\.weixin\.qq\.com$/.test(location.hostname)) return null;
          return document.querySelector("#js_content")
            || document.querySelector(".rich_media_content")
            || document.querySelector("#js_article");
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
                if (!isPrimaryTweetNode(link, article)) return false;
                if (article.querySelector("time") && !link.querySelector("time")) return false;
                return new URL(link.href, location.href).pathname.match(/\/status\/(\d+)/)?.[1] === statusId;
              } catch (_error) {
                return false;
              }
            }));
          if (byStatusLink) return byStatusLink;
          return null;
        }

        function isPrimaryTweetNode(node, root) {
          if (!root || node.closest("article") !== root) return false;
          const quote = node.closest('[data-testid="quoteTweet"], div[role="link"]');
          return !quote || !root.contains(quote);
        }

        async function collectInstagramCarousel() {
          if (!/^\/p\//.test(location.pathname) || !/(^|\.)instagram\.com$/.test(location.hostname)) return [];
          const embedded = extractEmbeddedCarousel?.([...document.scripts].map((script) => script.textContent || ""), location.href) || [];
          if (embedded.length) return embedded;
          const root = document.querySelector('main article') || document.querySelector('article') || document.querySelector('main') || document.body;
          if (!root) return [];
          const activeMedia = () => [...root.querySelectorAll('video, img')].filter((node) => !node.closest('header, nav, aside, [role="dialog"], [role="complementary"]')).map((node) => ({ node, rect: node.getBoundingClientRect() })).filter(({ rect }) => rect.width >= 240 && rect.height >= 240 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth).sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.node || null;
          if (!activeMedia()) return [];
          const items = new Map();
          const read = () => {
            const active = activeMedia(); if (!active) return;
            const viewportNode = active.parentElement;
            const viewport = viewportNode.getBoundingClientRect();
            const media = [...viewportNode.querySelectorAll('video, img')].filter((node) => {
              if (node.closest('header, nav, aside, [role="dialog"], [role="complementary"]')) return false;
              const rect = node.getBoundingClientRect();
              return rect.width >= 240 && rect.height >= 240 && rect.left >= viewport.left - 2 && rect.right <= viewport.right + 2 && rect.top >= viewport.top - 2 && rect.bottom <= viewport.bottom + 2;
            });
            for (const node of media) {
              const isVideo = node.tagName === 'VIDEO';
              const src = isVideo
                ? (node.currentSrc || node.src || [...node.querySelectorAll('source')].map((source) => source.src).find(Boolean) || '')
                : (pickLargestSrcset(node.getAttribute('srcset') || '') || node.currentSrc || node.src || '');
              const normalized = absolutize(src);
              if (!normalized || normalized.startsWith('data:')) continue;
              const key = `${isVideo ? 'video' : 'image'}:${normalized}`;
              if (!items.has(key)) items.set(key, {
                index: items.size,
                type: isVideo ? 'video' : 'image',
                src: normalized,
                poster: isVideo ? absolutize(node.poster || '') : '',
                mediaId: node.getAttribute('data-media-id') || node.getAttribute('data-id') || node.closest('[data-media-id], [data-id]')?.getAttribute('data-media-id') || node.closest('[data-media-id], [data-id]')?.getAttribute('data-id') || normalized.match(/(?:media|video)[_\/-](\d{5,})/i)?.[1] || (() => { try { return new URL(normalized).searchParams.get('id') || ''; } catch (_error) { return ''; } })(),
                duration: isVideo && Number.isFinite(node.duration) ? node.duration : 0,
                width: node.videoWidth || node.naturalWidth || node.clientWidth || 0,
                height: node.videoHeight || node.naturalHeight || node.clientHeight || 0
              });
            }
          };
          const signature = () => { const node = activeMedia(); return node?.currentSrc || node?.src || node?.poster || ''; };
          const control = (direction) => {
            const active = activeMedia(); if (!active) return null;
            const viewport = active.parentElement.getBoundingClientRect();
            const buttons = [...root.querySelectorAll('[role="button"], button')].filter((button) => { const rect = button.getBoundingClientRect(); return rect.width > 0 && rect.right >= viewport.left && rect.left <= viewport.right && rect.bottom >= viewport.top && rect.top <= viewport.bottom; });
            const words = direction === 'next' ? /next|下一|次へ|다음/i : /previous|prev|上一|前へ|이전/i;
            const semantic = buttons.find((button) => words.test(`${button.getAttribute('aria-label') || ''} ${button.querySelector('svg title')?.textContent || ''}`));
            if (semantic) return semantic;
            return buttons.find((button) => { const svg = button.querySelector('svg'); const rect = button.getBoundingClientRect(); return svg && rect.width <= 64 && rect.height <= 64 && (direction === 'next' ? rect.left > viewport.left + viewport.width * .65 : rect.right < viewport.left + viewport.width * .35); });
          };
          const waitForChange = async (before) => {
            for (let poll = 0; poll < 10; poll += 1) { await new Promise((resolve) => setTimeout(resolve, 60)); if (signature() && signature() !== before) return signature(); }
            return '';
          };
          return traverseCarousel({ read: () => { read(); return [...items.values()]; }, signature, clickPrevious: () => { const button = control('previous'); if (!button) return false; button.click(); return true; }, clickNext: () => { const button = control('next'); if (!button) return false; button.click(); return true; }, waitForChange, maxTransitions: 30 });
        }

        function collectImages(deep, scopeRoot = null) {
          if (isTweet && !scopeRoot) return [];
          const seen = new Set();
          const items = [];
          const push = (src, alt = "", width = 0, height = 0, scope = "") => {
            const normalized = normalizeImageAssetUrl(absolutize(src));
            if (!normalized || seen.has(normalized)) return;
            if (normalized.startsWith("data:") || normalized.startsWith("blob:")) return;
            if (isXDefaultOgImage(normalized)) return;
            seen.add(normalized);
            items.push({ src: normalized, alt, width, height, tweetScope: scope, sourcePostId: scope === "primary" ? postId : "" });
          };

          const imageNodes = scopeRoot ? [...scopeRoot.querySelectorAll("img")].filter((image) => isScopedMediaNode(image, scopeRoot)) : [...document.images];
          const documentImages = deep ? imageNodes : imageNodes.slice(0, 80);
          for (const image of documentImages) {
            const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || "";
            const fromSrcset = pickLargestSrcset(srcset);
            push(
              imageSource(image, fromSrcset),
              image.alt || "",
              imageWidth(image),
              imageHeight(image),
              tweetScopeForImage(image, scopeRoot)
            );
          }

          if (deep) {
            const styledNodes = scopeRoot ? [...scopeRoot.querySelectorAll("[style]")] : [...document.querySelectorAll("[style]")];
            for (const node of styledNodes) {
              if (scopeRoot && !isScopedMediaNode(node, scopeRoot)) continue;
              const match = String(node.getAttribute("style") || "").match(/url\((['"]?)(.*?)\1\)/);
              if (match?.[2]) push(match[2], node.getAttribute("aria-label") || "", node.clientWidth || 0, node.clientHeight || 0, tweetScopeForImage(node, scopeRoot));
            }
          }

          return items
            .filter((image) => image.width >= 180 || image.height >= 180 || /pbs\.twimg\.com\/media|xiaohongshu|xhscdn|sns-webpic|sns-img/i.test(image.src))
            .sort((a, b) => (b.width * b.height) - (a.width * a.height));
        }

        function imageSource(image, fromSrcset = "") {
          return fromSrcset
            || image.currentSrc
            || image.getAttribute("data-src")
            || image.getAttribute("data-original")
            || image.getAttribute("data-croporisrc")
            || image.getAttribute("data-backsrc")
            || image.getAttribute("data-url")
            || image.src;
        }

        function imageWidth(image) {
          return image.naturalWidth
            || image.width
            || Number(image.getAttribute("data-w") || image.getAttribute("width") || 0)
            || 0;
        }

        function imageHeight(image) {
          const width = imageWidth(image);
          const ratio = Number(image.getAttribute("data-ratio") || 0);
          return image.naturalHeight
            || image.height
            || Number(image.getAttribute("height") || 0)
            || (width && ratio ? Math.round(width * ratio) : 0)
            || 0;
        }

        function tweetScopeForImage(node, scopeRoot = null) {
          if (!scopeRoot || !isTweet) return "";
          return isPrimaryTweetNode(node, scopeRoot) ? "primary" : "";
        }

        function isScopedMediaNode(node, scopeRoot) {
          return isTweet ? isPrimaryTweetNode(node, scopeRoot) : Boolean(scopeRoot?.contains(node));
        }

        function normalizeImageAssetUrl(src) {
          if (!src) return "";
          try {
            const parsed = new URL(src, location.href);
            if (parsed.hostname === "pbs.twimg.com" && parsed.pathname.startsWith("/media/")) {
              parsed.searchParams.set("name", "orig");
            }
            return parsed.toString();
          } catch (_error) {
            return src;
          }
        }

        function normalizeMetaImage(src) {
          const normalized = absolutize(src || "");
          return isXDefaultOgImage(normalized) ? "" : normalized;
        }

        function isXDefaultOgImage(src) {
          return /abs\.twimg\.com\/rweb\/ssr\/default\/v\d+\/og\/image\.png/i.test(String(src || ""));
        }

        function collectVideos(scopeRoot = null, structured = []) {
          if (isTweet && !scopeRoot) return [];
          const seen = new Set();
          const items = [];
          const push = (src, label = "", poster = "", detail = {}) => {
            const normalized = absolutize(cleanEscapedUrl(src));
            if (!normalized || seen.has(normalized)) return;
            if (normalized.startsWith("data:") || normalized.startsWith("blob:")) return;
            if (!isLikelyVideoUrl(normalized)) return;
            seen.add(normalized);
            items.push({
              src: normalized,
              label,
              poster: normalizeMetaImage(poster || ""),
              source: detail.source || "",
              width: Number(detail.width || 0),
              height: Number(detail.height || 0),
              duration: Number(detail.duration || 0),
              tweetScope: scopeRoot && isTweet ? "primary" : "",
              sourcePostId: scopeRoot && isTweet ? postId : ""
            });
          };

          for (const video of structured) push(video.src, video.label || "页面视频", video.poster || "", { source: "json-ld", duration: video.duration || 0 });

          const videoNodes = scopeRoot ? [...scopeRoot.querySelectorAll("video")].filter((video) => isScopedMediaNode(video, scopeRoot)) : [...document.querySelectorAll("video")];
          for (const video of videoNodes) {
            const detail = {
              source: "video-element",
              width: video.videoWidth || video.clientWidth || 0,
              height: video.videoHeight || video.clientHeight || 0,
              duration: Number.isFinite(video.duration) ? video.duration : 0
            };
            push(video.currentSrc || video.src, video.getAttribute("aria-label") || video.title || "页面视频", video.poster || "", detail);
            for (const source of [...video.querySelectorAll("source")]) {
              push(source.src || source.getAttribute("src"), source.type || "页面视频", video.poster || "", detail);
            }
          }

          if (!scopeRoot) for (const selector of [
            'meta[property="og:video"]',
            'meta[property="og:video:url"]',
            'meta[property="og:video:secure_url"]',
            'meta[name="og:video"]',
            'meta[name="og:video:url"]',
            'meta[name="og:video:secure_url"]',
            'meta[name="video"]',
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
          if (isTweet && !scopeRoot) return [];
          const videoNodes = scopeRoot ? [...scopeRoot.querySelectorAll("video")].filter((video) => isScopedMediaNode(video, scopeRoot)) : [...document.querySelectorAll("video")];
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
                tweetScope: scopeRoot && isTweet ? "primary" : "",
                sourcePostId: scopeRoot && isTweet ? postId : "",
                poster: video.poster || "",
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

        function collectStructuredVideos() {
          const items = [];
          const visit = (value) => {
            if (Array.isArray(value)) { for (const item of value) visit(item); return; }
            if (!value || typeof value !== "object") return;
            const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
            if (types.some((type) => String(type).toLowerCase() === "videoobject") && value.contentUrl) {
              const thumbnail = Array.isArray(value.thumbnailUrl) ? value.thumbnailUrl[0] : value.thumbnailUrl;
              items.push({
                src: normalizeXiaohongshuUrl(value.contentUrl),
                poster: normalizeXiaohongshuUrl(thumbnail),
                duration: parseStructuredDuration(value.duration),
                label: String(value.name || "小红书视频")
              });
            }
            if (value["@graph"]) visit(value["@graph"]);
          };
          for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
            try { visit(JSON.parse(script.textContent || "null")); } catch (_error) {}
          }
          return items.filter((item) => item.src);
        }

        function normalizeXiaohongshuUrl(value) {
          if (!value) return "";
          try {
            const url = new URL(value, location.href);
            if (url.hostname === "xhscdn.com" || url.hostname.endsWith(".xhscdn.com")) url.protocol = "https:";
            return url.toString();
          } catch (_error) { return ""; }
        }

        function parseStructuredDuration(value) {
          const text = String(value || "").trim();
          const iso = text.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
          if (iso) return Number(iso[1] || 0) * 3600 + Number(iso[2] || 0) * 60 + Number(iso[3] || 0);
          const parts = text.split(":").map(Number);
          return parts.length >= 2 && parts.every(Number.isFinite) ? parts.reduce((total, part) => total * 60 + part, 0) : 0;
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
          let extension = "";
          try { extension = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || ""; } catch (_error) {}
          if (extension && !["mp4", "m4v", "mov", "webm", "m3u8"].includes(extension)) return false;
          return /\.(mp4|m4v|mov|webm|m3u8)(?:[?#]|$)/i.test(url);
        }

        function pickLargestSrcset(srcset) {
          if (!srcset) return "";
          return srcset
            .split(/,\s+/)
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
            const src = imageSource(node, pickLargestSrcset(node.getAttribute("srcset") || node.getAttribute("data-srcset") || ""));
            if (src && imageWidth(node) >= 160) pushUnique(blocks, seen, `![${node.alt || ""}](${src})`);
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
                const src = imageSource(child, pickLargestSrcset(child.getAttribute("srcset") || child.getAttribute("data-srcset") || ""));
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
  return { meta: {}, assets: { images: [], videos: [], videoRects: [], carousel: [] }, content: { text: "", markdown: "", htmlSnapshot: "" } };
}

function isRichMediaUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "x.com"
      || host === "twitter.com"
      || host.endsWith(".x.com")
      || host.endsWith(".twitter.com")
      || host === "xiaohongshu.com"
      || host.endsWith(".xiaohongshu.com")
      || host === "instagram.com"
      || host.endsWith(".instagram.com");
  } catch (_error) {
    return false;
  }
}

async function pollTaskInBackground(taskId, target, tab, attempt = 0) {
  if (!taskId || attempt > 75) return;
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
