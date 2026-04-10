# Home Log — Build Plan

Daily one-sentence capture of home/family life with audio. Writes to the **Home Log** Notion database under the Family page. Triggered by an iOS Shortcut with a daily iOS Reminders nudge.

**Status as of 2026-04-10:** Worker deployed, iOS Shortcut wiring pending. Cloudflare Worker is live at `https://ios-audio-notion-worker.samjdacanay.workers.dev` and verified end-to-end against the real Notion API (smoke test 2026-04-10: row created and deleted successfully). Remaining work is on the phone — rebuilding the Shortcut to call the Worker instead of the raw Notion API, then enabling the daily Reminder.

## Why this setup

Cowork scheduled tasks can't prompt for human input — they run autonomously on a cron. So the "daily home-log question" can't live in the `end-of-day` scheduled task. Instead, the write happens via an iOS Shortcut that Sam triggers from a daily Reminder, records audio, and POSTs to a Cloudflare Worker that proxies the upload into Notion.

Design choices made:
- **Notion, not OB1** — home log is family/personal context, separate from work-coupled OB1
- **iOS Shortcut, not auto-capture** — keeps the write manual and intentional
- **Cloudflare Worker proxy, not direct iOS → Notion** — the proxy is the whole point of this architecture (see "Why a Worker" below). It also keeps the Notion integration token out of the Shortcut.
- **Reminders, not Shortcuts Automation** — persistent, snoozable notification vs. auto-fire

## Architecture

```
┌─────────────────┐      POST /          ┌──────────────────────┐     Notion API      ┌──────────┐
│  iOS Shortcut   │ ──── multipart ────> │  Cloudflare Worker   │ ─── 3 calls ──────> │  Notion  │
│ (audio + date)  │                      │ ios-audio-notion-... │                     │ Home Log │
└─────────────────┘                      └──────────────────────┘                     └──────────┘
```

1. iOS Shortcut captures audio via **Record Audio** and formats today's date.
2. Shortcut POSTs a multipart form with fields `audio` (the `.m4a`, tagged `audio/x-m4a` by iOS) and `date` (text) to the deployed Worker URL.
3. Worker re-tags the audio part as `audio/mp4` (wraps the bytes in a new `Blob({ type: "audio/mp4" })`) and runs Notion's three-call Direct File Upload flow:
   1. `POST /v1/file_uploads` — create file upload object with `content_type: audio/mp4`
   2. `POST /v1/file_uploads/{id}/send` — send audio bytes as multipart with the rewritten `Content-Type`
   3. `POST /v1/pages` — create a row in the Home Log database with `parent.type = data_source_id` and the file upload attached to the `Audio` property
4. Worker returns `{ok: true, page_id, url}` on success.

### Why a Worker (and not the previous iCloud Drive + Mail Drop approach)

The earlier plan used iCloud Drive + Mail Drop + **Get Link to File** + a Notion `URL` property. That failed in iOS testing on 2026-04-10:

- **Get Link to File** on a local iCloud file returns a `file://` path, not an `https://` iCloud share link — Shortcuts can't generate public iCloud links from a saved file programmatically
- Mail Drop required a manual share step that defeated the point of a tap-and-forget Shortcut
- The alternative — calling Notion's Direct File Upload API directly from the Shortcut — fails because iOS Record Audio tags the file as `audio/x-m4a`, which is NOT in Notion's allowlist, and iOS Shortcuts cannot override the `Content-Type` of a multipart part

A tiny Cloudflare Worker fixes both problems at once: it receives the Shortcut's multipart body, rebuilds the file part with `Content-Type: audio/mp4`, and runs the three Notion API calls on the server side. The Shortcut shrinks to ~4 actions and never sees the Notion token.

### Gotcha: Notion 2026-03-11 parent shape

`parent: { "database_id": "..." }` — the shape documented all over the internet — **returns an error on Notion API version 2026-03-11**. The current shape is:

```json
"parent": { "type": "data_source_id", "data_source_id": "<uuid>" }
```

