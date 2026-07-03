import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const extensionPath = path.resolve(import.meta.dirname, "../../extension");
const popupHtml = fs.readFileSync(path.join(extensionPath, "popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(extensionPath, "popup.js"), "utf8");
const popupCss = fs.readFileSync(path.join(extensionPath, "popup.css"), "utf8");

test("Eagle and Bear expose media selection hosts while Obsidian stays untouched", () => {
  for (const target of ["eagle", "bear"]) {
    const card = popupHtml.match(new RegExp(`<article class="channel-card" data-target="${target}">([\\s\\S]*?)</article>`))?.[1] || "";
    assert.match(card, /data-role="candidates"/);
    assert.doesNotMatch(card, /candidate-list/);
  }
  const obsidian = popupHtml.match(/<article class="channel-card" data-target="obsidian">([\s\S]*?)<\/article>/)?.[1] || "";
  assert.doesNotMatch(obsidian, /data-role="candidates"|candidate-count|select-all|clear-selection/);
});

test("both media channels use one accessible button-card renderer", () => {
  assert.match(popupJs, /renderTargetCandidates\(target, result\)/);
  assert.match(popupJs, /function renderCandidateGrid\(target, candidates/);
  assert.match(popupJs, /renderCandidateGrid\(target, candidates/);
  assert.match(popupJs, /renderMediaGridCard\(candidate, target\)/);
  assert.match(popupJs, /document\.createElement\("button"\)/);
  assert.match(popupJs, /setAttribute\("aria-pressed", String\(checked\)\)/);
  assert.match(popupJs, /setAttribute\("aria-label"/);
  assert.doesNotMatch(popupJs, /function renderCandidate\(/);
});

test("selection controls and confirmation labels reflect candidate counts", () => {
  assert.match(popupJs, /已读取 \$\{candidates\.length\} 项 · 已选 \$\{selectedCount\} 项/);
  assert.match(popupJs, /保存已选 \$\{selectedCount\} 项到 Eagle/);
  assert.match(popupJs, /将 \$\{selectedCount\} 个附件加入 Bear/);
  assert.match(popupJs, /hasCandidates && selectedCount === 0/);
  assert.match(popupJs, /select-all/);
  assert.match(popupJs, /clear-selection/);
});

test("grid visuals are three-column, square, keyboard-visible and motion-safe", () => {
  assert.match(popupCss, /\.candidate-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/s);
  assert.doesNotMatch(popupCss, /\.candidate-panel \.candidate-list/);
  assert.match(popupCss, /\.candidate-option\s*\{[^}]*aspect-ratio:\s*1/s);
  assert.match(popupCss, /\.candidate-option\.is-selected/);
  assert.match(popupCss, /\.candidate-option:focus-visible/);
  assert.match(popupCss, /@media\s*\(hover:\s*hover\)/);
  assert.match(popupCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(popupCss, /transition:\s*all\b/);
});

test("video tiles are opt-in playback with duration and play affordances", () => {
  assert.match(popupJs, /video\.muted = true/);
  assert.match(popupJs, /video\.playsInline = true/);
  assert.match(popupJs, /video\.autoplay = false/);
  assert.match(popupJs, /media-play-badge/);
  assert.match(popupJs, /media-duration-badge/);
  assert.match(popupCss, /\.media-badges\s*\{[^}]*bottom:\s*var\(--space-s1\)/s);
  assert.doesNotMatch(popupCss, /\.media-badges\s*\{[^}]*top:/s);
});
