let activeTab = null;
let currentTasks = {};
let eagleFolders = [];
let selectedEagleFolderIds = [];
let selectedEagleCandidateIds = [];
let routerToken = "";
const confirmingTargets = new Set();
const successResetTimers = new Map();
let eagleFolderMenuOpen = false;
let eagleFolderMenuQuery = "";

const CHANNELS = {
  eagle: { label: "Eagle", confirm: (taskId) => confirmEagle(taskId, getEagleFolderIds(), getEagleCandidateIds()) },
  bear: { label: "Bear", confirm: (taskId, task) => confirmBear(taskId, task.results?.bear?.draft, getBearIncludeScreenshot()) },
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
  updateConfirmState();

  for (const card of elements.cards) {
    card.querySelector(".channel-summary").addEventListener("click", () => toggleCard(card.dataset.target));
    card.querySelector('[data-role="confirm"]').addEventListener("click", () => confirmChannel(card.dataset.target));
  }
  document.querySelector("#eagleCaptureMode").addEventListener("change", () => refreshIfOpen("eagle"));
  document.querySelector("#bearScreenshotToggle").addEventListener("change", persistCurrentOptions);
  document.querySelector("#obsidianMode").addEventListener("change", () => refreshIfOpen("obsidian"));
  await prepareOpenTargets().catch((error) => {
    setShellState("error");
    setStatus(`生成预览失败：${error.message}`);
  });
}

function bindStaticActions() {
  document.querySelector("#settingsButton")?.addEventListener("click", openSettings);
  document.querySelector("#footerSettingsButton")?.addEventListener("click", openSettings);
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
  document.querySelector("#obsidianMode").value = config.obsidianMode || "auto";
  await hydrateEagleFolders([]);
}

