(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "GET_SELECTION") return false;

    sendResponse({
      selectedText: window.getSelection()?.toString()?.trim() || ""
    });

    return true;
  });
})();
