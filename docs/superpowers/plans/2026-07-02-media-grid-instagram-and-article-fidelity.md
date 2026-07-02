# Media Grid, Instagram, and Article Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shared Eagle/Bear grid multi-selection, Instagram carousel media extraction, reliable article bodies, local Obsidian images, and tracking-parameter cleanup.

**Architecture:** Keep page discovery in the extension, normalize shared payload data in server utilities, and keep channel-specific persistence inside adapters. Introduce small pure helpers for URL cleanup, article media localization, and Instagram candidate construction so the risky behavior is testable without Chrome, Bear, Eagle, or Obsidian running.

**Tech Stack:** Chrome Extension Manifest V3, browser DOM APIs, Node.js 20 ESM, `node:test`, existing Eagle/Bear/Obsidian adapters, `yt-dlp`, `ffmpeg`.

---

### Task 1: Normalize stored source URLs

**Files:**
- Modify: `server/src/utils/webpage.js`
- Modify: `server/src/router.js`
- Create: `server/test/source-url.test.js`

- [ ] **Step 1: Write failing URL normalization tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSourceUrl } from "../src/utils/webpage.js";

test("removes known tracking parameters", () => {
  assert.equal(normalizeSourceUrl("https://pangrampangram.com/blogs/journal/arrows?ref=sidebar&utm_source=x"), "https://pangrampangram.com/blogs/journal/arrows");
});

test("keeps parameters that can change page content", () => {
  assert.equal(normalizeSourceUrl("https://example.com/search?q=arrows&page=2"), "https://example.com/search?q=arrows&page=2");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd server && node --test test/source-url.test.js`
Expected: FAIL because `normalizeSourceUrl` is not exported.

- [ ] **Step 3: Implement the pure normalizer and apply it to sanitized payloads**

```js
const TRACKING_QUERY_KEYS = new Set(["ref", "fbclid", "gclid"]);

export function normalizeSourceUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_QUERY_KEYS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    return url.toString().replace(/\?$/, "");
  } catch {
    return value;
  }
}
```

In `sanitizePayload`, assign `url: normalizeSourceUrl(payload.url)` while retaining `captureUrl: payload.url` only if later extraction needs the original open-page URL.

- [ ] **Step 4: Run focused and full tests**

Run: `cd server && node --test test/source-url.test.js && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/utils/webpage.js server/src/router.js server/test/source-url.test.js
git commit -m "Normalize tracked source URLs"
```

### Task 2: Extract stable article HTML and media order

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/popup.js`
- Create: `server/src/utils/article.js`
- Create: `server/test/article-content.test.js`

- [ ] **Step 1: Write failing article conversion tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { articleHtmlToMarkdown } from "../src/utils/article.js";

