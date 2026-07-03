# Chaopi Link Router

Chrome Link Router is a local-first clipping workflow for sending the current
Chrome page to Eagle, Bear, and Obsidian through a single popup.

## Project Layout

```text
extension/   Chrome Manifest V3 extension
server/      Local Node router on 127.0.0.1:18791
docs/        Sync rules and operating notes
```

## Quick Start

1. Install the local service:

   Double-click `install.command`.

   The installer creates a user LaunchAgent at
   `~/Library/LaunchAgents/com.chaopi.link-router.plist`, starts the local
   service, and auto-generates the internal router token. Logs are written to
   `~/Library/Logs/ChaopiLinkRouter`.

   If the popup says it cannot connect to the local clipping service, check:

   ```bash
   curl http://127.0.0.1:18791/health
   ```

2. Load the extension:

   - Open `chrome://extensions`
   - Enable Developer mode
   - Load unpacked
   - Pick the `extension/` folder

3. Open the extension options page and configure:

   - Base URL
   - Model
   - API Key
   - Bear note link / ID

   Router Token is internal and is configured automatically.

## API

```text
POST http://127.0.0.1:18791/api/clip
GET  http://127.0.0.1:18791/api/tasks/:id
GET  http://127.0.0.1:18791/api/eagle/folders
POST http://127.0.0.1:18791/api/tasks/:id/confirm-eagle
POST http://127.0.0.1:18791/api/tasks/:id/confirm-bear
POST http://127.0.0.1:18791/api/tasks/:id/confirm-obsidian
GET  http://127.0.0.1:18791/health
```

The popup now works as an accordion confirmation desk: expanding a channel
automatically generates its preview, and one confirmation writes every expanded
preview. Previews are field-aligned per app: Eagle shows title, description,
link, tags, and a real Eagle folder dropdown; Bear shows title, screenshot,
description, and link; Obsidian writes Markdown into `mynote/Clippings` with
typed properties plus the clipped body.
Eagle supports screenshot, top image, URL, and HTML snapshot modes. Eagle and
Bear previews expose discovered media in a three-column grid with select-all,
clear, and per-item multi-selection; confirmation processes the selected items
in their displayed order. A failed item does not discard successful siblings,
and the result reports `partial_success` with per-item details when applicable.

Instagram collection attempts to traverse back to the first slide and then
forward through the carousel, preserving all discovered media in order. It
stops after 30 transitions, a repeated state, or a transition that makes no
progress; collection can therefore be incomplete if Instagram's DOM or lazy
loading does not expose a slide. Images and videos are shown as separate
selectable items. For an Instagram video, Eagle first tries
the collected media URL. If that fails, its `yt-dlp` fallback is fail-closed: it
must find the same 1-based carousel position and match the captured identity
(required when the carousel has multiple videos), duration (within 1 second),
and dimensions (within 4 pixels), and the download must produce exactly one
file. Otherwise that item fails instead of silently substituting another slide.

Bear compresses screenshots before writing and opens long x-callback URLs
through AppleScript to avoid macOS argument length limits. Obsidian creates a
standalone article note with typed frontmatter, the extracted article body,
optional `## 摘录` and `## 备注` sections, and localized article images. Images
are stored beside the note under `assets/<note-name>/` and Markdown is rewritten
to relative paths. An individual image download failure leaves its remote URL
in place and does not prevent the note from being saved.

Canonical source URLs remove common tracking parameters (`utm_*`, `ref`,
`fbclid`, and `gclid`) before metadata and duplicate handling.

Tasks are appended as JSONL records under:

```text
~/.openclaw/workspace/clip-router/tasks/YYYY-MM-DD.jsonl
```