async function hydrateEagleFolders(savedFolderIds = []) {
  try {
    const response = await getEagleFolders();
    eagleFolders = response.folders || [];
    if (!eagleFolders.length) throw new Error("Eagle 未返回文件夹");
    selectedEagleFolderIds = savedFolderIds.filter((id) => eagleFolders.some((folder) => folder.id === id));
    renderEagleFolderPicker();
  } catch (error) {
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
  const card = getCard(target);
  card.classList.toggle("is-open", open);
  card.querySelector(".channel-summary").setAttribute("aria-expanded", String(open));
}

async function prepareOpenTargets() {
  const targets = getOpenTargets();
  if (!targets.length || !activeTab?.url) return;

  setShellState("loading");
  setStatus("正在生成展开项预览...");

  try {
    await persistOptions(targets);
    for (const target of targets) {
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
  setCardLoading(target, "正在读取页面并生成这个渠道的确认内容...");
  setCardPreview(target, []);
  setCardConfirmState(target);
  try {
    await persistOptions(getOpenTargets());
    const payload = await buildPayload(target);
    const result = await sendClip(payload);
    currentTasks[target] = { id: result.taskId, target };
    await pollTask(result.taskId, target);
  } finally {
    updateConfirmState();
  }
}

function refreshIfOpen(target) {
  if (!getCard(target).classList.contains("is-open")) return;
  delete currentTasks[target];
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
  if (!["needs_review", "success", "exists"].includes(targetStatus)) return;
  clearSuccessReset(target);

  confirmingTargets.add(target);
  try {
    setShellState("loading");
    setCardStatus(target, "写入中");
    setCardLoading(target, `正在写入 ${CHANNELS[target].label}...`);
    setCardConfirmState(target);
    const task = await CHANNELS[target].confirm(taskState.id, taskState);
    currentTasks[target] = { ...task, target };
    renderTaskForTarget(task, target);
    scheduleSuccessReset(target);
    setStatus(`${CHANNELS[target].label} 写入完成。对应软件已尝试唤起。`);
  } catch (error) {
    setShellState("error");
    setCardStatus(target, "失败");
    setCardInlineState(target, `${CHANNELS[target].label} 写入失败：${error.message}`);
    setCardConfirmState(target);
  } finally {
    confirmingTargets.delete(target);
    setCardConfirmState(target);
  }
  updateConfirmState();
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

async function buildPayload(target) {
  const needsScreenshot = (target === "eagle" && getEagleCaptureMode() === "screenshot") || target === "bear";
  const [screenshotDataUrl, pageContext] = await Promise.all([
    needsScreenshot ? captureVisibleTabSafely() : Promise.resolve(""),
    collectPageContext(activeTab)
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
        mode: getObsidianMode(),
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

async function collectPageContext(tab) {
  if (!tab?.id) return emptyPageContext();

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const metaContent = (selector) => document.querySelector(selector)?.content?.trim() || "";
        const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name)?.trim() || "";
        const article = findReadableRoot();
        const text = (article?.innerText || document.body.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 60000);
        const markdown = nodeToMarkdown(article).replace(/\n{3,}/g, "\n\n").trim().slice(0, 80000);
        const htmlSnapshot = `<!doctype html>\n${document.documentElement.outerHTML}`.slice(0, 240000);
        const images = collectImages().slice(0, 20);
        return {
          meta: {
            description: metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]'),
            author: metaContent('meta[name="author"]') || metaContent('meta[property="article:author"]'),
            siteName: metaContent('meta[property="og:site_name"]'),
            image: metaContent('meta[property="og:image"]') || metaContent('meta[name="twitter:image"]'),
            canonical: attr('link[rel="canonical"]', "href"),
            published: metaContent('meta[property="article:published_time"]') || metaContent('meta[name="article:published_time"]')
          },
          assets: { images },
          content: { text, markdown, htmlSnapshot }
        };

        function findReadableRoot() {
          const candidates = [
            ...document.querySelectorAll("article, main, [role='main'], .article, .post, .entry-content, .markdown-body, .content")
          ].filter(Boolean);
          return candidates
            .map((node) => ({ node, score: readableScore(node) }))
            .sort((a, b) => b.score - a.score)[0]?.node || document.body;
        }

        function readableScore(node) {
          const textLength = (node.innerText || "").trim().length;
          const paragraphCount = node.querySelectorAll("p, li, blockquote, pre, h1, h2, h3").length;
          const imageCount = node.querySelectorAll("img").length;
          return textLength + paragraphCount * 180 + imageCount * 80;
        }

        function collectImages() {
          const seen = new Set();
          const items = [];
          const push = (src, alt = "", width = 0, height = 0) => {
            const normalized = absolutize(src);
            if (!normalized || seen.has(normalized)) return;
            if (normalized.startsWith("data:") || normalized.startsWith("blob:")) return;
            seen.add(normalized);
            items.push({ src: normalized, alt, width, height });
          };

          for (const image of [...document.images]) {
            const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || "";
            const fromSrcset = pickLargestSrcset(srcset);
            push(
              fromSrcset || image.currentSrc || image.getAttribute("data-src") || image.getAttribute("data-original") || image.src,
              image.alt || "",
              image.naturalWidth || image.width || 0,
              image.naturalHeight || image.height || 0
            );
          }

          for (const node of [...document.querySelectorAll("[style]")]) {
            const match = String(node.getAttribute("style") || "").match(/url\\((['"]?)(.*?)\\1\\)/);
            if (match?.[2]) push(match[2], node.getAttribute("aria-label") || "", node.clientWidth || 0, node.clientHeight || 0);
          }

          return items
            .filter((image) => image.width >= 180 || image.height >= 180 || /xiaohongshu|xhscdn|sns-webpic|sns-img/i.test(image.src))
            .sort((a, b) => (b.width * b.height) - (a.width * a.height));
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
  return { meta: {}, assets: { images: [] }, content: { text: "", markdown: "", htmlSnapshot: "" } };
}

async function captureVisibleTabSafely() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE_TAB" });
    return response?.dataUrl || "";
  } catch (_error) {
    return "";
  }
}

async function pollTask(taskId, target, attempt = 0) {
  if (!taskId) return;
  if (attempt > 24) {
    setShellState("error");
    setCardBusy(target, false);
    setCardStatus(target, "超时");
    setCardInlineState(target, "生成超时。请确认本地服务和模型 provider 是否可用，然后重新展开。");
    setCardConfirmState(target);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, attempt < 4 ? 900 : 1500));

  const task = await getTask(taskId);
  currentTasks[target] = { ...task, target };
  renderTaskForTarget(task, target);
  const targetStatus = task.results?.[target]?.status;
  if (["queued", "running"].includes(targetStatus)) {
    await pollTask(taskId, target, attempt + 1);
  }
}

function renderTaskForTarget(task, target) {
  const result = task.results?.[target];
  if (!result) return;
  if (["queued", "running"].includes(result.status)) {
    setCardBusy(target, true);
    setCardStatus(target, "生成中");
    setCardLoading(target, "正在读取页面并生成这个渠道的确认内容...");
    setCardConfirmState(target);
    return;
  }
  setCardBusy(target, false);
  if (target === "eagle") syncEagleCandidatesFromResult(result);
  if (target === "eagle") renderEagleCandidates(result);
  setCardPreview(target, result.previewFields || result.preview || result.draft || result.reason || "");
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
    if (target === "eagle") renderEagleCandidates({ status: "idle", candidates: [] });
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
    bearNoScreenshot: !getBearIncludeScreenshot(),
    obsidianMode: getObsidianMode()
  });
}

function getOpenTargets() {
  return elements.cards.filter((card) => card.classList.contains("is-open")).map((card) => card.dataset.target);
}

function getCard(target) {
  return elements.cards.find((card) => card.dataset.target === target);
}

function setCardPreview(target, message) {
  const preview = getCard(target).querySelector('[data-role="preview"]');
  if (Array.isArray(message)) {
    preview.replaceChildren(...message.filter((field) => field.kind !== "candidate-list").map((field) => renderField(field, target)));
    return;
  }
  preview.textContent = message || "没有可展示的预览。";
}

function renderField(field, target = "") {
  const row = document.createElement("div");
  row.className = `preview-field preview-field-${field.kind || "text"}`;

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

function setCardConfirmState(target) {
  const button = getCard(target).querySelector('[data-role="confirm"]');
  if (!button) return;
  const status = currentTasks[target]?.results?.[target]?.status || "";
  const isConfirming = confirmingTargets.has(target);
  const isPreparing = status === "running" || status === "queued";
  button.disabled = isConfirming || !["needs_review", "success", "exists"].includes(status);
  button.classList.toggle("is-loading", isPreparing || isConfirming);
  button.setAttribute("aria-busy", String(isPreparing || isConfirming));
  if (isConfirming) {
    button.textContent = "正在收录...";
  } else if (isPreparing) {
    button.textContent = "正在生成...";
  } else if (status === "needs_review") {
    button.textContent = "确认收录";
  } else if (status === "success") {
    button.textContent = "已收录";
  } else if (status === "exists") {
    button.textContent = "已收录";
  } else if (status === "failed") {
    button.textContent = "写入失败";
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
  const result = currentTasks.eagle?.results?.eagle;
  const candidates = result?.candidates || result?.previewFields?.find((field) => field.kind === "candidate-list")?.value || [];
  const validIds = new Set(candidates.map((candidate) => candidate.id));
  return selectedEagleCandidateIds.filter((id) => validIds.has(id));
}

function syncEagleCandidatesFromResult(result) {
  const candidates = result.candidates || result.previewFields?.find((field) => field.kind === "candidate-list")?.value || [];
  if (!candidates.length) return;
  const validIds = new Set(candidates.map((candidate) => candidate.id));
  selectedEagleCandidateIds = selectedEagleCandidateIds.filter((id) => validIds.has(id));
  if (!selectedEagleCandidateIds.length) {
    selectedEagleCandidateIds = candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.id);
  }
}

function renderEagleCandidates(result) {
  const panel = getCard("eagle").querySelector('[data-role="candidates"]');
  if (!panel) return;
  const list = panel.querySelector(".candidate-list");
  const candidates = result.candidates || result.previewFields?.find((field) => field.kind === "candidate-list")?.value || [];
  if (!candidates.length) {
    list.className = "candidate-list candidate-list-empty";
    list.textContent = result.status === "running" || result.status === "queued"
      ? "正在生成可收录素材..."
      : "没有识别到可单独收录的素材。";
    return;
  }
  list.className = "candidate-list";
  list.replaceChildren(...candidates.map(renderCandidate));
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
  const selectedFolders = selectedEagleFolderIds
    .map((id) => eagleFolders.find((folder) => folder.id === id))
    .filter(Boolean);

  const tags = el("div", "folder-tags", "");
  for (const folder of selectedFolders) {
    const tag = el("button", "folder-tag", "");
    tag.type = "button";
    tag.title = `移除 ${folder.name}`;
    tag.append(el("span", "", folder.name), el("span", "folder-tag-remove", "×"));
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
      if (input) input.focus();
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
        eagleFolderMenuOpen = false;
        eagleFolderMenuQuery = "";
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

function renderCandidate(candidate) {
  const checked = selectedEagleCandidateIds.includes(candidate.id);
  const label = document.createElement("label");
  label.className = `candidate-option${checked ? " is-selected" : ""}`;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = checked;
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      selectedEagleCandidateIds = [...new Set([...selectedEagleCandidateIds, candidate.id])];
    } else {
      selectedEagleCandidateIds = selectedEagleCandidateIds.filter((id) => id !== candidate.id);
    }
    renderEagleCandidates(currentTasks.eagle?.results?.eagle || {});
    setCardConfirmState("eagle");
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
    screenshot: "当前截图",
    "html-snapshot": "HTML 快照",
    "asset-url": "页面首图",
    url: "URL 书签"
  };
  return names[candidate.kind] || candidate.label || "素材";
}

function getObsidianMode() {
  return document.querySelector("#obsidianMode")?.value || "auto";
}

function setStatus(message) {
  elements.status.textContent = message;
}

function setShellState(state) {
  elements.shell.dataset.state = state;
}

function buildPreviewAssetUrl(filePath) {
  const token = routerToken || (typeof DEFAULT_ROUTER_TOKEN === "string" ? DEFAULT_ROUTER_TOKEN : "");
  return `http://127.0.0.1:18791/api/assets/preview?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token)}`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
