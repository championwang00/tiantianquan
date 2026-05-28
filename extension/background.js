importScripts("config.js", "routerClient.js");

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