test("keeps headings paragraphs lists links and images in source order", () => {
  const html = '<h2>Arrows</h2><p>Intro <a href="/about">link</a>.</p><img src="/hero.jpg" alt="Hero"><ul><li>One</li></ul>';
  assert.equal(articleHtmlToMarkdown(html, "https://pangrampangram.com/blogs/journal/arrows"), "## Arrows\n\nIntro [link](https://pangrampangram.com/about).\n\n![Hero](https://pangrampangram.com/hero.jpg)\n\n- One");
});
```

- [ ] **Step 2: Run and verify RED**

Run: `cd server && node --test test/article-content.test.js`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add focused article helpers**

Implement `articleHtmlToMarkdown(html, baseUrl)` and `extractArticleImageUrls(markdown)` in `server/src/utils/article.js`. Support headings, paragraphs, emphasis, links, lists, blockquotes, fenced code, and images; resolve relative URLs against `baseUrl`; drop scripts, navigation, footer, and empty wrappers.

In both extension capture paths, select the best root in order: `article`, `[role=main] article`, `main`, then the largest text-rich content container. Add `pageContent.articleHtml` from that root and keep the existing `text`, `markdown`, and `htmlSnapshot` fields as fallbacks.

- [ ] **Step 4: Verify GREEN and syntax**

Run: `cd server && node --test test/article-content.test.js && node --check ../extension/background.js && node --check ../extension/popup.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/background.js extension/popup.js server/src/utils/article.js server/test/article-content.test.js
git commit -m "Capture structured article content"
```

### Task 3: Localize Obsidian article images

**Files:**
- Modify: `server/src/adapters/obsidian.js`
- Modify: `server/test/obsidian-config.test.js`

- [ ] **Step 1: Write failing localization tests**

Add a test that creates a temporary vault, supplies Markdown containing two image URLs, injects a downloader returning deterministic bytes, and asserts files are placed under `Clippings/assets/<note-slug>/` and the note uses relative Markdown paths. Add a second test where one download throws and assert that URL remains remote.

- [ ] **Step 2: Run and verify RED**

Run: `cd server && node --test test/obsidian-config.test.js`
Expected: FAIL because confirmation does not localize images.

- [ ] **Step 3: Implement localization at confirmation time**

Export `localizeMarkdownImages({ markdown, noteFilePath, fetchImpl })`. For each unique HTTP image, download with a bounded timeout, infer a safe extension from content type or URL, write to `<note-dir>/assets/<note-base>/`, and replace the URL with a POSIX relative path. On failure, leave the original URL. Call it before the final note write so preview remains side-effect free.

- [ ] **Step 4: Use structured article Markdown in write plans**

When `pageContent.articleHtml` is non-empty, convert it with `articleHtmlToMarkdown`; otherwise preserve the existing preferred-text fallback. Ensure frontmatter `source` uses the normalized payload URL.

- [ ] **Step 5: Verify and commit**

Run: `cd server && node --test test/obsidian-config.test.js test/article-content.test.js && npm run check`
Expected: PASS.

```bash
git add server/src/adapters/obsidian.js server/test/obsidian-config.test.js
git commit -m "Localize Obsidian article images"
```

### Task 4: Fix Bear article body and multi-attachment semantics

**Files:**
- Modify: `server/src/adapters/bear.js`
- Create: `server/test/bear-content.test.js`

- [ ] **Step 1: Write failing Bear tests**

Test that a Pangram-shaped payload with `articleHtml` produces a draft containing body text, not only the title. Test that two selected candidate IDs result in one note plan whose attachment list preserves candidate order. Test partial attachment failure returns one created note plus per-item results.

- [ ] **Step 2: Run and verify RED**

Run: `cd server && node --test test/bear-content.test.js`
Expected: FAIL on the missing body and multi-attachment behavior.

- [ ] **Step 3: Implement a single Bear write plan**

Build the draft from structured article Markdown first, then description, then summary. Replace any first-selected-candidate shortcut with ordered `selectedCandidates`; materialize all selected attachments before one Bear create/update call. Return `{ succeeded, failed, items }` without aborting after one attachment failure.

- [ ] **Step 4: Verify and commit**

Run: `cd server && node --test test/bear-content.test.js && npm run check`
Expected: PASS.

```bash
git add server/src/adapters/bear.js server/test/bear-content.test.js
git commit -m "Support Bear article bodies and multiple attachments"
```

### Task 5: Discover complete Instagram carousel media

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/popup.js`
- Modify: `server/src/adapters/eagle.js`
- Modify: `server/test/eagle-candidates.test.js`

- [ ] **Step 1: Write failing Instagram candidate tests**

Add a payload with ordered Instagram `pageAssets.carousel` entries containing image, video, duplicate video, and second image. Assert `buildImportCandidates` returns three Instagram media candidates in original order, with stable IDs and mixed `asset-url` / `media-url` kinds.

- [ ] **Step 2: Run and verify RED**

Run: `cd server && node --test test/eagle-candidates.test.js`
Expected: FAIL because Instagram is detected as a generic webpage and carousel data is ignored.

- [ ] **Step 3: Capture the main-post carousel**

In both extension capture copies, detect `instagram.com/p/` and locate the primary post article. Traverse its carousel with the next button until the first slide repeats or no next button exists. For every slide collect `{ index, type, src, poster, duration, width, height }`; exclude avatar, comments, recommendations, and navigation imagery. Restore the initial slide when traversal ends.

- [ ] **Step 4: Build Eagle candidates and fallback metadata**

Add `instagram` to `detectSourceType`. Convert carousel entries to ordered candidates and include `carouselIndex` plus the canonical post URL. Direct URLs are primary; video download fallback calls `yt-dlp` with the post URL and selects the entry matching `carouselIndex`. Never substitute a different carousel item.

- [ ] **Step 5: Verify and commit**

Run: `cd server && node --test test/eagle-candidates.test.js && node --check ../extension/background.js && node --check ../extension/popup.js && npm run check`
Expected: PASS.

