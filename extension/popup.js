let activeTab = null;
let currentTasks = {};
let eagleFolders = [];
let eagleFoldersLoaded = false;
let selectedEagleFolderIds = [];
let selectedEagleCandidateIds = [];
let selectedBearCandidateIds = [];
let routerToken = "";
const confirmingTargets = new Set();
const pollingTargets = new Set();
const successResetTimers = new Map();
let eagleFolderMenuOpen = false;
let eagleFolderMenuQuery = "";
let lastScrollTop = 0;
let restoringScroll = false;
let trackedScroller = null;
const SESSION_TASKS_KEY = "clipRouterActiveTasks";

const CHANNELS = {
  eagle: { label: "Eagle", confirm: (taskId) => confirmEagle(taskId, getEagleFolderIds(), getEagleCandidateIds()) },
  bear: { label: "Bear", confirm: (taskId, task) => confirmBear(taskId, task.results?.bear?.draft, getBearIncludeScreenshot(), getBearCandidateIds()) },
  obsidian: { label: "Obsidian", confirm: confirmObsidian }
};

const elements = {
  title: document.querySelector("#title"),
  url: document.querySelector("#url"),
  status: document.querySelector("#status"),
  shell: document.querySelector(".shell"),
  cards: [...document.querySelectorAll(".channel-card")]
};

init();

async function init() {
  bindStaticActions();
  bindBackgroundTaskUpdates();
  trackScrollPosition();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  elements.title.textContent = tab?.title || "未读取到标题";
  elements.url.textContent = tab?.url || "";

  const pending = await chrome.storage.session.get({ pendingTarget: "" });
  await chrome.storage.session.remove(["pendingTarget"]);
  if (CHANNELS[pending.pendingTarget]) setOnlyOpen(pending.pendingTarget);

  await hydrateOptions().catch((error) => {
    setShellState("error");
    setStatus(`读取配置失败：${error.message}`);
  });
  await restoreActiveTasks().catch(() => {});
  updateConfirmState();

  for (const card of elements.cards) {
    card.querySelector(".channel-summary").addEventListener("click", () => toggleCard(card.dataset.target));
    card.querySelector('[data-role="confirm"]').addEventListener("click", () => confirmChannel(card.dataset.target));
  }
  document.querySelector("#eagleCaptureMode").addEventListener("change", () => refreshIfOpen("eagle"));
  document.querySelector("#bearScreenshotToggle").addEventListener("change", persistCurrentOptions);
  await prepareOpenTargets().catch((error) => {
    setShellState("error");
    setStatus(`生成预览失败：${error.message}`);
  });
}

function bindStaticActions() {
  document.querySelector("#settingsButton")?.addEventListener("click", openSettings);
  document.querySelector("#footerSettingsButton")?.addEventListener("click", openSettings);
  document.addEventListener("pointerdown", closeEagleFolderMenuOnOutsidePointer, true);
}

async function openSettings() {
  try {
    if (chrome.runtime.openOptionsPage) {
      await chrome.runtime.openOptionsPage();
      return;
    }
  } catch (_error) {
    // Fallback below keeps the settings entry usable if openOptionsPage fails.
  }
  const url = chrome.runtime.getURL("options.html");
  await chrome.tabs.create({ url });
}

async function hydrateOptions() {
  const config = await getRouterConfig();
  routerToken = config.routerToken || "";
  document.querySelector("#eagleCaptureMode").value = config.eagleCaptureMode || "screenshot";
  document.querySelector("#bearScreenshotToggle").checked = config.bearNoScreenshot !== true;
  hydrateEagleFolders([]).catch(() => {});
}

async function hydrateEagleFolders(savedFolderIds = []) {
  try {
    const response = await getEagleFolders();
    eagleFolders = response.folders || [];
    eagleFoldersLoaded = true;
    if (!eagleFolders.length) throw new Error("Eagle 未返回文件夹");
    selectedEagleFolderIds = savedFolderIds.filter((id) => eagleFolders.some((folder) => folder.id === id));
    rerenderEaglePreview();
  } catch (error) {
    eagleFoldersLoaded = true;
    setCardInlineState("eagle", `文件夹读取失败：${error.message}`);
  }
}

function toggleCard(target) {
  const card = getCard(target);
  const open = !card.classList.contains("is-open");
  setCardOpen(target, open);
  updateConfirmState();
  if (open) prepareTarget(target);
}

function setOnlyOpen(target) {
  for (const card of elements.cards) setCardOpen(card.dataset.target, card.dataset.target === target);
}

function setCardOpen(target, open) {
  withScrollPreserved(() => {
    const card = getCard(target);
    card.classList.toggle("is-open", open);
    card.querySelector(".channel-summary").setAttribute("aria-expanded", String(open));
  });
}

async function prepareOpenTargets() {
  const targets = getOpenTargets();
  if (!targets.length || !activeTab?.url) return;
  const restored = await restoreActiveTasks();
  const pendingTargets = targets.filter((target) => !restored.includes(target));
  if (!pendingTargets.length) {
    setStatus("已恢复上次生成的预览。");
    updateConfirmState();
    return;
  }

  setShellState("loading");
  setStatus("正在生成展开项预览...");

  try {
    await persistOptions(targets);
    for (const target of pendingTargets) {
      await prepareTarget(target);
    }
    setStatus("预览已生成。");
  } catch (error) {
    setShellState("error");
    setStatus(`失败：${error.message}`);
  } finally {
    updateConfirmState();
  }
}

