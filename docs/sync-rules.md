# Sync Rules

This file records the project's core synchronization decisions.

## Defaults

- Server listens on `127.0.0.1:18791`.
- Every request from the Chrome extension must include
  `Authorization: Bearer <LOCAL_CLIP_ROUTER_TOKEN>`.
- Tasks are independent per target. One target failure must not block another.
- Multi-item writes are independent per item. Successful items are retained;
  mixed outcomes are `partial_success` and include item-level failure reasons.
- Bear starts as `needs_review` and returns a draft by default.
- Obsidian always writes reviewed Markdown clips into the configured
  `mynote/Clippings` folder, creating it when needed.
- Eagle uses the local Eagle API at `http://localhost:41595` and a
  user-configured Eagle library path.

## Current MVP Behavior

- Chrome extension collects title, URL, page content, screenshots when enabled,
  targets, and target options.
- Eagle and Bear use the same three-column media grid. Users can select all,
  clear the selection, or choose multiple items; confirmation preserves the
  candidate display order. Obsidian intentionally has no media-selection grid.
- Instagram collection attempts to traverse to the first slide and then walk
  forward, deduplicating and preserving all discovered media in carousel order.
  It stops at 30 transitions, a repeated state, or a transition with no change.
  Collection may be incomplete when Instagram's DOM or lazy transition does not
  expose a slide. Images and videos remain distinct candidates.
- Instagram video recovery is exact and fail-closed. After a direct media-URL
  download fails, Eagle may ask `yt-dlp` for the original post only when the
  requested 1-based carousel index matches. For multi-video carousels, media ID
  must also match; captured duration and width/height must match within 1 second
  and 4 pixels respectively. The fallback must return one file. Any mismatch
  fails that selected item rather than importing a nearby or unrelated video.
- Server records all tasks in JSONL.
- Eagle adapter checks API health, switches library when possible, looks for
  duplicate URLs, and uses a media-first import pipeline:
  - X/Twitter: try `yt-dlp` media download first.
  - Web pages: use the current visible screenshot when available.
  - Fallback: save URL metadata.
  It then writes Chinese metadata, auto tags, and mapped folders. This borrows
  the useful shape of the official Eagle extension while removing the manual
  tagging step.
- Bear adapter creates a Markdown draft and returns `needs_review`. Confirmed
  writing uploads the screenshot through Bear `add-file`, removes Bear's
  automatic loose image line, writes the final entry, and verifies both URL and
  image reference through SQLite.
- Obsidian adapter creates a reviewed write plan first. Confirmed writing always
  goes to `mynote/Clippings` and uses the same typed properties as the configured Web Clipper style:
  `title`, `source`, `author`, `published`, `created`, `description`, `tags`.
  The note is a standalone article: frontmatter followed by extracted article
  Markdown, then optional `## 摘录` and `## 备注` sections. Remote article images
  are downloaded to `assets/<note-name>/` next to the note and rewritten as
  relative Markdown paths. Unsupported, unsafe, oversized, timed-out, or failed
  image downloads retain their original remote URL and do not block note write.
- Canonical source URLs remove `utm_*`, `ref`, `fbclid`, and `gclid` query
  parameters. Other query parameters are preserved.
- Target and item failures are recorded rather than hidden. A task can therefore
  be `partial_success` when another target or another selected media item
  succeeds; callers should inspect each target and its item results.

## Intended Next Steps

- Add full-page and selected-area screenshot modes.
- Add deeper official Obsidian Web Clipper template inheritance.
- Add site-specific Eagle extractors for Dribbble, Behance, ArtStation,
  portfolio sites, and design media pages.
