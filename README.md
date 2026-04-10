# ios-audio-notion-worker

A Cloudflare Worker that proxies multipart audio uploads from an iOS Shortcut into a Notion database, rewriting the audio `Content-Type` so Notion accepts iOS `.m4a` recordings.

## Why this exists

iOS Record Audio tags its output as `audio/x-m4a`. Notion's Direct File Upload API only accepts `audio/mpeg` or `audio/mp4` for M4A payloads, and iOS Shortcuts cannot override the `Content-Type` of a multipart part. This Worker sits between the Shortcut and Notion, receives the multipart body, re-tags the file part as `audio/mp4`, and executes Notion's three-call upload flow so the resulting row has a playable audio attachment.

Use it whenever you want a "tap a Shortcut, speak a note, find it in Notion" habit without building a full native app.

## Request contract

```
POST /
Content-Type: multipart/form-data

audio=@<file>;type=audio/x-m4a   (required, File)
date=<YYYY-MM-DD or any string>  (required, text — used as the row's title)
```

On success (`200`):

```json
{ "ok": true, "page_id": "...", "url": "https://www.notion.so/..." }
```

On failure, the Worker forwards the upstream status code and returns:

```json
{ "ok": false, "error": "<stage>", "detail": "<notion error body>" }
```

## What it does

1. `POST https://api.notion.com/v1/file_uploads` — creates a file upload object with `content_type: audio/mp4`.
2. `POST https://api.notion.com/v1/file_uploads/{id}/send` — sends the audio bytes wrapped in a new `Blob({ type: "audio/mp4" })`.
3. `POST https://api.notion.com/v1/pages` — creates a row with `parent.type = data_source_id` and the file upload reference attached to an `Audio` Files & media property.

Pinned to Notion API version `2026-03-11`. The `data_source_id` parent shape is required at this version; the legacy `database_id` shape will error.

## Target Notion database schema

The Worker assumes a database with these exact property names and types:

| Property | Type | Purpose |
|----------|------|---------|
| `Date` | Title | Populated from the `date` form field |
| `Note` | Rich text | Left empty by the Worker (reserved for later transcription) |
| `Audio` | Files & media | Holds the uploaded `.m4a` |

If you want different property names, fork and edit `src/index.ts` — the mapping is intentionally hardcoded rather than parameterized to keep the Worker small.

## Configuration

Two secrets, set via `wrangler secret put`:

| Secret | Description |
|--------|-------------|
| `NOTION_TOKEN` | Notion internal integration secret with **Insert content** capability on the target database |
| `NOTION_DATA_SOURCE_ID` | Data source UUID for the target database (find it in the Notion URL or via the API) |

```bash
wrangler secret put NOTION_TOKEN
wrangler secret put NOTION_DATA_SOURCE_ID
```

## Local development

```bash
npm install

# Create .dev.vars (gitignored) for `wrangler dev`:
#   NOTION_TOKEN=ntn_...
#   NOTION_DATA_SOURCE_ID=...

npx wrangler dev
```

Smoke test against localhost:

```bash
curl -X POST http://localhost:8787/ \
  -F "audio=@/path/to/recording.m4a;type=audio/x-m4a" \
  -F "date=2026-04-10"
```

## Deploy

```bash
npx wrangler deploy
```

Wrangler prints the deployed URL. Point your iOS Shortcut's **Get Contents of URL** action at it.

## iOS Shortcut outline

A four-action Shortcut is enough:

1. **Current Date**
2. **Format Date** → `yyyy-MM-dd` → variable `Today`
3. **Record Audio** → On Tap, Normal quality
4. **Get Contents of URL** → POST to the deployed Worker URL, Request Body: Form
   - `audio` (File): *Recorded Audio* variable
   - `date` (Text): *Today* variable

No headers, no secrets in the Shortcut itself — the Worker holds the Notion token.

## License

[MIT](LICENSE)