async function prepareTarget(target) {
  if (!activeTab?.url) return;
  setShellState("loading");
  setCardStatus(target, "生成中");
  setCardBusy(target, true);
  setCardHasContent(target, false);
  setCardLoading(target, target === "eagle" && isRichMediaUrl(activeTab.url)
    ? "正在后台读取页面并识别视频，可能需要十几秒..."
    : "正在后台读取页面并生成这个渠道的确认内容...");
  setCardPreview(target, []);
  setCardConfirmState(target);
  try {
    await withTimeout(persistOptions(getOpenTargets()), 3000, "保存配置超时");
    const result = await withTimeout(
      startBackgroundPrepare(target),
      target === "eagle" && isRichMediaUrl(activeTab.url) ? 30000 : 20000,
      "后台页面采集超时，请保持当前页面打开后重试"
    );
    currentTasks[target] = {
      id: result.taskId,
      target,
      results: { [target]: { status: "queued" } }
    };
    await persistTaskState(target, currentTasks[target]);
    await pollTask(result.taskId, target);
  } catch (error) {
    setShellState("error");
    setCardBusy(target, false);
    setCardStatus(target, "失败");
    setCardInlineState(target, `生成失败：${error.message}`);
    setCardPreview(target, error.message);
    if (currentTasks[target]?.results?.[target]) {
      currentTasks[target].results[target].status = "failed";
      currentTasks[target].results[target].reason = error.message;
    }
    setCardConfirmState(target);
  } finally {
    updateConfirmState();
  }
}

function refreshIfOpen(target) {
  if (!getCard(target).classList.contains("is-open")) return;
  delete currentTasks[target];
  removeTaskState(target).catch(() => {});
  prepareTarget(target).catch((error) => {
    setShellState("error");
    setCardBusy(target, false);
    setCardStatus(target, "失败");
    setCardPreview(target, error.message);
  });
}

async function confirmChannel(target) {
  const taskState = currentTasks[target];
  if (confirmingTargets.has(target)) return;
  const targetStatus = taskState?.results?.[target]?.status;
  if (!["needs_review", "success", "exists", "failed"].includes(targetStatus)) return;
  clearSuccessReset(target);

  confirmingTargets.add(target);
  try {
    setShellState("loading");
    setCardStatus(target, "写入中");
    setCardLoading(target, `正在写入 ${CHANNELS[target].label}...`);
    setCardConfirmState(target);
    const task = await CHANNELS[target].confirm(taskState.id, taskState);
    currentTasks[target] = { ...task, target };
    await persistTaskState(target, currentTasks[target]);
    renderTaskForTarget(task, target);
    scheduleSuccessReset(target);
    setStatus(`${CHANNELS[target].label} 写入完成。对应软件已尝试唤起。`);
  } catch (error) {
    setShellState("error");
    setCardStatus(target, "失败");
    if (currentTasks[target]?.results?.[target]) {
      currentTasks[target].results[target].status = "failed";
      currentTasks[target].results[target].reason = error.message;
    }
    setCardInlineState(target, `${CHANNELS[target].label} 写入失败：${error.message}`);
    setCardConfirmState(target);
  } finally {
    confirmingTargets.delete(target);
    setCardConfirmState(target);
  }
  updateConfirmState();
}

async function startBackgroundPrepare(target) {
  // Keep submission in the popup lifecycle. Waiting for an MV3 service worker
  // response can hang indefinitely even though the popup is still active.
  const payload = await buildPayload(target);
  const result = await sendClip(payload);
  if (!result?.taskId) throw new Error("本地服务没有返回任务 ID");
  return { taskId: result.taskId, target, submittedBy: "popup" };
}

function bindBackgroundTaskUpdates() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "session" || !changes[SESSION_TASKS_KEY]) return;
    const activeTasks = changes[SESSION_TASKS_KEY].newValue || {};
    for (const [target, state] of Object.entries(activeTasks)) {
      if (!CHANNELS[target] || state.url !== activeTab?.url || !state.task?.id) continue;
      currentTasks[target] = { ...state.task, target };
      renderTaskForTarget(currentTasks[target], target);
    }
    updateConfirmState();
  });
}

function scheduleSuccessReset(target) {
  clearSuccessReset(target);
  const timer = setTimeout(() => {
    const result = currentTasks[target]?.results?.[target];
    if (result && ["success", "exists"].includes(result.status)) {
      result.status = "needs_review";
      result.reason = "可以再次确认收录。";
      setCardStatus(target, "待确认");
      setCardInlineState(target, result.reason);
      setCardConfirmState(target);
    }
    successResetTimers.delete(target);
  }, 1000);
  successResetTimers.set(target, timer);
}

