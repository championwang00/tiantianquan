export function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_error) {
    return "unknown";
  }
}

export function safeFileName(input) {
  return String(input || "untitled")
    .replace(/[\\/:*?"<>|#%{}[\]^~`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
}

export function buildChineseSummary(payload) {
  const host = hostnameFromUrl(payload.url);
  const note = payload.userNote ? `用户备注：${payload.userNote}` : "";
  const selected = payload.selectedText ? `摘录：${payload.selectedText.slice(0, 240)}` : "";
  return [`来自 ${host} 的网页保存。`, note, selected].filter(Boolean).join("\n");
}
