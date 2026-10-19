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

## Updating on another Mac

After changes have been committed and pushed from the first Mac, double-click
`update.command` on the other Mac. It safely performs a fast-forward Git pull,
keeps that Mac's router token and local settings, updates dependencies only when
needed, restarts the background service, verifies its health, and opens
`chrome://extensions`.

On the Chrome extensions page, click **Reload** on Chaopi Link Router. Chrome
does not provide a safe command-line reload mechanism for private unpacked
extensions, so this is the only manual step.

The updater stops without changing anything when tracked project files contain
uncommitted edits. Commit, stash, or discard those edits before trying again.

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
All three channels wait for translated metadata before presenting a confirmation
preview. Provider failures stop Eagle, Bear, and Obsidian before any placeholder
summary can be written. An insufficient model balance is identified explicitly,
with instructions to recharge or switch models and then reopen the channel.
Lightweight captures include source text, X captures use the
current post's text, and generated descriptions are not truncated to 90 characters.
X captures verify the requested post against the page actually read, exclude
quoted posts and reply media, and ignore older preview requests after a new one
starts. Video previews use the original media's thumbnail, not a crop of the
visible page. X videos remain detectable when yt-dlp returns separate format
metadata without a top-level media URL; the router selects the highest-quality
direct video format while retaining the post and media identity checks. Saving
verifies the post and selected media ID again; ambiguous
or mismatched videos stop with an error instead of substituting another item.
Xiaohongshu video posts are scoped to the current note and use its structured
video URL, cover, and duration. The collector skips recommendation-feed media,
scripts, and icons, and refreshes the signed video URL again when saving so
Eagle receives a real media file with a cover instead of a page asset.
The preview also extracts a local first frame from the verified video, so a
blocked or expired Xiaohongshu cover URL cannot leave the video card blank.
Eagle supports screenshot, top image, URL, and HTML snapshot modes. Eagle and
Bear previews expose discovered media in a three-column grid with select-all,
clear, and per-item multi-selection; confirmation processes the selected items
in their displayed order. A failed item does not discard successful siblings,
and the result reports `partial_success` with per-item details when applicable.

Instagram collection attempts to traverse back to the first slide and then
forward through the carousel, preserving all discovered media in order. It
stops in each traversal direction after at most 30 transitions, a repeated
state, or a transition that makes no progress; restoring the original slide is
separately bounded. Collection can therefore be incomplete if Instagram's DOM
or lazy loading does not expose a slide. Images and videos are shown as separate
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

Turning off Bear's **Include media** switch creates a text-only entry. The
extension keeps discovered images visible and preserves selection, but sends no
candidate IDs when writing text only. Media discovery is independent of this switch.
When media is enabled, select at least one item before saving.

Obsidian image downloads keep local Markdown destinations valid when generated
note and asset folder names contain spaces, so article images render in-place.

Canonical source URLs remove common tracking parameters (`utm_*`, `ref`,
`fbclid`, and `gclid`) before metadata and duplicate handling.

Tasks are appended as JSONL records under:

```text
~/.openclaw/workspace/clip-router/tasks/YYYY-MM-DD.jsonl
```