function clearSuccessReset(target) {
  const timer = successResetTimers.get(target);
  if (timer) clearTimeout(timer);
  successResetTimers.delete(target);
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

async function buildPayload(target) {
  const isRichMedia = isRichMediaUrl(activeTab?.url || "");
  const needsScreenshot = (target === "eagle" && (getEagleCaptureMode() === "screenshot" || isRichMedia)) || target === "bear";
  const needsFullContent = target !== "eagle" || getEagleCaptureMode() === "snapshot";
  const needsDeepAssets = target !== "eagle" || isRichMedia || getEagleCaptureMode() === "top-image";
  const [screenshotDataUrl, pageContext] = await Promise.all([
    needsScreenshot
      ? withTimeout(captureVisibleTabSafely(), 4000, "截图超时").catch(() => "")
      : Promise.resolve(""),
    withTimeout(
      collectPageContext(activeTab, { fullContent: needsFullContent, deepAssets: needsDeepAssets }),
      5000,
      "页面扫描超时"
    ).catch(() => emptyPageContext())
  ]);

  return {
    source: "chrome-extension",
    url: activeTab.url,
    title: activeTab.title || activeTab.url,
    selectedText: "",
    userNote: "",
    targets: [target],
    options: {
      eagle: {
        hintFolders: [],
        forceScreenshot: needsScreenshot,
        captureMode: getEagleCaptureMode(),
        folderIds: []
      },
      bear: {
        noScreenshot: false
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

async function collectPageContext(tab, options = {}) {
  if (!tab?.id) return emptyPageContext();

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [{ fullContent: options.fullContent !== false, deepAssets: options.deepAssets === true, carouselTraversalSource: traverseInstagramCarousel.toString() }],
      func: async ({ fullContent, deepAssets, carouselTraversalSource }) => {
        const traverseCarousel = (0, eval)(`(${carouselTraversalSource})`);
        const metaContent = (selector) => document.querySelector(selector)?.content?.trim() || "";
        const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name)?.trim() || "";
        const mainTweetRoot = findMainTweetRoot();
        const article = findReadableRoot(mainTweetRoot);
        const structuredArticle = mainTweetRoot || findArticleRoot();
        const visibleText = getVisibleText(article);
        const images = collectImages(deepAssets, mainTweetRoot).slice(0, deepAssets ? 20 : 6);
        const videos = deepAssets ? collectVideos(mainTweetRoot).slice(0, 10) : [];
        const videoRects = deepAssets ? collectVideoRects(mainTweetRoot).slice(0, 5) : [];
        const carousel = deepAssets ? await collectInstagramCarousel() : [];
        const content = fullContent
          ? {
              text: (visibleText || getVisibleText(document.body)).slice(0, 60000),
              markdown: nodeToMarkdown(article).replace(/\n{3,}/g, "\n\n").trim().slice(0, 80000),
              articleHtml: structuredArticle?.outerHTML?.slice(0, 240000) || "",
              htmlSnapshot: `<!doctype html>\n${document.documentElement.outerHTML}`.slice(0, 240000)
            }
          : { text: "", markdown: "", articleHtml: "", htmlSnapshot: "" };
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
          const candidates = [
            ...document.querySelectorAll("article, main, [role='main'], .article, .post, .entry-content, .markdown-body, .content")
          ].filter(Boolean);
          return candidates
            .map((node) => ({ node, score: readableScore(node) }))
            .sort((a, b) => b.score - a.score)[0]?.node || document.body;
        }

        function findArticleRoot() {
          const preferred = document.querySelector("article")
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

        async function collectInstagramCarousel() {
          if (!/^\/p\//.test(location.pathname) || !/(^|\.)instagram\.com$/.test(location.hostname)) return [];
          const root = document.querySelector('main article') || document.querySelector('article');
          if (!root) return [];
          const initialMedia = [...root.querySelectorAll('video, img')].filter((node) => !node.closest('header, nav, aside')).sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
          const carouselRoot = initialMedia ? [...function* ancestors(node) { for (let current = node.parentElement; current && current !== root; current = current.parentElement) yield current; }(initialMedia)].find((node) => node.querySelector('[role="button"], button')) || initialMedia.parentElement : null;
          if (!carouselRoot) return [];
          const activeMedia = () => [...carouselRoot.querySelectorAll('video, img')].filter((node) => !node.closest('header, nav, aside, [role="dialog"], [role="complementary"]')).map((node) => ({ node, rect: node.getBoundingClientRect() })).filter(({ rect }) => rect.width >= 240 && rect.height >= 240 && rect.bottom > 0 && rect.top < innerHeight).sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0]?.node || null;
          const items = new Map();
          const read = () => {
            const active = activeMedia(); if (!active) return;
            const viewportNode = active.parentElement;
            const viewport = viewportNode.getBoundingClientRect();
            for (const node of [...viewportNode.querySelectorAll('video, img')].filter((item) => {
              if (item.closest('header, nav, aside, [role="dialog"], [role="complementary"]')) return false;
              const rect = item.getBoundingClientRect();
              return rect.width >= 240 && rect.height >= 240 && rect.left >= viewport.left - 2 && rect.right <= viewport.right + 2 && rect.top >= viewport.top - 2 && rect.bottom <= viewport.bottom + 2;
            })) {
              const isVideo = node.tagName === 'VIDEO';
              const src = isVideo ? (node.currentSrc || node.src || [...node.querySelectorAll('source')].map((source) => source.src).find(Boolean) || '') : (pickLargestSrcset(node.getAttribute('srcset') || '') || node.currentSrc || node.src || '');
              const normalized = absolutize(src);
              if (!normalized || normalized.startsWith('data:')) continue;
              const key = `${isVideo ? 'video' : 'image'}:${normalized}`;
              if (!items.has(key)) items.set(key, { index: items.size, type: isVideo ? 'video' : 'image', src: normalized, poster: isVideo ? absolutize(node.poster || '') : '', mediaId: node.getAttribute('data-media-id') || node.getAttribute('data-id') || node.closest('[data-media-id], [data-id]')?.getAttribute('data-media-id') || node.closest('[data-media-id], [data-id]')?.getAttribute('data-id') || normalized.match(/(?:media|video)[_\/-](\d{5,})/i)?.[1] || (() => { try { return new URL(normalized).searchParams.get('id') || ''; } catch (_error) { return ''; } })(), duration: isVideo && Number.isFinite(node.duration) ? node.duration : 0, width: node.videoWidth || node.naturalWidth || node.clientWidth || 0, height: node.videoHeight || node.naturalHeight || node.clientHeight || 0 });
            }
          };
          const signature = () => { const node = activeMedia(); return node?.currentSrc || node?.src || node?.poster || ''; };
          const control = (direction) => {
            const active = activeMedia(); if (!active) return null;
            const viewport = active.parentElement.getBoundingClientRect();
            const buttons = [...carouselRoot.querySelectorAll('[role="button"], button')].filter((button) => { const rect = button.getBoundingClientRect(); return rect.width > 0 && rect.right >= viewport.left && rect.left <= viewport.right && rect.bottom >= viewport.top && rect.top <= viewport.bottom; });
            const words = direction === 'next' ? /next|下一|次へ|다음/i : /previous|prev|上一|前へ|이전/i;
            return buttons.find((button) => words.test(`${button.getAttribute('aria-label') || ''} ${button.querySelector('svg title')?.textContent || ''}`)) || buttons.find((button) => { const rect = button.getBoundingClientRect(); return button.querySelector('svg') && rect.width <= 64 && rect.height <= 64 && (direction === 'next' ? rect.left > viewport.left + viewport.width * .65 : rect.right < viewport.left + viewport.width * .35); });
          };
          const waitForChange = async (before) => { for (let poll = 0; poll < 10; poll += 1) { await new Promise((resolve) => setTimeout(resolve, 60)); if (signature() && signature() !== before) return signature(); } return ''; };
          return traverseCarousel({ read: () => { read(); return [...items.values()]; }, signature, clickPrevious: () => { const button = control('previous'); if (!button) return false; button.click(); return true; }, clickNext: () => { const button = control('next'); if (!button) return false; button.click(); return true; }, waitForChange, maxTransitions: 30 });
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
              const match = String(node.getAttribute("style") || "").match(/url\\((['"]?)(.*?)\\1\\)/);
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
          return /abs\.twimg\.com\/rweb\/ssr\/default\/v\\d+\/og\/image\.png/i.test(String(src || ""));
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
          const directPattern = /https?:\\?\/\\?\/[^"'\\\s<>]+?(?:\.mp4|\.m3u8)(?:\?[^"'\\\s<>]*)?/gi;
          for (const match of text.matchAll(directPattern)) urls.add(match[0]);
          const escapedPattern = /https?:\\\\\/\\\\\/[^"'\\\s<>]+?(?:\.mp4|\.m3u8)(?:\\[^"'\\\s<>]*)?/gi;
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

async function captureVisibleTabSafely() {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(activeTab?.windowId, { format: "png" });
    if (dataUrl) return dataUrl;
  } catch (_error) {
    // Fall through to the background service worker capture path.
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE_TAB" });
    return response?.dataUrl || "";
  } catch (_error) {
    return "";
  }
}

async function pollTask(taskId, target, attempt = 0) {
  if (!taskId) return;
  const pollKey = `${target}:${taskId}`;
  if (pollingTargets.has(pollKey)) return;
  pollingTargets.add(pollKey);
  try {
    await pollTaskLoop(taskId, target, attempt, pollKey);
  } finally {
    pollingTargets.delete(pollKey);
  }
}

async function pollTaskLoop(taskId, target, attempt = 0, pollKey = "") {
  if (attempt > 24) {
    setShellState("error");
    setCardBusy(target, false);
    setCardStatus(target, "超时");
    setCardInlineState(target, "生成超时。请确认本地服务和模型 provider 是否可用，然后重新展开。");
    setCardConfirmState(target);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, attempt < 2 ? 250 : attempt < 6 ? 650 : 1200));

  const task = await getTask(taskId);
  currentTasks[target] = { ...task, target };
  await persistTaskState(target, currentTasks[target]);
  renderTaskForTarget(task, target);
  const targetStatus = task.results?.[target]?.status;
  if (["queued", "running"].includes(targetStatus)) {
    await pollTaskLoop(taskId, target, attempt + 1, pollKey);
  }
}

async function restoreActiveTasks() {
  if (!activeTab?.url) return [];
  const activeTasks = await getStoredActiveTasks();
  const restored = [];
  for (const [target, state] of Object.entries(activeTasks)) {
    if (!CHANNELS[target] || state.url !== activeTab.url || !state.taskId) continue;
    setCardOpen(target, true);
    setCardBusy(target, true);
    setCardStatus(target, "恢复中");
    setCardLoading(target, "正在恢复刚才的生成进度...");
    currentTasks[target] = {
      id: state.taskId,
      target,
      ...(state.task || {})
    };
    restored.push(target);
    pollTask(state.taskId, target).catch((error) => {
      setCardBusy(target, false);
      setCardStatus(target, "失败");
      setCardInlineState(target, `恢复失败：${error.message}`);
      setCardConfirmState(target);
    });
  }
  if (restored.length) setShellState("loading");
  return restored;
}

async function persistTaskState(target, task) {
  if (!target || !task?.id || !activeTab?.url) return;
  const activeTasks = await getStoredActiveTasks();
  activeTasks[target] = {
    target,
    taskId: task.id,
    tabId: activeTab.id || 0,
    url: activeTab.url,
    title: activeTab.title || activeTab.url,
    task,
    updatedAt: Date.now()
  };
  await chrome.storage.session.set({ [SESSION_TASKS_KEY]: activeTasks });
}

async function removeTaskState(target) {
  const activeTasks = await getStoredActiveTasks();
  if (!activeTasks[target]) return;
  delete activeTasks[target];
  await chrome.storage.session.set({ [SESSION_TASKS_KEY]: activeTasks });
}

async function getStoredActiveTasks() {
  const result = await chrome.storage.session.get({ [SESSION_TASKS_KEY]: {} });
  const activeTasks = result[SESSION_TASKS_KEY];
  return activeTasks && typeof activeTasks === "object" && !Array.isArray(activeTasks) ? activeTasks : {};
}

function renderTaskForTarget(task, target) {
  const result = task.results?.[target];
  if (!result) return;
  if (["queued", "running"].includes(result.status)) {
    setCardBusy(target, true);
    setCardHasContent(target, false);
    setCardStatus(target, "生成中");
    setCardLoading(target, "正在读取页面并生成这个渠道的确认内容...");
    setCardConfirmState(target);
    return;
  }
  setCardBusy(target, false);
  if (target === "eagle" || target === "bear") syncCandidatesFromResult(target, result);
  if (target === "eagle" || target === "bear") renderTargetCandidates(target, result);
  setCardPreview(target, result.previewFields || result.preview || result.draft || result.reason || "");
  setCardHasContent(target, Boolean(result.previewFields || result.preview || result.draft));
  setCardStatus(target, formatStatus(result));
  setCardInlineState(target, result.reason || formatStatus(result));
  if (target === "eagle") syncEagleFolderFromResult(result);
  setShellState(result.status === "failed" ? "error" : "ready");
  setCardConfirmState(target);
}

function formatStatus(result) {
  if (result.status === "needs_review") return "待确认";
  if (result.status === "success") return "已写入";
  if (result.status === "exists") return "已写入";
  if (result.status === "failed") return "失败";
  return result.status || "处理中";
}

function clearPreparedState() {
  currentTasks = {};
  for (const target of Object.keys(CHANNELS)) {
    setCardStatus(target, "未生成");
    setCardInlineState(target, "内容已变化，展开后会重新生成预览。");
    setCardPreview(target, []);
    if (target === "eagle" || target === "bear") renderTargetCandidates(target, { status: "idle", candidates: [] });
    setCardConfirmState(target);
  }
  updateConfirmState();
}

function updateConfirmState() {
  for (const target of Object.keys(CHANNELS)) setCardConfirmState(target);
}

async function persistOptions(targets) {
  await chrome.storage.sync.set({
    defaultTargets: targets,
    eagleCaptureMode: getEagleCaptureMode(),
    eagleFolderId: "",
    eagleFolderIds: [],
    bearNoScreenshot: !getBearIncludeScreenshot()
  });
}

function getOpenTargets() {
  return elements.cards.filter((card) => card.classList.contains("is-open")).map((card) => card.dataset.target);
}

function getCard(target) {
  return elements.cards.find((card) => card.dataset.target === target);
}

function setCardPreview(target, message) {
  withScrollPreserved(() => {
    const preview = getCard(target).querySelector('[data-role="preview"]');
    if (Array.isArray(message)) {
      const fields = message.filter((field) => field.kind !== "candidate-list");
      preview.replaceChildren(...fields.map((field) => renderField(field, target)));
      preview.hidden = fields.length === 0;
      return;
    }
    const text = String(message || "").trim();
    preview.hidden = !text;
    preview.textContent = text;
  });
}

function renderField(field, target = "") {
  const row = document.createElement("div");
  row.className = `preview-field preview-field-${field.kind || "text"}`;
  if (target === "eagle" && field.label === "文件夹") {
    row.classList.add("preview-field-folder");
  }

  const label = document.createElement("div");
  label.className = "preview-label";
  label.textContent = field.label;
  row.append(label);

  const value = document.createElement("div");
  value.className = "preview-value";
  if (target === "eagle" && field.label === "文件夹") {
    value.className += " preview-folder-editor";
    value.append(renderEagleFolderEditor());
  } else if (field.kind === "image" && (field.dataUrl || field.src)) {
    const image = document.createElement("img");
    image.className = "preview-image";
    image.alt = field.value || field.label;
    image.src = field.dataUrl || `file://${field.src}`;
    value.append(image);
    const caption = document.createElement("span");
    caption.className = "preview-caption";
    caption.textContent = field.value || "";
    value.append(caption);
  } else if (Array.isArray(field.value)) {
    value.className += " preview-tags";
    for (const item of field.value) {
      const pill = document.createElement("span");
      pill.className = "preview-tag";
      pill.textContent = item;
      value.append(pill);
    }
  } else if (field.kind === "url" && field.value) {
    const link = document.createElement("a");
    link.href = field.value;
    link.textContent = field.value;
    link.target = "_blank";
    value.append(link);
  } else if (field.kind === "video" && field.src) {
    const video = document.createElement("video");
    video.className = "preview-video";
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = buildPreviewAssetUrl(field.src);
    value.append(video);
    const caption = document.createElement("span");
    caption.className = "preview-caption";
    caption.textContent = [field.value, formatBytes(field.size)].filter(Boolean).join(" · ");
    value.append(caption);
  } else if (field.kind === "remote-video" && field.src) {
    const video = document.createElement("video");
    video.className = "preview-video";
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = field.src;
    if (field.poster) video.poster = field.poster;
    value.append(video);
    const caption = document.createElement("span");
    caption.className = "preview-caption";
    caption.textContent = field.value || field.src;
    value.append(caption);
  } else if (field.kind === "candidate-list" && Array.isArray(field.value)) {
    value.className += " candidate-list";
    for (const candidate of field.value) {
      value.append(renderCandidate(candidate));
    }
  } else {
    value.textContent = field.value || "-";
  }
  row.append(value);
  return row;
}

function setCardStatus(target, message) {
  getCard(target).querySelector('[data-role="status"]').textContent = message;
}

function setCardInlineState(target, message) {
  const state = getCard(target).querySelector('[data-role="inline-state"]');
  if (state) state.textContent = message || "";
  if (state) state.classList.remove("is-loading");
}

function setCardLoading(target, message) {
  const state = getCard(target).querySelector('[data-role="inline-state"]');
  if (!state) return;
  state.replaceChildren();
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = message || "正在生成...";
  state.append(spinner, text);
  state.classList.add("is-loading");
}

function setCardBusy(target, busy) {
  getCard(target).classList.toggle("is-busy", Boolean(busy));
}

function setCardHasContent(target, hasContent) {
  getCard(target).classList.toggle("has-content", Boolean(hasContent));
}

function setCardConfirmState(target) {
  const button = getCard(target).querySelector('[data-role="confirm"]');
  if (!button) return;
  const status = currentTasks[target]?.results?.[target]?.status || "";
  const isConfirming = confirmingTargets.has(target);
  const isPreparing = status === "running" || status === "queued";
  const canConfirm = ["needs_review", "success", "exists", "failed"].includes(status);
  button.disabled = isConfirming || isPreparing || !canConfirm;
  button.classList.toggle("is-loading", isPreparing || isConfirming);
  button.setAttribute("aria-busy", String(isPreparing || isConfirming));
  if (isConfirming) {
    button.textContent = "正在收录...";
  } else if (isPreparing) {
    button.textContent = "正在生成...";
  } else if (status === "needs_review") {
    button.textContent = "确认收录";
  } else if (status === "success") {
    button.textContent = "再次收录";
  } else if (status === "exists") {
    button.textContent = "再次收录";
  } else if (status === "failed") {
    button.textContent = "重试收录";
  } else {
    button.textContent = "展开后生成预览";
  }
}

function getEagleCaptureMode() {
  return document.querySelector("#eagleCaptureMode")?.value || "screenshot";
}

function getBearIncludeScreenshot() {
  return document.querySelector("#bearScreenshotToggle")?.checked !== false;
}

function getEagleFolderIds() {
  return selectedEagleFolderIds.filter((id) => eagleFolders.some((folder) => folder.id === id));
}

function getEagleCandidateIds() {
  return getSelectedCandidateIds("eagle");
}

function getBearCandidateIds() {
  return getSelectedCandidateIds("bear");
}

function getSelectedCandidateIds(target) {
  const result = currentTasks[target]?.results?.[target];
  const candidates = getCandidatesFromResult(result);
  const validIds = new Set(candidates.map((candidate) => candidate.id));
  const selectedIds = target === "bear" ? selectedBearCandidateIds : selectedEagleCandidateIds;
  return selectedIds.filter((id) => validIds.has(id));
}

function syncCandidatesFromResult(target, result) {
  const candidates = getCandidatesFromResult(result);
  if (!candidates.length) return;
  const validIds = new Set(candidates.map((candidate) => candidate.id));
  const currentIds = target === "bear" ? selectedBearCandidateIds : selectedEagleCandidateIds;
  const nextIds = currentIds.filter((id) => validIds.has(id));
  if (!nextIds.length) {
    nextIds.push(...candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.id));
  }
  if (target === "bear") {
    selectedBearCandidateIds = nextIds;
  } else {
    selectedEagleCandidateIds = nextIds;
  }
}

function renderTargetCandidates(target, result) {
  const panel = getCard(target).querySelector('[data-role="candidates"]');
  if (!panel) return;
  withScrollPreserved(() => {
    const list = panel.querySelector(".candidate-list");
    const candidates = getCandidatesFromResult(result);
    if (!candidates.length) {
      list.className = "candidate-list candidate-list-empty";
      list.textContent = result.status === "running" || result.status === "queued"
        ? "正在生成可收录素材..."
        : "没有识别到可单独收录的素材。";
      return;
    }
    list.className = "candidate-list";
    list.replaceChildren(...candidates.map((candidate) => renderCandidate(candidate, target)));
  });
}

function getCandidatesFromResult(result) {
  return result?.candidates || result?.previewFields?.find((field) => field.kind === "candidate-list")?.value || [];
}

function syncEagleFolderFromResult(result) {
  if (selectedEagleFolderIds.length) return;
  const folderIds = result.folderIds || result.writePlan?.folders?.map((folder) => folder.id) || [];
  if (folderIds.length) {
    selectedEagleFolderIds = folderIds.filter((id) => eagleFolders.some((folder) => folder.id === id));
    rerenderEaglePreview();
  }
}

function renderEagleFolderEditor() {
  const wrap = el("div", "folder-editor", "");
  wrap.dataset.role = "eagle-folder-editor";
  const selectedFolders = selectedEagleFolderIds
    .map((id) => eagleFolders.find((folder) => folder.id === id))
    .filter(Boolean);

  const tags = el("div", "folder-tags", "");
  for (const folder of selectedFolders) {
    const tag = el("button", "folder-tag", "");
    tag.type = "button";
    tag.title = `移除 ${folder.name}`;
    const removeIcon = el("span", "folder-tag-remove", "");
    removeIcon.setAttribute("aria-hidden", "true");
    tag.append(el("span", "", folder.name), removeIcon);
    tag.addEventListener("click", () => {
      selectedEagleFolderIds = selectedEagleFolderIds.filter((id) => id !== folder.id);
      persistCurrentOptions();
      rerenderEaglePreview();
    });
    tags.append(tag);
  }

  const addButton = el("button", "folder-add", selectedFolders.length ? "添加" : "添加文件夹");
  addButton.type = "button";
  addButton.setAttribute("aria-expanded", String(eagleFolderMenuOpen));
  addButton.addEventListener("click", () => {
    eagleFolderMenuOpen = !eagleFolderMenuOpen;
    if (!eagleFolderMenuOpen) eagleFolderMenuQuery = "";
    rerenderEaglePreview();
  });
  tags.append(addButton);
  wrap.append(tags);

  if (eagleFolderMenuOpen) {
    wrap.append(renderEagleFolderMenu());
    requestAnimationFrame(() => {
      const input = document.querySelector("#eagleFolderMenuSearch");
      if (input) input.focus({ preventScroll: true });
    });
  }

  return wrap;
}

function renderEagleFolderMenu() {
  const menu = el("div", "folder-menu", "");
  const input = document.createElement("input");
  input.id = "eagleFolderMenuSearch";
  input.type = "search";
  input.placeholder = "搜索文件夹";
  input.value = eagleFolderMenuQuery;
  input.addEventListener("input", () => {
    eagleFolderMenuQuery = input.value;
    rerenderEaglePreview();
  });
  menu.append(input);

  const query = eagleFolderMenuQuery.trim().toLowerCase();
  const filtered = eagleFolders
    .filter((folder) => {
      const haystack = `${folder.name} ${folder.label || ""} ${folder.pinyin || ""}`.toLowerCase();
      return !query || haystack.includes(query);
    })
    .slice(0, 60);

  const list = el("div", "folder-menu-list", "");
  if (!filtered.length) {
    list.append(el("div", "folder-empty", "没有匹配的文件夹"));
  } else {
    for (const folder of filtered) {
      const checked = selectedEagleFolderIds.includes(folder.id);
      const button = el("button", `folder-option${checked ? " is-selected" : ""}`, "");
      button.type = "button";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(checked));
      button.style.setProperty("--folder-depth", String(folder.depth || 0));
      button.append(
        el("span", "folder-check", checked ? "✓" : ""),
        el("span", "folder-name", folder.name)
      );
      button.addEventListener("click", () => {
        if (checked) {
          selectedEagleFolderIds = selectedEagleFolderIds.filter((id) => id !== folder.id);
        } else {
          selectedEagleFolderIds = [...selectedEagleFolderIds, folder.id];
        }
        persistCurrentOptions();
        rerenderEaglePreview();
      });
      list.append(button);
    }
  }
  menu.append(list);
  return menu;
}

function rerenderEaglePreview() {
  const fields = currentTasks.eagle?.results?.eagle?.previewFields;
  if (fields) setCardPreview("eagle", fields);
}

function closeEagleFolderMenuOnOutsidePointer(event) {
  if (!eagleFolderMenuOpen) return;
  const editor = event.target?.closest?.('[data-role="eagle-folder-editor"]');
  if (editor) return;
  eagleFolderMenuOpen = false;
  eagleFolderMenuQuery = "";
  rerenderEaglePreview();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function persistCurrentOptions() {
  persistOptions(getOpenTargets()).catch((error) => {
    setStatus(`设置保存失败：${error.message}`);
  });
}

function renderCandidate(candidate, target = "eagle") {
  const selectedIds = target === "bear" ? selectedBearCandidateIds : selectedEagleCandidateIds;
  const checked = selectedIds.includes(candidate.id);
  const label = document.createElement("label");
  label.className = `candidate-option${checked ? " is-selected" : ""}`;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = checked;
  checkbox.addEventListener("change", () => {
    rememberScroll();
    if (checkbox.checked) {
      const nextIds = [...new Set([...selectedIds, candidate.id])];
      if (target === "bear") selectedBearCandidateIds = nextIds;
      else selectedEagleCandidateIds = nextIds;
    } else {
      const nextIds = selectedIds.filter((id) => id !== candidate.id);
      if (target === "bear") selectedBearCandidateIds = nextIds;
      else selectedEagleCandidateIds = nextIds;
    }
    renderTargetCandidates(target, currentTasks[target]?.results?.[target] || {});
    setCardConfirmState(target);
  });

  const body = document.createElement("span");
  body.className = "candidate-body";
  const title = document.createElement("strong");
  title.textContent = candidateTitle(candidate);
  const meta = document.createElement("small");
  meta.textContent = [candidate.filename || candidate.assetUrl || candidate.label, formatBytes(candidate.size)].filter(Boolean).join(" · ");
  body.append(title, meta);

  label.append(checkbox, body);
  label.append(renderCandidatePreview(candidate));
  return label;
}

function renderCandidatePreview(candidate) {
  const wrap = document.createElement("span");
  wrap.className = `candidate-preview candidate-preview-${candidate.kind || "unknown"}`;

  if (candidate.kind === "media-file" && candidate.filePath) {
    const video = document.createElement("video");
    video.className = "candidate-video";
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = buildPreviewAssetUrl(candidate.filePath);
    wrap.append(video);
    return wrap;
  }

  if (candidate.kind === "media-url" && candidate.mediaUrl) {
    if (candidate.thumbnailPath) {
      const image = document.createElement("img");
      image.className = "candidate-image";
      image.alt = `${candidateTitle(candidate)}首帧`;
      image.src = buildPreviewAssetUrl(candidate.thumbnailPath);
      wrap.append(image);
      return wrap;
    }
    const video = document.createElement("video");
    video.className = "candidate-video";
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = candidate.mediaUrl;
    if (candidate.poster) video.poster = candidate.poster;
    wrap.append(video);
    return wrap;
  }

  if (candidate.kind === "twitter-url" || candidate.kind === "twitter-gif") {
    if (candidate.thumbnailPath) {
      const image = document.createElement("img");
      image.className = "candidate-image";
      image.alt = "视频首帧";
      image.src = buildPreviewAssetUrl(candidate.thumbnailPath);
      wrap.append(image);
    } else if (candidate.poster) {
      const image = document.createElement("img");
      image.className = "candidate-image";
      image.alt = candidate.kind === "twitter-gif" ? "X/Twitter GIF 封面" : "X/Twitter 视频封面";
      image.src = candidate.poster;
      image.referrerPolicy = "no-referrer";
      wrap.append(image);
    }
    const text = document.createElement("span");
    text.className = "candidate-preview-text";
    text.textContent = candidate.kind === "twitter-gif"
      ? "确认写入 Bear 时再下载并转换为 GIF。"
      : "确认收录时再下载完整视频，可显著加快预览生成。";
    wrap.append(text);
    return wrap;
  }

  if (candidate.kind === "screenshot" && candidate.filePath) {
    const image = document.createElement("img");
    image.className = "candidate-image";
    image.alt = candidate.filename || "当前截图预览";
    image.src = buildPreviewAssetUrl(candidate.filePath);
    wrap.append(image);
    return wrap;
  }

  if (candidate.kind === "asset-url" && candidate.assetUrl) {
    const image = document.createElement("img");
    image.className = "candidate-image";
    image.alt = "页面首图预览";
    image.src = candidate.assetUrl;
    image.referrerPolicy = "no-referrer";
    wrap.append(image);
    return wrap;
  }

  const icon = document.createElement("span");
  icon.className = "candidate-preview-icon";
  icon.textContent = candidate.kind === "html-snapshot" ? "HTML" : "URL";
  const text = document.createElement("span");
  text.className = "candidate-preview-text";
  text.textContent = candidate.kind === "html-snapshot"
    ? "保存网页离线快照"
    : "保存网页链接和元数据";
  wrap.append(icon, text);
  return wrap;
}

function candidateTitle(candidate) {
  const names = {
    "media-file": "X 视频",
    "twitter-url": "X 视频",
    "twitter-gif": "X 视频转 GIF",
    "media-url": "页面视频",
    screenshot: "当前截图",
    "html-snapshot": "HTML 快照",
    "asset-url": "页面首图",
    url: "URL 书签"
  };
  return names[candidate.kind] || candidate.label || "素材";
}

function setStatus(message) {
  elements.status.textContent = message;
}

function setShellState(state) {
  elements.shell.dataset.state = state;
}

function trackScrollPosition() {
  trackedScroller = getScrollContainer();
  lastScrollTop = getCurrentScrollTop();
  const update = () => {
    if (restoringScroll) return;
    lastScrollTop = getCurrentScrollTop();
  };

  for (const scroller of getScrollableCandidates()) {
    scroller.addEventListener("scroll", update, { passive: true });
  }
  window.addEventListener("scroll", update, { passive: true });

  document.addEventListener("pointerdown", rememberScroll, true);
  document.addEventListener("keydown", rememberScroll, true);
  document.addEventListener("input", rememberScroll, true);
  document.addEventListener("change", rememberScroll, true);
}

function rememberScroll() {
  lastScrollTop = getCurrentScrollTop();
}

function withScrollPreserved(callback) {
  const before = getCurrentScrollTop() || lastScrollTop || 0;
  const result = callback();
  restoreScroll(before);
  return result;
}

function restoreScroll(value = lastScrollTop) {
  const top = Math.max(0, Number(value || 0));
  restoringScroll = true;
  const apply = () => {
    const scroller = getScrollContainer();
    document.body.scrollTop = top;
    document.documentElement.scrollTop = top;
    if (scroller) scroller.scrollTop = top;
    window.scrollTo(0, top);
  };
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(() => {
      apply();
      lastScrollTop = top;
      restoringScroll = false;
    });
  });
}

function getCurrentScrollTop() {
  const scroller = getScrollContainer();
  return scroller?.scrollTop || document.body.scrollTop || document.documentElement.scrollTop || window.scrollY || 0;
}

function getScrollContainer() {
  const candidates = getScrollableCandidates();
  const active = candidates.find((node) => node.scrollTop > 0);
  if (active) {
    trackedScroller = active;
    return active;
  }
  if (trackedScroller && canScroll(trackedScroller)) return trackedScroller;
  const scrollable = candidates.find(canScroll);
  trackedScroller = scrollable || document.scrollingElement || document.documentElement;
  return trackedScroller;
}

function getScrollableCandidates() {
  return [
    document.body,
    document.documentElement,
    document.scrollingElement,
    elements.shell
  ].filter(Boolean);
}

function canScroll(node) {
  return Number(node.scrollHeight || 0) > Number(node.clientHeight || 0) + 1;
}

function buildPreviewAssetUrl(filePath) {
  const token = routerToken || (typeof DEFAULT_ROUTER_TOKEN === "string" ? DEFAULT_ROUTER_TOKEN : "");
  return `http://127.0.0.1:18791/api/assets/preview?path=${encodeURIComponent(toWellFormedText(filePath))}&token=${encodeURIComponent(token)}`;
}

function toWellFormedText(value) {
  const text = String(value || "");
  if (typeof text.toWellFormed === "function") return text.toWellFormed();
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "\uFFFD")
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1\uFFFD");
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
