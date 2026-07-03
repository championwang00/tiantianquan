import { parseHTML } from "linkedom";

const BLOCK_TAGS = new Set(["ARTICLE", "MAIN", "SECTION", "DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "BLOCKQUOTE", "PRE"]);

export function articleHtmlToMarkdown(html, baseUrl) {
  const { document } = parseHTML(`<!doctype html><html><body>${html || ""}</body></html>`);
  document.querySelectorAll("script, style, noscript, nav, footer, template, svg").forEach((node) => node.remove());

  const render = (node, context = {}) => {
    if (node.nodeType === 3) {
      if (/^\s*$/.test(node.textContent)) return context.preserveWhitespace ? " " : "";
      return escapeMarkdownText(node.textContent.replace(/\s+/g, " "));
    }
    if (node.nodeType !== 1) return "";
    const tag = node.tagName;
    const children = () => [...node.childNodes].map((child) => render(child, context)).join("");
    const inline = () => cleanInline([...node.childNodes]
      .map((child) => render(child, { ...context, preserveWhitespace: true }))
      .join(""));
    if (/^H[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${inline()}\n\n`;
    if (tag === "P") return `${inline()}\n\n`;
    if (tag === "STRONG" || tag === "B") return `**${inline()}**`;
    if (tag === "EM" || tag === "I") return `*${inline()}*`;
    if (tag === "CODE" && !context.inPre) return inlineCode(node.textContent.replace(/\s+/g, " ").trim());
    if (tag === "A") {
      const label = inline();
      const href = absoluteUrl(node.getAttribute("href"), baseUrl);
      return href ? `[${label || href}](${href})` : label;
    }
    if (tag === "IMG") {
      const src = absoluteUrl(node.getAttribute("src") || node.getAttribute("data-src"), baseUrl);
      return src ? `![${escapeMarkdownText((node.getAttribute("alt") || "").trim())}](${src})\n\n` : "";
    }
    if (tag === "BR") return "\n";
    if (tag === "PRE") {
      const code = node.querySelector("code");
      const language = code?.className?.match(/(?:language-|lang-)([\w-]+)/)?.[1] || "";
      const value = (code || node).textContent.replace(/^\n|\n$/g, "");
      const fence = "`".repeat(Math.max(3, longestBacktickRun(value) + 1));
      return `${fence}${language}\n${value}\n${fence}\n\n`;
    }
    if (tag === "BLOCKQUOTE") {
      const value = [...node.childNodes].map((child) => render(child, context)).join("").trim();
      return `${value.split("\n").map((line) => line ? `> ${line}` : ">").join("\n")}\n\n`;
    }
    if (tag === "UL" || tag === "OL") {
      const ordered = tag === "OL";
      return `${[...node.children].filter((child) => child.tagName === "LI").map((child, index) => {
        const value = [...child.childNodes].map((part) => render(part, { ...context, inList: true })).join("").trim();
        return `${ordered ? `${index + 1}.` : "-"} ${value}`;
      }).join("\n")}\n\n`;
    }
    if (tag === "LI") return inline();
    const value = children();
    return BLOCK_TAGS.has(tag) ? `${value}\n` : value;
  };

  return [...document.body.childNodes]
    .map((node) => render(node))
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractArticleImageUrls(markdown) {
  const urls = [];
  const seen = new Set();
  for (const match of String(markdown || "").matchAll(/!\[[^\]]*\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g)) {
    const url = safeAbsoluteHttpUrl(match[1]);
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function absoluteUrl(value, baseUrl) {
  if (!value) return "";
  try {
    return safeAbsoluteHttpUrl(new URL(value, baseUrl).href);
  } catch {
    return "";
  }
}

function safeAbsoluteHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function escapeMarkdownText(value) {
  return value.replace(/([\\`*_[\]{}<>#])/g, "\\$1");
}

function longestBacktickRun(value) {
  return Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
}

function inlineCode(value) {
  const fence = "`".repeat(longestBacktickRun(value) + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

function cleanInline(value) {
  return value.replace(/[ \t\n]+/g, " ").trim();
}
