import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildObsidianOpenUrl,
  buildWritePlan,
  confirmObsidianWrite,
  localizeMarkdownImages,
  resolveObsidianRevealVaultPath,
  resolveObsidianConfigPaths
} from "../src/adapters/obsidian.js";

test("buildWritePlan converts article HTML before falling back to captured markdown", () => {
  const payload = {
    url: "https://example.com/posts/one",
    capturedAt: "2026-07-03T00:00:00Z",
    pageMeta: {},
    pageContent: { articleHtml: '<article><h2>Hello</h2><img src="/media/a.png"></article>', markdown: "fallback" }
  };
  const metadata = { canonicalName: "HTML", titleZh: "HTML", author: { values: [] }, summary: "", tags: [] };
  const plan = buildWritePlan(payload, { vaultPath: "/vault", clipFolder: "Clippings" }, metadata);

  assert.match(plan.markdown, /## Hello/);
  assert.match(plan.markdown, /!\[\]\(https:\/\/example\.com\/media\/a\.png\)/);
  assert.doesNotMatch(plan.markdown, /fallback/);
});

test("localizes unique remote markdown images beside the note", async () => {
  const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), "clip-router-obsidian-images-"));
  const noteFilePath = path.join(vaultPath, "Clippings", "Article.md");
  const calls = [];
  const bytes = new Map([
    ["https://cdn.example/a", ["image/png", Buffer.from([1, 2, 3])]],
    ["https://cdn.example/photo_(1).jpg", ["image/jpeg", Buffer.from([4, 5])]]
  ]);
  const fetchImpl = async (url) => {
    calls.push(url);
    const [type, body] = bytes.get(url);
    return new Response(body, { headers: { "content-type": type, "content-length": String(body.length) } });
  };
  const markdown = [
    "![one](https://cdn.example/a)",
    "![duplicate](https://cdn.example/a)",
    "![two](<https://cdn.example/photo_(1).jpg>)"
  ].join("\n");

  const localized = await localizeMarkdownImages({ markdown, noteFilePath, fetchImpl });

  assert.deepEqual(calls, ["https://cdn.example/a", "https://cdn.example/photo_(1).jpg"]);
  assert.equal(localized, [
    "![one](assets/Article/a.png)",
    "![duplicate](assets/Article/a.png)",
    "![two](assets/Article/photo_1.jpg)"
  ].join("\n"));
  assert.deepEqual(await fs.readFile(path.join(vaultPath, "Clippings/assets/Article/a.png")), Buffer.from([1, 2, 3]));
  assert.deepEqual(await fs.readFile(path.join(vaultPath, "Clippings/assets/Article/photo_1.jpg")), Buffer.from([4, 5]));
});

test("leaves a remote image URL unchanged when its download fails", async () => {
  const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), "clip-router-obsidian-images-"));
  const markdown = "![broken](https://cdn.example/broken.png)";
  const localized = await localizeMarkdownImages({
    markdown,
    noteFilePath: path.join(vaultPath, "Article.md"),
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(localized, markdown);
});

test("resolves a configured mynote/Clippings path against the Document vault root", () => {
  const configuredPath = path.join("/Users/me/iCloud/Obsidian/Documents/mynote/Clippings");
  const config = resolveObsidianConfigPaths({
    configuredPath,
    defaultVault: path.join("/Users/me/iCloud/Obsidian/Documents"),
    vaultRoots: [
      path.join("/Users/me/iCloud/Obsidian/Documents")
    ]
  });

  assert.equal(config.vaultPath, path.join("/Users/me/iCloud/Obsidian/Documents"));
  assert.equal(config.clipFolder, path.join("mynote", "Clippings"));
  assert.equal(config.clipPath, configuredPath);
});

test("keeps nested clip folders when the registered vault root is higher", () => {
  const configuredPath = path.join("/Users/me/iCloud/Obsidian/Documents/mynote/Clippings");
  const config = resolveObsidianConfigPaths({
    configuredPath,
    defaultVault: path.join("/Users/me/iCloud/Obsidian/Documents"),
    vaultRoots: [path.join("/Users/me/iCloud/Obsidian/Documents")]
  });

  assert.equal(config.vaultPath, path.join("/Users/me/iCloud/Obsidian/Documents"));
  assert.equal(config.clipFolder, path.join("mynote", "Clippings"));
});