You get the `data_source_id` by calling `GET /v1/databases/{database_id}` and reading `data_sources[0].id`. This is distinct from the database id.

For Home Log:
- **Database ID:** `03f684ffe7b54efbad468fbf287d26fb`
- **Data Source ID:** `74587956-a0ef-4030-a8f2-8aba863c3cf0`

Pin the Worker to `Notion-Version: 2026-03-11`. Do not downgrade to an older API version — older versions still accept the legacy `database_id` shape but don't support the Direct File Upload flow the Worker depends on.

## Notion target

- **Database:** Home Log
- **Database ID:** `03f684ffe7b54efbad468fbf287d26fb`
- **Data Source ID:** `74587956-a0ef-4030-a8f2-8aba863c3cf0`
- **Parent page:** 👨‍👩‍👧‍👦 Family
- **URL:** https://www.notion.so/03f684ffe7b54efbad468fbf287d26fb
- **Schema:**
  - `Date` — title (text, ISO format `YYYY-MM-DD`)
  - `Note` — rich_text (left empty by the Worker; reserved for later transcription work, out of scope for this plan)
  - `Audio` — **Files & media** (the Worker attaches the uploaded `.m4a` here; this is NOT a URL property anymore — the property type was changed from URL to Files & media when we moved to the Worker architecture)

## Piece 1: Notion integration setup (~5 min, one-time, already done on laptop)

1. Open **https://www.notion.so/my-integrations**
2. Click **"New integration"**
3. Name: `Home Log iOS Shortcut`
4. Associated workspace: personal
5. Capabilities: **Insert content** (required). Read optional. Update and delete not needed.
6. Click **Submit**
7. On the next screen, copy the **Internal Integration Secret** (starts with `ntn_...`)
8. Open the **Home Log** database: https://www.notion.so/03f684ffe7b54efbad468fbf287d26fb
9. Click **•••** → **Connections** → **Connect to** → select `Home Log iOS Shortcut`
10. Confirm the integration has access

**Token storage:** 1Password item `Notion iOS Home Shortcut Key` (Private vault) holds the canonical token. The token lives as a Cloudflare Worker secret — **never in the Shortcut** — so there is no longer a secret-storage exception to document.

To rotate: regenerate at https://www.notion.so/my-integrations, update the 1Password item, then run:

```bash
op read "op://Private/Notion iOS Home Shortcut Key/password" \
  | npx wrangler secret put NOTION_TOKEN
```

in `~/dev/personal/ios-audio-notion-worker/`.

## Piece 2: iOS Shortcut (~5 min, on your phone)

Open the Shortcuts app on your iPhone → **+** to create a new shortcut. Name it exactly `Home Log` (so the Reminders URL can find it).

### Actions in order

| # | Action | Parameters |
|---|---|---|
| 1 | **Get Current Date** | Default |
| 2 | **Format Date** | Format: Custom → `yyyy-MM-dd` → variable name: `Today` |
| 3 | **Record Audio** | Start Recording: On Tap, Audio Quality: Normal → outputs `Recorded Audio` magic variable |
| 4 | **Get Contents of URL** | URL: `https://ios-audio-notion-worker.samjdacanay.workers.dev`<br>Method: POST<br>Headers: *none*<br>Request Body: **Form**<br>&nbsp;&nbsp;• `audio` (File): insert the *Recorded Audio* magic variable<br>&nbsp;&nbsp;• `date` (Text): insert the *Today* variable pill |
| 5 | **Show Notification** | Title: `Home log saved`, Body: *Today* variable pill |

That's it. No headers, no token, no JSON body, no Dictate Text, no Save File, no Get Link to File, no Wait, no Mail Drop, no iCloud Drive. The Worker does all of that server-side.

### Siri activation (optional)

- Shortcut details → toggle **"Use with Siri"** on
- Now **"Hey Siri, Home Log"** runs it

## Piece 3: Daily nudge via iOS Reminders (~2 min)

