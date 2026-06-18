import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildObsidianOpenUrl,
  buildWritePlan,
  confirmObsidianWrite,
  resolveObsidianRevealVaultPath,
  resolveObsidianConfigPaths
} from "../src/adapters/obsidian.js";

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
