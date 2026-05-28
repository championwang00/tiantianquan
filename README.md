# Link Router

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
   `~/Library/LaunchAgents/com.link-router.local.plist`, starts the local
   service, and auto-generates the internal router token. Logs are written to
   `~/Library/Logs/LinkRouter`.

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
description, and link; Obsidian follows `types.json` properties plus the clipped body.
Eagle supports
screenshot, top image, URL, and HTML snapshot modes. Bear compresses screenshots
before writing and opens long x-callback URLs through AppleScript to avoid macOS
argument length limits. Obsidian
writes the visible translated page text and image Markdown when the page DOM
contains it.

Tasks are appended as JSONL records under:

```text
~/.local/share/link-router/tasks/YYYY-MM-DD.jsonl
```