1. Open **Reminders** app → New reminder
2. Title: `Home log — one sentence`
3. Add URL field: `shortcuts://run-shortcut?name=Home%20Log`
4. Repeat: **Daily** at a time you pick (9pm suggested — post-decompression, pre-wind-down)
5. Save

Each night the reminder pops up. Tap the URL inside it → Shortcut runs → speak one sentence → done.

**Alternative: Shortcuts Automation** — Automation → + → Personal Automation → Time of Day → 9:00 PM → Daily → Run Shortcut → Home Log. The difference: Reminder is persistent and snoozable; Automation fires once and moves on. Reminders is the better choice for this habit.

## Piece 4: Test the full flow

Before trusting the nightly Reminder:

1. Open the **Shortcuts** app, tap **Home Log** to run it manually
2. Record a short audio clip when Record Audio prompts
3. Wait for "Home log saved" notification (takes 2-5 seconds — the Worker is doing three round-trips to Notion)
4. Open the Home Log database in Notion: https://www.notion.so/03f684ffe7b54efbad468fbf287d26fb
5. Verify a new row exists with today's date and a playable audio attachment in the Audio column

If you get "Home log saved" but no row appears, something failed silently. Check Cloudflare Workers logs:

```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler tail
```

…then re-run the Shortcut — you'll see the request come in and any Notion API errors.

## Common failures and fixes

| Symptom | Most likely cause | Fix |
|---|---|---|
| Shortcut shows an error immediately | Worker URL typo in **Get Contents of URL** action | Re-check URL: `https://ios-audio-notion-worker.samjdacanay.workers.dev` |
| Shortcut succeeds, no Notion row | Worker returned a 4xx/5xx but Shortcut ignored it | `wrangler tail` + re-run; check `detail` field in the Worker's JSON error response |
| Worker error: "body_validation_errors" on create page | Notion property type drift — `Audio` reverted to URL type, or the schema was edited | Re-check Notion schema: `Audio` must be **Files & media**, not URL |
| Worker error: "Content type audio/x-m4a is not supported" on `file_uploads/send` | Worker's `Blob` re-tag broke (regression in `src/index.ts`) | Revert `src/index.ts` to the deployed version — the `new Blob([bytes], { type: "audio/mp4" })` is load-bearing |
| Worker error: "parent.database_id is required" | Notion API version mismatch | Check `Notion-Version` header is `2026-03-11` AND payload uses `parent.type = data_source_id` (not `database_id`) |
| Worker error: 401 Unauthorized | `NOTION_TOKEN` secret missing or token revoked | Rotate via the Piece 1 rotation recipe |
| Worker error: "Could not find data source" | `NOTION_DATA_SOURCE_ID` secret wrong | Re-read from `GET /v1/databases/{db_id}` and re-set with `wrangler secret put` |
| Record Audio cuts off early | Device settings | Shortcut's Record Audio → Stop Recording: On Tap (not time-based) |

## Operating rules (from original plan doc)

- One sentence is enough. Length is not the goal.
- Atomic Habits "never miss twice" — skip a day, fine. Skip two in a row, the system needs a rethink, possibly killing.
- Do not backfill. Corpus starts the day it starts.
- No weekly review of entries. Let them accumulate.
- If after 4 weeks it feels performative, kill it cleanly.

## References

- Deployed Worker: https://ios-audio-notion-worker.samjdacanay.workers.dev
- Worker source: https://github.com/dakaneye/ios-audio-notion-worker
- Worker local dev: `~/dev/personal/ios-audio-notion-worker/` (run `npx wrangler dev` with `.dev.vars` populated)
- Home Log Notion DB: https://www.notion.so/03f684ffe7b54efbad468fbf287d26fb
- Parent page (Family): https://www.notion.so/32835e566abf81b38745ea169f2e55b0
- Notion API docs (pages.create): https://developers.notion.com/reference/post-page
- Notion API docs (file uploads): https://developers.notion.com/reference/file-upload
- Notion Internal Integrations: https://www.notion.so/my-integrations