```bash
git add extension/background.js extension/popup.js server/src/adapters/eagle.js server/test/eagle-candidates.test.js
git commit -m "Extract Instagram carousel media for Eagle"
```

### Task 6: Make Eagle confirmation truly multi-item

**Files:**
- Modify: `server/src/adapters/eagle.js`
- Modify: `server/test/eagle-candidates.test.js`

- [ ] **Step 1: Write failing multi-import tests**

Test three selected candidates where the second importer throws. Assert the importer receives all three in order and the result reports two successes and one failure. Also test legacy single `candidateId` normalization to a one-element ID array.

- [ ] **Step 2: Run and verify RED**

Run: `cd server && node --test test/eagle-candidates.test.js`
Expected: FAIL because confirmation currently resolves one effective import plan.

- [ ] **Step 3: Implement isolated imports**

Resolve selected IDs only against the preview plan, loop in candidate order, run the existing fallback per candidate, and collect item results. Keep existing folder assignment and annotations for every successfully imported Eagle item. Return summary counts without changing old single-item callers.

- [ ] **Step 4: Verify and commit**

Run: `cd server && node --test test/eagle-candidates.test.js && npm run check`
Expected: PASS.

```bash
git add server/src/adapters/eagle.js server/test/eagle-candidates.test.js
git commit -m "Import multiple selected Eagle assets"
```

### Task 7: Replace Eagle and Bear candidate rows with one grid component

**Files:**
- Modify: `extension/popup.js`
- Modify: `extension/popup.css`
- Modify: `extension/popup.html`
- Create: `server/test/popup-media-grid.test.js`

- [ ] **Step 1: Write a failing static contract test**

Read `popup.js` and `popup.css` and assert the shared renderer emits `candidate-grid`, selection buttons expose `aria-pressed`, bulk actions exist, CSS defines three equal columns, and no Obsidian selector is wired to the grid.

- [ ] **Step 2: Run and verify RED**

Run: `cd server && node --test test/popup-media-grid.test.js`
Expected: FAIL because candidates use the row-style `candidate-list`.

- [ ] **Step 3: Implement the shared grid**

Replace Eagle/Bear candidate row rendering with one `renderCandidateGrid(target, candidates)` function. Add count text, select-all, clear, three-column thumbnail cards, visible selected border/check, video badge/duration, keyboard activation, and `aria-pressed`. Keep selection arrays isolated per target and leave Obsidian rendering untouched.

- [ ] **Step 4: Update confirmation copy**

Show `保存已选 N 项到 Eagle` for Eagle and `将 N 个附件加入 Bear` for Bear. Disable confirmation when candidates exist but none are selected.

- [ ] **Step 5: Verify and commit**

Run: `cd server && node --test test/popup-media-grid.test.js && node --check ../extension/popup.js`
Expected: PASS.

```bash
git add extension/popup.js extension/popup.css extension/popup.html server/test/popup-media-grid.test.js
git commit -m "Add shared media selection grid"
```

### Task 8: End-to-end regression and real-page verification

**Files:**
- Modify: `README.md`
- Modify: `docs/sync-rules.md`

- [ ] **Step 1: Run all automated checks**

Run: `cd server && node --test test/*.test.js && npm run check`
Expected: all tests and syntax checks PASS with no warnings.

- [ ] **Step 2: Reload the unpacked extension and verify Instagram**

Open the supplied Instagram post, start capture, and verify the Eagle panel shows every main-carousel image/video exactly once in order. Select a mixed subset, confirm, and verify Eagle receives one item per selection with correct media types.

- [ ] **Step 3: Verify Bear on the Pangram article**

Open `https://pangrampangram.com/blogs/journal/arrows?ref=sidebar`, capture to Bear, select at least two media items, and verify one note contains body text, the selected attachments, and source `https://pangrampangram.com/blogs/journal/arrows`.

- [ ] **Step 4: Verify Obsidian article fidelity**

Capture the Pangram article to Obsidian and verify headings, paragraphs, links, lists, and images remain in source order; image files exist below the note's asset folder; the Markdown uses relative paths; and the source URL has no `ref=sidebar`.

- [ ] **Step 5: Document and commit**

Document the two-channel grid behavior, Instagram support, Obsidian local assets, URL cleanup rules, and partial-failure behavior.

```bash
git add README.md docs/sync-rules.md
git commit -m "Document media collection improvements"
```
