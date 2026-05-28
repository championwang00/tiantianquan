# Sync Rules

This file mirrors the core implementation decisions for this public template.

## Defaults

- Server listens on `127.0.0.1:18791`.
- Every request from the Chrome extension must include
  `Authorization: Bearer <LOCAL_CLIP_ROUTER_TOKEN>`.
- Tasks are independent per target. One target failure must not block another.
- Bear starts as `needs_review` and returns a draft by default.
- Obsidian defaults to `auto`, then resolves to `journal`, `thought`, or `clip`.
- Eagle uses the local Eagle API at `http://localhost:41595`. Library selection
  should be configured locally and should not be committed.

## Current MVP Behavior

- Chrome extension collects title, URL, page content, screenshots when enabled,
  targets, and target options.
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
- Obsidian adapter creates a reviewed write plan first. Confirmed writing uses
  the same typed properties as the configured Web Clipper style:
  `title`, `source`, `author`, `published`, `created`, `description`, `tags`.

## Intended Next Steps

- Add full-page and selected-area screenshot modes.
- Add deeper official Obsidian Web Clipper template inheritance.
- Add site-specific Eagle extractors for Dribbble, Behance, ArtStation,
  portfolio sites, and design media pages.