test("builds an Obsidian open URL from the vault name and relative note path", () => {
  const vaultPath = path.join("/Users/me/iCloud/Obsidian/Documents");
  const filePath = path.join(vaultPath, "mynote", "Clippings", "Sample Article.md");

  assert.equal(
    buildObsidianOpenUrl(filePath, vaultPath),
    "obsidian://open?vault=Documents&file=mynote%2FClippings%2FSample%20Article.md"
  );
});

test("prefers the current containing vault over a stale planned vault", () => {
  const currentVaultPath = path.join("/Users/me/iCloud/Obsidian/Documents");
  const staleVaultPath = path.join(currentVaultPath, "mynote");
  const filePath = path.join(staleVaultPath, "Clippings", "Sample Article.md");

  assert.equal(
    resolveObsidianRevealVaultPath(filePath, currentVaultPath, staleVaultPath),
    currentVaultPath
  );
});

test("always writes Obsidian clips into the configured Clippings folder", () => {
  const payload = {
    url: "https://example.com/article",
    capturedAt: "2026-06-15T02:49:00+08:00",
    selectedText: "",
    userNote: "",
    pageMeta: {},
    pageContent: { text: "Body", markdown: "Body" }
  };
  const config = {
    vaultPath: path.join("/Users/me/iCloud/Obsidian/Documents"),
    clipFolder: path.join("mynote", "Clippings")
  };
  const metadata = {
    canonicalName: "Sample Article",
    titleZh: "Sample Article",
    author: { values: ["Example"] },
    published: "",
    summary: "Summary",
    tags: ["网页摘录"]
  };

  for (const requestedMode of ["auto", "journal", "thought", "clip", undefined]) {
    const plan = buildWritePlan(payload, config, metadata, requestedMode);
    assert.equal(plan.mode, "clip");
    assert.equal(plan.filePath, path.join(config.vaultPath, "mynote", "Clippings", "Sample Article.md"));
  }
});

test("confirm creates the Clippings folder when it is missing", async () => {
  const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), "clip-router-obsidian-"));
  const filePath = path.join(vaultPath, "Clippings", "Missing Folder Clip.md");
  const result = await confirmObsidianWrite({
    payload: { url: "https://example.com/missing-folder" },
    results: {
      obsidian: {
        metadata: { tags: [] },
        writePlan: {
          mode: "clip",
          vaultPath,
          reveal: false,
          filePath,
          markdown: [
            "---",
            "title: Missing Folder Clip",
            "source: https://example.com/missing-folder",
            "author:",
            "published:",
            "created:",
            "description:",
            "tags:",
            "---",
            "Body"
          ].join("\n")
        }
      }
    }
  });

  assert.equal(result.status, "success");
  assert.equal(await fs.readFile(filePath, "utf8").then((content) => content.includes("Body")), true);
});

test("confirm is idempotent when the planned file was already written", async () => {
  const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), "clip-router-obsidian-"));
  const filePath = path.join(vaultPath, "Clippings", "Idempotent Clip.md");
  const markdown = [
    "---",
    "title: Idempotent Clip",
    "source: https://example.com/idempotent",
    "author:",
    "published:",
    "created:",
    "description:",
    "tags:",
    "---",
    "Body"
  ].join("\n");
  const task = {
    payload: { url: "https://example.com/idempotent" },
    results: {
      obsidian: {
        metadata: { tags: [] },
        writePlan: {
          mode: "clip",
          vaultPath,
          reveal: false,
          filePath,
          markdown
        }
      }
    }
  };

  const first = await confirmObsidianWrite(task);
  const second = await confirmObsidianWrite(task);
  const files = await fs.readdir(path.dirname(filePath));

  assert.equal(first.status, "success");
  assert.equal(second.status, "success");
  assert.deepEqual(files, ["Idempotent Clip.md"]);
});
