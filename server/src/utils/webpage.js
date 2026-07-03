export function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_error) {
    return "unknown";
  }
}

export function normalizeSourceUrl(url) {
  try {
    const normalized = new URL(url);
    for (const key of [...normalized.searchParams.keys()]) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === "ref" || lowerKey.startsWith("utm_") || lowerKey === "fbclid" || lowerKey === "gclid") {
        normalized.searchParams.delete(key);
      }
    }
    return normalized.toString();
  } catch (_error) {
    return url;
  }
}

export function safeFileName(input) {
  const cleaned = toWellFormedText(input || "untitled")
    .replace(/[\\/:*?"<>|#%{}[\]^~`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, 80).join("").trim() || "untitled";
}

function toWellFormedText(value) {
  const text = String(value || "");
  if (typeof text.toWellFormed === "function") return text.toWellFormed();
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "\uFFFD")
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1\uFFFD");
}

export function buildChineseSummary(payload) {
  const host = hostnameFromUrl(payload.url);
  const note = payload.userNote ? `用户备注：${payload.userNote}` : "";
  const selected = payload.selectedText ? `摘录：${payload.selectedText.slice(0, 240)}` : "";
  return [`来自 ${host} 的网页保存。`, note, selected].filter(Boolean).join("\n");
}
