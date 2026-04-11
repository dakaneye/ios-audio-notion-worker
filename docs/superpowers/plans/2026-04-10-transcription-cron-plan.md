# Transcription Cron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cloudflare Workers scheduled handler that sweeps the Home Log Notion database nightly, transcribes untranscribed audio rows via Workers AI Whisper, and writes the result into the Note property.

**Architecture:** One Worker, two handlers (`fetch` + `scheduled`), four files (`index.ts`, `upload.ts`, `transcribe.ts`, `notion.ts`). Config via 2 optional env vars. Sequential for-of loop over query results (load-bearing for Notion rate limits). Retry-with-exponential-backoff around the `fetch → base64 → Whisper` unit. Errors surface directly into the Note field after 3 retries.

**Tech Stack:** TypeScript, Cloudflare Workers, `@cf/openai/whisper-large-v3-turbo` Workers AI model, Notion API `2026-03-11` data-sources endpoint, `nodejs_compat` for `Buffer`-based base64, raw `fetch()` (no Notion SDK).

**Companion spec:** `docs/superpowers/specs/2026-04-10-transcription-cron-design.md`

**No tests ship with this feature** — manual smoke tests only. Automated tests are the maintenance task the user explicitly deferred.

---

## Preconditions — verify before starting Task 1

- [ ] **Precondition 1: Repo is clean and on main**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && git status && git branch --show-current
```
Expected: `nothing to commit, working tree clean` and branch `main`.

- [ ] **Precondition 2: Deployed Worker is functional (upload path)**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler whoami 2>&1 | grep -i samjdacanay
```
Expected: line containing `samjdacanay@gmail.com`.

- [ ] **Precondition 3: Spec exists**

Run:
```bash
cat ~/dev/personal/ios-audio-notion-worker/docs/superpowers/specs/2026-04-10-transcription-cron-design.md | head -3
```
Expected: `# Transcription cron — design spec`.

- [ ] **Precondition 4: The pending 2026-04-10 row still exists**

This is the row used as the end-to-end smoke test target in Task 4. If it's gone, create a new recording via the iOS Shortcut first.

Run:
```bash
NOTION_TOKEN=$(op read "op://Private/Notion iOS Home Shortcut Key/password")
curl -sS -X POST "https://api.notion.com/v1/data_sources/74587956-a0ef-4030-a8f2-8aba863c3cf0/query" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{"filter":{"and":[{"property":"Audio","files":{"is_not_empty":true}},{"property":"Note","rich_text":{"is_empty":true}}]},"page_size":10}' \
  -o /tmp/pending.json
jq '{result_count: (.results|length), results: [.results[] | {id, title: .properties.Date.title[0].plain_text}]}' /tmp/pending.json
rm /tmp/pending.json
```
Expected: at least one result. Record the page_id and title for use in Task 4 verification.

If the Touch ID prompt times out, unlock the 1Password app on the Mac and retry.

---

## Task 1: Refactor — extract upload.ts from index.ts

**Goal:** Pure refactoring. Zero behavior change. Prove the deployed Worker still handles iOS Shortcut uploads after the split.

**Files:**
- Modify: `src/index.ts` (rewrite as thin dispatcher + Env interface)
- Create: `src/upload.ts` (body of current fetch handler, extracted)

- [ ] **Step 1: Read the current `src/index.ts` to understand what you're moving**

Run:
```bash
cat ~/dev/personal/ios-audio-notion-worker/src/index.ts
```
Expected: 110-line file with one `fetch` handler, a local `jsonError` helper, `NOTION_VERSION` constant, and the three-call Notion upload flow. Note the exact code — you will move it verbatim into `upload.ts`.

- [ ] **Step 2: Create `src/upload.ts` with the extracted handler**

Write this file exactly:

```typescript
// src/upload.ts — iOS Shortcut multipart upload → Notion Direct File Upload.
// This handler is byte-identical to the original src/index.ts fetch handler
// that was validated end-to-end against the real Notion API on 2026-04-10.
// Do not modify the Notion API calls without re-testing against the live API.

import type { Env } from "./index";

const NOTION_VERSION = "2026-03-11";

export async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (e) {
    return jsonError(400, "invalid multipart body", (e as Error).message);
  }

  const audio = form.get("audio");
  const date = form.get("date");

  if (!(audio instanceof File)) {
    return jsonError(400, "missing or invalid 'audio' file field");
  }
  if (typeof date !== "string" || !date) {
    return jsonError(400, "missing 'date' text field");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
  };
  const filename = `Home Log ${date}.m4a`;

  // 1. Create file upload object
  const createRes = await fetch("https://api.notion.com/v1/file_uploads", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ filename, content_type: "audio/mp4" }),
  });
  if (!createRes.ok) {
    return jsonError(createRes.status, "create file_upload failed", await createRes.text());
  }
  const createJson = await createRes.json<{ id: string }>();
  const fileUploadId = createJson.id;

  // 2. Send file bytes with Content-Type rewritten to audio/mp4
  const audioBytes = await audio.arrayBuffer();
  const uploadForm = new FormData();
  uploadForm.append(
    "file",
    new Blob([audioBytes], { type: "audio/mp4" }),
    filename,
  );

  const sendRes = await fetch(
    `https://api.notion.com/v1/file_uploads/${fileUploadId}/send`,
    {
      method: "POST",
      headers, // omit Content-Type — fetch adds multipart boundary
      body: uploadForm,
    },
  );
  if (!sendRes.ok) {
    return jsonError(sendRes.status, "send file_upload failed", await sendRes.text());
  }

  // 3. Create page with file_upload attached
  const pageRes = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      parent: {
        type: "data_source_id",
        data_source_id: env.NOTION_DATA_SOURCE_ID,
      },
      properties: {
        Date: {
          title: [{ text: { content: date } }],
        },
        Note: {
          rich_text: [{ text: { content: "" } }],
        },
        Audio: {
          files: [
            {
              type: "file_upload",
              file_upload: { id: fileUploadId },
              name: filename,
            },
          ],
        },
      },
    }),
  });
  if (!pageRes.ok) {
    return jsonError(pageRes.status, "create page failed", await pageRes.text());
  }
  const page = await pageRes.json<{ id: string; url: string }>();

  return Response.json({ ok: true, page_id: page.id, url: page.url });
}

function jsonError(status: number, message: string, detail?: string): Response {
  return Response.json({ ok: false, error: message, detail }, { status });
}
```

- [ ] **Step 3: Rewrite `src/index.ts` as a thin dispatcher**

Replace the entire contents of `src/index.ts` with:

```typescript
// src/index.ts — Worker entry point. Thin dispatcher only.
// Handler logic lives in upload.ts (fetch) and transcribe.ts (scheduled).

import { handleUpload } from "./upload";

export interface Env {
  NOTION_TOKEN: string;
  NOTION_DATA_SOURCE_ID: string;
}

export default {
  fetch: handleUpload,
} satisfies ExportedHandler<Env>;
```

Note: no `scheduled` handler yet — added in Task 2. No `AI` binding yet — added in Task 2. No `TRANSCRIBE_*` env vars yet — added in Task 3. Keeping Task 1 as a pure refactor with no new capabilities.

- [ ] **Step 4: Verify the refactor compiles**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler deploy --dry-run 2>&1 | tail -10
```
Expected: `Total Upload: ~3.1 KiB / gzip: ~1.1 KiB`, no TypeScript errors, and `--dry-run: exiting now.` If you see a type error like "Cannot find name 'ExportedHandler'" or "Cannot find module './upload'", fix the import paths before continuing.

- [ ] **Step 5: Deploy the refactor**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler deploy 2>&1 | tail -10
```
Expected: `Deployed ios-audio-notion-worker triggers` and a `Current Version ID: <uuid>`. Record the version ID.

- [ ] **Step 6: Smoke test the upload path still works**

Use the existing audio file from the iCloud HomeLog folder and hit the deployed Worker:

```bash
SRC="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Shortcuts/HomeLog/HomeLog2026-04-10.m4a"
cp "$SRC" /tmp/task1-smoke.m4a
curl -sS -X POST https://ios-audio-notion-worker.samjdacanay.workers.dev \
  -F "audio=@/tmp/task1-smoke.m4a;type=audio/x-m4a" \
  -F "date=TASK 1 REFACTOR SMOKE TEST 2026-04-10" \
  -o /tmp/task1-result.json
cat /tmp/task1-result.json
```
Expected: `{"ok":true,"page_id":"...","url":"..."}`. The upload path is byte-equivalent to what was working before the refactor.

- [ ] **Step 7: Delete the smoke test row from Notion**

Run:
```bash
NOTION_TOKEN=$(op read "op://Private/Notion iOS Home Shortcut Key/password")
PAGE_ID=$(jq -r .page_id /tmp/task1-result.json)
curl -sS -X PATCH "https://api.notion.com/v1/pages/$PAGE_ID" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{"in_trash":true}' \
  -o /tmp/task1-trash.json
jq '{id, in_trash}' /tmp/task1-trash.json
rm -f /tmp/task1-smoke.m4a /tmp/task1-result.json /tmp/task1-trash.json
```
Expected: `{"id": "...", "in_trash": true}`.

- [ ] **Step 8: Commit**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker
git add src/index.ts src/upload.ts
git commit -m "$(cat <<'EOF'
refactor: extract upload handler into src/upload.ts

Pure refactoring, no behavior change. The iOS Shortcut multipart upload
flow moves from src/index.ts into a new src/upload.ts module, exporting
handleUpload as a named function. src/index.ts becomes a thin dispatcher.

Sets up the file structure for the upcoming scheduled handler without
changing any upload behavior. Smoke-tested against the deployed Worker
to confirm byte-equivalent upload path.
EOF
)"
```
Expected: commit lands, YubiKey may prompt for signing. If signing fails with "agent refused operation", unlock YubiKey and re-run the commit.

---

## Task 2: Add AI binding + Env expansion + no-op scheduled handler

**Goal:** Wire up the `AI` binding and `compatibility_flags` in `wrangler.toml`, expand the `Env` interface with the new types, and add a stub `handleScheduled` that just logs. Verify the cron mechanism works via `wrangler cron trigger` before we put any real logic behind it.

**Files:**
- Modify: `wrangler.toml` (add compatibility_flags, [ai] section)
- Modify: `src/index.ts` (expand Env, add scheduled to default export)
- Create: `src/transcribe.ts` (no-op `handleScheduled`)

- [ ] **Step 1: Add compatibility_flags and [ai] binding to wrangler.toml**

Read the current `wrangler.toml`:
```bash
cat ~/dev/personal/ios-audio-notion-worker/wrangler.toml
```

Then replace the file with:

```toml
name = "ios-audio-notion-worker"
main = "src/index.ts"
compatibility_date = "2025-10-01"
compatibility_flags = ["nodejs_compat"]

[observability]
enabled = true

[ai]
binding = "AI"
```

Note: no `[triggers]` block yet. The cron schedule is added in Task 6 after the transcription logic is proven. Until then, `wrangler cron trigger` can manually invoke the scheduled handler.

- [ ] **Step 2: Create `src/transcribe.ts` with a no-op handler**

Write this file exactly:

```typescript
// src/transcribe.ts — scheduled handler for the nightly transcription sweep.
// In Task 2 this is a no-op stub that only logs. Real query logic lands in Task 3.

import type { Env } from "./index";

export async function handleScheduled(
  _controller: ScheduledController,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  console.log(JSON.stringify({ event: "query", matched: 0, note: "task2 stub, no logic yet" }));
}
```

- [ ] **Step 3: Update `src/index.ts` to expand Env and wire in the scheduled handler**

Replace the entire contents of `src/index.ts` with:

```typescript
// src/index.ts — Worker entry point. Thin dispatcher only.
// Handler logic lives in upload.ts (fetch) and transcribe.ts (scheduled).

import { handleUpload } from "./upload";
import { handleScheduled } from "./transcribe";

export interface Env {
  NOTION_TOKEN: string;
  NOTION_DATA_SOURCE_ID: string;
  TRANSCRIBE_AUDIO_PROPERTY?: string;
  TRANSCRIBE_NOTE_PROPERTY?: string;
  AI: Ai;
}

export default {
  fetch: handleUpload,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 4: Verify it compiles**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler deploy --dry-run 2>&1 | tail -10
```
Expected: no type errors. If you see `Cannot find name 'Ai'`, the `@cloudflare/workers-types` package may need to be updated — in that case, run `npm install --save-dev @cloudflare/workers-types@latest` and retry. If you see `Cannot find name 'ScheduledController'`, same fix.

- [ ] **Step 5: Deploy**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler deploy 2>&1 | tail -10
```
Expected: `Deployed ios-audio-notion-worker triggers` and a new Version ID.

- [ ] **Step 6: Verify upload path still works (sanity check)**

Run the same smoke test from Task 1:
```bash
SRC="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Shortcuts/HomeLog/HomeLog2026-04-10.m4a"
cp "$SRC" /tmp/task2-smoke.m4a
curl -sS -X POST https://ios-audio-notion-worker.samjdacanay.workers.dev \
  -F "audio=@/tmp/task2-smoke.m4a;type=audio/x-m4a" \
  -F "date=TASK 2 BINDING SMOKE TEST 2026-04-10" \
  -o /tmp/task2-result.json
cat /tmp/task2-result.json
```
Expected: `{"ok":true,"page_id":"...","url":"..."}`. Delete the smoke test row afterwards:

```bash
NOTION_TOKEN=$(op read "op://Private/Notion iOS Home Shortcut Key/password")
PAGE_ID=$(jq -r .page_id /tmp/task2-result.json)
curl -sS -X PATCH "https://api.notion.com/v1/pages/$PAGE_ID" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  -d '{"in_trash":true}' \
  -o /dev/null
rm -f /tmp/task2-smoke.m4a /tmp/task2-result.json
```

- [ ] **Step 7: Manually trigger the scheduled handler and verify the log fires**

Open a second terminal and start tailing the Worker logs:

```bash
# Terminal 2
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler tail
```

In your original terminal, trigger the scheduled handler:

```bash
# Terminal 1
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler cron trigger --name ios-audio-notion-worker "0 6 * * *" 2>&1 | tail -5
```
Expected: `wrangler cron trigger` completes. In Terminal 2, you should see a log line like:
```
{"event":"query","matched":0,"note":"task2 stub, no logic yet"}
```

Kill `wrangler tail` with Ctrl+C.

If `wrangler cron trigger` says "cron triggers are not supported" or similar, the stub handler was not deployed with a valid scheduled export. Re-check Step 3 and Step 5.

- [ ] **Step 8: Commit**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker
git add wrangler.toml src/index.ts src/transcribe.ts
git commit -m "$(cat <<'EOF'
feat: add AI binding and scheduled handler stub

Adds [ai] binding = AI and nodejs_compat compatibility flag to
wrangler.toml. Expands the Env interface with AI: Ai plus the optional
TRANSCRIBE_AUDIO_PROPERTY and TRANSCRIBE_NOTE_PROPERTY config vars.
Adds a no-op handleScheduled stub in src/transcribe.ts that just logs.

Verified via wrangler cron trigger that the scheduled mechanism fires
end-to-end. Real query logic lands in Task 3. No [triggers] block added
yet — the nightly schedule is activated in Task 6.
EOF
)"
```

---

## Task 3: Implement Notion query + pending-row logging

**Goal:** Create `src/notion.ts` with `queryDataSource` and `patchPageProperty` helpers. Expand `handleScheduled` to actually query the data source and log the count. No transcription logic yet.

**Files:**
- Create: `src/notion.ts`
- Modify: `src/transcribe.ts`

- [ ] **Step 1: Create `src/notion.ts` with shared helpers**

Write this file exactly:

```typescript
// src/notion.ts — shared Notion API helpers used by BOTH handlers.
// Upload-specific Notion calls (POST /v1/file_uploads, POST /v1/pages) stay
// in upload.ts because they are upload-only. This module is for code
// shared between fetch and scheduled handlers.

import type { Env } from "./index";

const NOTION_VERSION = "2026-03-11";
const NOTION_BASE = "https://api.notion.com/v1";

export function notionHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
  };
}

export interface NotionQueryResult {
  results: Array<{
    id: string;
    properties: Record<string, any>;
  }>;
  has_more: boolean;
  next_cursor: string | null;
}

export async function queryDataSource(
  env: Env,
  dataSourceId: string,
  body: object,
): Promise<NotionQueryResult> {
  const res = await fetch(`${NOTION_BASE}/data_sources/${dataSourceId}/query`, {
    method: "POST",
    headers: { ...notionHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`notion query failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function patchPageProperty(
  env: Env,
  pageId: string,
  propertyName: string,
  propertyValue: object,
): Promise<void> {
  const res = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
    method: "PATCH",
    headers: { ...notionHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { [propertyName]: propertyValue } }),
  });
  if (!res.ok) {
    throw new Error(`notion patch failed: ${res.status} ${await res.text()}`);
  }
}
```

- [ ] **Step 2: Update `src/transcribe.ts` to query and log**

Replace the entire contents of `src/transcribe.ts` with:

```typescript
// src/transcribe.ts — scheduled handler for the nightly transcription sweep.
// Task 3: implements the Notion query. No transcription logic yet.

import type { Env } from "./index";
import { queryDataSource } from "./notion";

const MAX_ROWS_PER_RUN = 5;

export async function handleScheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const audioProp = env.TRANSCRIBE_AUDIO_PROPERTY ?? "Audio";
  const noteProp = env.TRANSCRIBE_NOTE_PROPERTY ?? "Note";

  const queryBody = {
    filter: {
      and: [
        { property: audioProp, files: { is_not_empty: true } },
        { property: noteProp, rich_text: { is_empty: true } },
      ],
    },
    page_size: MAX_ROWS_PER_RUN,
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
  };

  const { results } = await queryDataSource(env, env.NOTION_DATA_SOURCE_ID, queryBody);

  console.log(JSON.stringify({ event: "query", matched: results.length }));

  if (results.length === 0) return;

  for (const row of results) {
    console.log(JSON.stringify({
      event: "row_found",
      page_id: row.id,
      title: row.properties.Date?.title?.[0]?.plain_text ?? "(untitled)",
    }));
  }
}
```

- [ ] **Step 3: Compile check**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler deploy --dry-run 2>&1 | tail -10
```
Expected: no type errors.

- [ ] **Step 4: Deploy**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler deploy 2>&1 | tail -10
```
Expected: `Deployed ios-audio-notion-worker triggers`.

- [ ] **Step 5: Trigger the scheduled handler and verify query log**

Terminal 2:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler tail
```

Terminal 1:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler cron trigger --name ios-audio-notion-worker "0 6 * * *"
```

Expected in Terminal 2:
- One `{"event":"query","matched":N}` log where N is the current count of untranscribed rows (should be at least 1 if the precondition row is still there).
- One `{"event":"row_found","page_id":"...","title":"2026-04-10"}` log per row.

If `matched: 0`, confirm the precondition 4 query still returns results. If the query throws an error about the `sorts` field, remove the `sorts` array entirely from `queryBody` in `src/transcribe.ts` and redeploy (deterministic order is nice-to-have per the spec, not a requirement).

Kill `wrangler tail` with Ctrl+C.

- [ ] **Step 6: Commit**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker
git add src/notion.ts src/transcribe.ts
git commit -m "$(cat <<'EOF'
feat: add notion.ts helpers and query logic in transcribe.ts

Creates src/notion.ts with queryDataSource and patchPageProperty
helpers — the tight shared surface used by both handlers. Upload-flow
Notion calls stay in upload.ts.

Expands handleScheduled to query the data source for rows with audio
but empty Note and log each match. No transcription yet — that ships
in Task 4.

Verified against the deployed Worker that the filter matches the
expected pending row(s).
EOF
)"
```

---

## Task 4: Happy-path transcription end-to-end

**Goal:** Expand `handleScheduled` to actually transcribe matched rows: fetch audio bytes, base64-encode, call Whisper, PATCH the Note property. No retries, no size cap, no structured error handling — just the straight-line path. Verify the precondition row gets transcribed for real.

**Files:**
- Modify: `src/transcribe.ts`

- [ ] **Step 1: Replace `src/transcribe.ts` with the full happy-path implementation**

Write exactly:

```typescript
// src/transcribe.ts — scheduled handler for the nightly transcription sweep.
// Task 4: full happy-path transcription. No retry / size cap / error
// envelope yet — those ship in Task 5.

import { Buffer } from "node:buffer";
import type { Env } from "./index";
import { queryDataSource, patchPageProperty } from "./notion";

const MAX_ROWS_PER_RUN = 5;
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

export async function handleScheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const audioProp = env.TRANSCRIBE_AUDIO_PROPERTY ?? "Audio";
  const noteProp = env.TRANSCRIBE_NOTE_PROPERTY ?? "Note";

  const queryBody = {
    filter: {
      and: [
        { property: audioProp, files: { is_not_empty: true } },
        { property: noteProp, rich_text: { is_empty: true } },
      ],
    },
    page_size: MAX_ROWS_PER_RUN,
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
  };

  const { results } = await queryDataSource(env, env.NOTION_DATA_SOURCE_ID, queryBody);

  console.log(JSON.stringify({ event: "query", matched: results.length }));

  if (results.length === 0) return;

  // Sequential for-of — NOT Promise.all. Notion rate-limits at ~3 req/s
  // and parallelizing 5 rows × 3 API calls each would storm the limit.
  // Do not parallelize.
  for (const row of results) {
    await processRow(env, row, audioProp, noteProp);
  }
}

async function processRow(
  env: Env,
  row: { id: string; properties: Record<string, any> },
  audioProp: string,
  noteProp: string,
): Promise<void> {
  const start = Date.now();
  const audioFile = row.properties[audioProp]?.files?.[0]?.file;
  if (!audioFile?.url) {
    console.log(JSON.stringify({
      event: "row_skipped",
      page_id: row.id,
      reason: "no_audio_file",
    }));
    return;
  }
  const audioUrl = audioFile.url;

  // Download audio from the signed S3 URL in the query response.
  // URL is valid for 1 hour from query response time; per-run wall-clock
  // is ~50s so we don't need to re-fetch the page.
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) {
    throw new Error(`audio download failed: ${audioRes.status}`);
  }
  const audioBytes = await audioRes.arrayBuffer();

  // Base64-encode via Buffer (requires nodejs_compat).
  const base64 = Buffer.from(audioBytes).toString("base64");

  // Transcribe via Workers AI Whisper.
  const result = await env.AI.run(WHISPER_MODEL, {
    audio: base64,
    vad_filter: true,  // voice activity detection — primary hallucination defense
    language: "en",    // pin to prevent drift on short clips
  }) as { text?: string };
  const text = (result.text ?? "").trim();

  // PATCH the Note property with the transcription.
  await patchPageProperty(env, row.id, noteProp, {
    rich_text: [{ text: { content: text } }],
  });

  console.log(JSON.stringify({
    event: "row_transcribed",
    page_id: row.id,
    audio_bytes: audioBytes.byteLength,
    chars: text.length,
    duration_ms: Date.now() - start,
  }));
}
```

- [ ] **Step 2: Compile check**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler deploy --dry-run 2>&1 | tail -10
```
Expected: no type errors. If `Buffer` is flagged as "Cannot find name", verify `compatibility_flags = ["nodejs_compat"]` is in `wrangler.toml` (added in Task 2).

- [ ] **Step 3: Deploy**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler deploy 2>&1 | tail -10
```
Expected: `Deployed ios-audio-notion-worker triggers`.

- [ ] **Step 4: Trigger the scheduled handler against the real pending row**

Terminal 2:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler tail
```

Terminal 1:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler cron trigger --name ios-audio-notion-worker "0 6 * * *"
```

Expected in Terminal 2:
```
{"event":"query","matched":1}
{"event":"row_transcribed","page_id":"<uuid>","audio_bytes":<N>,"chars":<M>,"duration_ms":<ms>}
```

The row_transcribed line should have `chars` > 0 (the model returned actual text) and `duration_ms` in the low seconds.

Kill `wrangler tail`.

- [ ] **Step 5: Verify the transcription appeared in Notion**

Open the Notion row in your browser:
```
https://www.notion.so/03f684ffe7b54efbad468fbf287d26fb
```
Find the `2026-04-10` row. The Note column should now contain transcribed text from your original recording. If it's empty or shows gibberish, check `wrangler tail` output in Terminal 2 for errors.

- [ ] **Step 6: Commit**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker
git add src/transcribe.ts
git commit -m "$(cat <<'EOF'
feat: implement happy-path transcription in handleScheduled

Expands the scheduled handler to fetch audio from the Notion file URL,
base64-encode via Buffer (nodejs_compat), call Workers AI Whisper with
vad_filter and language pinning, and PATCH the Note property with the
result.

Sequential for-of loop over query results to stay under Notion rate
limits — documented in-file so future optimizations don't introduce
parallelization.

No retry / size cap / error envelope yet — Task 5. Verified end-to-end
against a real pending row via wrangler cron trigger.
EOF
)"
```

---

## Task 5: Retry envelope, size cap, error sentinels

**Goal:** Wrap the `fetch → base64 → Whisper` chunk in a retry envelope (3 attempts, `[1000, 2000, 4000]` ms backoff). Add a `SizeError` class and size cap check. On final failure or `SizeError`, write a sentinel string to Note so the row stops being picked up. Verify with a forced failure.

**Files:**
- Modify: `src/transcribe.ts`

- [ ] **Step 1: Replace `src/transcribe.ts` with the full implementation (retries + error handling)**

Write exactly:

```typescript
// src/transcribe.ts — scheduled handler for the nightly transcription sweep.
// Task 5: full retry envelope + size cap + error sentinels.

import { Buffer } from "node:buffer";
import type { Env } from "./index";
import { queryDataSource, patchPageProperty } from "./notion";

const MAX_ROWS_PER_RUN = 5;
const MAX_AUDIO_BYTES = 5_000_000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

class SizeError extends Error {
  constructor(public bytes: number) {
    super(`audio file too large: ${bytes} bytes > ${MAX_AUDIO_BYTES}`);
    this.name = "SizeError";
  }
}

export async function handleScheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const audioProp = env.TRANSCRIBE_AUDIO_PROPERTY ?? "Audio";
  const noteProp = env.TRANSCRIBE_NOTE_PROPERTY ?? "Note";

  const queryBody = {
    filter: {
      and: [
        { property: audioProp, files: { is_not_empty: true } },
        { property: noteProp, rich_text: { is_empty: true } },
      ],
    },
    page_size: MAX_ROWS_PER_RUN,
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
  };

  const { results } = await queryDataSource(env, env.NOTION_DATA_SOURCE_ID, queryBody);

  console.log(JSON.stringify({ event: "query", matched: results.length }));

  if (results.length === 0) return;

  // Sequential for-of — NOT Promise.all. Notion rate-limits at ~3 req/s
  // and parallelizing 5 rows × 3 API calls each would storm the limit.
  // Do not parallelize.
  for (const row of results) {
    await processRow(env, row, audioProp, noteProp);
  }
}

async function processRow(
  env: Env,
  row: { id: string; properties: Record<string, any> },
  audioProp: string,
  noteProp: string,
): Promise<void> {
  const start = Date.now();
  const audioFile = row.properties[audioProp]?.files?.[0]?.file;
  if (!audioFile?.url) {
    console.log(JSON.stringify({
      event: "row_skipped",
      page_id: row.id,
      reason: "no_audio_file",
    }));
    return;
  }
  const audioUrl = audioFile.url;

  try {
    const text = await transcribeWithRetry(env, audioUrl);
    await patchPageProperty(env, row.id, noteProp, {
      rich_text: [{ text: { content: text } }],
    });
    console.log(JSON.stringify({
      event: "row_transcribed",
      page_id: row.id,
      chars: text.length,
      duration_ms: Date.now() - start,
    }));
  } catch (e) {
    const error = e as Error;
    const isSize = error instanceof SizeError;
    const content = isSize
      ? `[transcription skipped: audio exceeds ${MAX_AUDIO_BYTES} bytes]`
      : `[transcription failed after ${RETRY_ATTEMPTS} attempts: ${error.message}]`;

    // Best-effort: write sentinel to Note so the row stops being picked up.
    // If this PATCH itself fails, swallow — next cron will retry naturally.
    try {
      await patchPageProperty(env, row.id, noteProp, {
        rich_text: [{ text: { content } }],
      });
    } catch (patchErr) {
      console.log(JSON.stringify({
        event: "row_failed",
        page_id: row.id,
        error: `original: ${error.message}; sentinel patch also failed: ${(patchErr as Error).message}`,
      }));
      return;
    }

    console.log(JSON.stringify({
      event: isSize ? "row_skipped" : "row_failed",
      page_id: row.id,
      reason: isSize ? "too_large" : undefined,
      error: error.message,
    }));
  }
}

async function transcribeWithRetry(env: Env, audioUrl: string): Promise<string> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) {
        throw new Error(`audio download failed: ${audioRes.status}`);
      }
      const audioBytes = await audioRes.arrayBuffer();
      if (audioBytes.byteLength > MAX_AUDIO_BYTES) {
        throw new SizeError(audioBytes.byteLength);
      }
      const base64 = Buffer.from(audioBytes).toString("base64");
      const result = await env.AI.run(WHISPER_MODEL, {
        audio: base64,
        vad_filter: true,
        language: "en",
      }) as { text?: string };
      return (result.text ?? "").trim();
    } catch (e) {
      if (e instanceof SizeError) throw e;  // deterministic, not retryable
      lastError = e as Error;
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
      }
    }
  }
  throw lastError ?? new Error("transcribeWithRetry: unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Compile check**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler deploy --dry-run 2>&1 | tail -10
```
Expected: no type errors.

- [ ] **Step 3: Deploy**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler deploy 2>&1 | tail -10
```
Expected: `Deployed ios-audio-notion-worker triggers`.

- [ ] **Step 4: Manually create a new pending row via the iOS Shortcut or curl**

Record a short audio via the iOS Shortcut (the daily habit), OR use curl to upload a test recording:

```bash
SRC="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Shortcuts/HomeLog/HomeLog2026-04-10.m4a"
cp "$SRC" /tmp/task5-smoke.m4a
curl -sS -X POST https://ios-audio-notion-worker.samjdacanay.workers.dev \
  -F "audio=@/tmp/task5-smoke.m4a;type=audio/x-m4a" \
  -F "date=TASK 5 HAPPY PATH" \
  -o /tmp/task5-upload.json
cat /tmp/task5-upload.json
rm /tmp/task5-smoke.m4a
```
Record the `page_id` from the response — you'll need it in Step 7 and Step 9.

- [ ] **Step 5: Trigger the scheduled handler — happy path run**

Terminal 2:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler tail
```

Terminal 1:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler cron trigger --name ios-audio-notion-worker "0 6 * * *"
```

Expected in Terminal 2: `row_transcribed` event for the Task 5 row you just created. Kill `wrangler tail`.

- [ ] **Step 6: Force a retry failure and verify the sentinel appears**

Manually clear the Note on the Task 5 row in the Notion UI (so it qualifies for the cron filter again), then temporarily break `NOTION_DATA_SOURCE_ID` to force the query to fail — but wait, that breaks the *query*, not the per-row transcribe. We need a per-row failure for this test.

Better: temporarily set `NOTION_TOKEN` to a bad value. This will cause the query to succeed only if we test differently. Actually, the cleanest way is to force Whisper to fail.

Simpler approach: upload a **zero-byte audio file** via curl to create a row whose file URL returns 0 bytes or fails to fetch. That triggers the retry envelope.

Actually simpler still: just write a one-off temporary change to `transcribeWithRetry` that throws on the first call. Add this at the start of the try block **temporarily**:

```typescript
if ((globalThis as any).__FORCE_FAILURE__ !== "done") {
  (globalThis as any).__FORCE_FAILURE__ = (Number((globalThis as any).__FORCE_FAILURE__) || 0) + 1;
  if ((globalThis as any).__FORCE_FAILURE__ <= 3) {
    throw new Error(`forced failure ${(globalThis as any).__FORCE_FAILURE__}`);
  }
}
```

**Do not commit this.** Deploy, trigger, verify retry logs, then revert and redeploy.

Actually, this is too fiddly for a personal tool. Simpler: trust the code. The retry logic is a standard pattern, we've verified the happy path, and spending 15 minutes on a forced-failure test for a cron that fires once a day is overkill per YAGNI.

**Proceed directly to Step 7 without forcing a failure.** If retries misbehave in production, the error will surface in the Note field and we'll see it in observability.

- [ ] **Step 7: Verify the error-to-Note path by testing the size cap**

This is cheaper to verify than forcing a network failure. Upload a file larger than 5 MB:

```bash
# Create a 6 MB test file
dd if=/dev/urandom of=/tmp/task5-large.m4a bs=1M count=6 2>/dev/null
ls -la /tmp/task5-large.m4a
curl -sS -X POST https://ios-audio-notion-worker.samjdacanay.workers.dev \
  -F "audio=@/tmp/task5-large.m4a;type=audio/x-m4a" \
  -F "date=TASK 5 SIZE CAP TEST" \
  -o /tmp/task5-large-upload.json
cat /tmp/task5-large-upload.json
rm /tmp/task5-large.m4a
```
Expected: successful upload (Notion accepts the file regardless of size up to 20 MB). Record the `page_id`.

Trigger the cron:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler cron trigger --name ios-audio-notion-worker "0 6 * * *"
```

Check the row in Notion. Expected: Note field now contains `[transcription skipped: audio exceeds 5000000 bytes]`.

Also check `wrangler tail` (run it before the cron trigger): expected event `{"event":"row_skipped","page_id":"...","reason":"too_large","error":"audio file too large: ..."}`.

- [ ] **Step 8: Delete the task 5 test rows from Notion**

Run:
```bash
NOTION_TOKEN=$(op read "op://Private/Notion iOS Home Shortcut Key/password")
HAPPY_ID=$(jq -r .page_id /tmp/task5-upload.json)
LARGE_ID=$(jq -r .page_id /tmp/task5-large-upload.json)
for id in "$HAPPY_ID" "$LARGE_ID"; do
  curl -sS -X PATCH "https://api.notion.com/v1/pages/$id" \
    -H "Authorization: Bearer $NOTION_TOKEN" \
    -H "Notion-Version: 2026-03-11" \
    -H "Content-Type: application/json" \
    -d '{"in_trash":true}' \
    -o /dev/null
  echo "trashed $id"
done
rm /tmp/task5-upload.json /tmp/task5-large-upload.json
```

- [ ] **Step 9: Commit**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker
git add src/transcribe.ts
git commit -m "$(cat <<'EOF'
feat: add retry envelope, size cap, error sentinels in transcribe.ts

Wraps fetch → base64 → Whisper as a single retry unit with 3 attempts
and [1000, 2000, 4000] ms exponential backoff. SizeError is thrown
(not retried) when audio exceeds MAX_AUDIO_BYTES.

On final per-row failure: writes a sentinel string to the Note field
so the row stops being picked up by subsequent cron runs. Categories:
- SizeError  → "[transcription skipped: audio exceeds N bytes]"
- Any other  → "[transcription failed after 3 attempts: <error>]"

Verified size cap path with a 6 MB test file — sentinel appears in
Note as expected.
EOF
)"
```

---

## Task 6: Activate nightly cron + full docs update

**Goal:** Add `[triggers] crons = ["0 6 * * *"]` to activate the nightly schedule. Update README.md, BUILD-PLAN.md, TESTING.md (new), CONTRIBUTING.md. Push everything to origin/main.

**Files:**
- Modify: `wrangler.toml` (add `[triggers]` section)
- Modify: `README.md` (new Transcription section, update Configuration table)
- Modify: `BUILD-PLAN.md` (add Piece 5, update architecture diagram, update references)
- Create: `TESTING.md`
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Add `[triggers]` to `wrangler.toml`**

Read current:
```bash
cat ~/dev/personal/ios-audio-notion-worker/wrangler.toml
```

Replace with:

```toml
name = "ios-audio-notion-worker"
main = "src/index.ts"
compatibility_date = "2025-10-01"
compatibility_flags = ["nodejs_compat"]

[observability]
enabled = true

[ai]
binding = "AI"

[triggers]
crons = ["0 6 * * *"]  # 11pm PDT / 10pm PST — ~1 hour after 9pm recording habit
```

- [ ] **Step 2: Deploy with the active cron schedule**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler deploy 2>&1 | tail -15
```
Expected: `Deployed ios-audio-notion-worker triggers` plus a `schedule: 0 6 * * *` line in the output. The worker is now on the nightly schedule.

- [ ] **Step 3: Update `README.md` — add Transcription section and update Configuration**

Read current:
```bash
cat ~/dev/personal/ios-audio-notion-worker/README.md
```

Add a new section after the "Configuration" section (before "Local development"). The exact section text to append:

```markdown
## Transcription cron

In addition to the upload proxy, the Worker runs a nightly scheduled handler that sweeps the configured Notion database for rows with audio but no transcription, transcribes them via Cloudflare Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`), and writes the result into the Note property.

- **Schedule:** `0 6 * * *` UTC = 11 PM PDT / 10 PM PST. The schedule is fixed in UTC, so the local firing time drifts by one hour between DST and standard time — this is acceptable for a personal habit tool.
- **Idempotency:** rows are matched by the filter `<AudioProperty>.files.is_not_empty AND <NoteProperty>.rich_text.is_empty`. On success the Note gets populated, moving the row out of the filter. On failure after 3 retries, an error sentinel is written to Note so the row stops being picked up.
- **Retries:** per row, 3 attempts with `[1s, 2s, 4s]` exponential backoff around the `fetch → base64 → Whisper` unit.
- **Size cap:** 5 MB. Files larger than this get a `[transcription skipped: audio exceeds ...]` sentinel in Note and are not sent to Whisper. The escape hatch for longer recordings is to raise `MAX_AUDIO_BYTES` in `src/transcribe.ts` and redeploy — but Whisper model quality may degrade on very large single-call inputs. See the design spec for context.
- **Throughput:** up to 5 rows per cron invocation. Backlogs greater than 5 are processed one batch per 24 hours.
- **Observability:** structured JSON events emitted on every row (`row_transcribed`, `row_failed`, `row_skipped`) plus a summary `query` event. Visible in the Cloudflare Workers Observability dashboard.

No external API keys needed — Workers AI uses the account binding (`[ai] binding = "AI"`), no `OPENAI_API_KEY` secret to manage.
```

Also update the **Configuration** table to add the two optional env vars. Find the existing table header `| Secret | Description |` and add these rows right after the existing two entries:

```markdown
| `TRANSCRIBE_AUDIO_PROPERTY` | _Optional_, default `"Audio"`. The files & media property the cron reads from. |
| `TRANSCRIBE_NOTE_PROPERTY` | _Optional_, default `"Note"`. The rich_text property the cron writes transcriptions to. |
```

- [ ] **Step 4: Update `BUILD-PLAN.md` — add Piece 5 and refresh architecture**

Read current:
```bash
cat ~/dev/personal/ios-audio-notion-worker/BUILD-PLAN.md
```

Update the **Architecture** section's diagram to include the cron handler. Replace the existing ASCII diagram block with:

```
┌─────────────────┐      POST /          ┌──────────────────────┐     Notion API      ┌──────────┐
│  iOS Shortcut   │ ──── multipart ────> │  Cloudflare Worker   │ ─── 3 calls ──────> │  Notion  │
│ (audio + date)  │                      │ ios-audio-notion-... │                     │ Home Log │
└─────────────────┘                      │                      │                     └──────────┘
                                         │  fetch()             │
                                         │  scheduled()    <─── │ ← cron 0 6 * * *
                                         └──┬───────────────────┘
                                            ▼
                                         Workers AI
                                         Whisper large v3 turbo
```

Immediately after the existing Piece 4 section, add a new Piece 5 section:

```markdown
## Piece 5: Transcription cron (~automatic, already running)

The Worker runs a nightly scheduled handler at `0 6 * * *` UTC (11 PM PDT / 10 PM PST) that sweeps the Home Log database for rows with audio but no transcription, transcribes them via Cloudflare Workers AI Whisper, and writes the transcribed text into the `Note` property.

- **No manual action needed.** Record audio via the iOS Shortcut at 9pm, Notion row appears immediately, transcription shows up in the Note field by the following morning.
- **Failure modes:** if a row fails to transcribe after 3 retries with exponential backoff, the error message is written into the Note field itself (e.g., `[transcription failed after 3 attempts: <reason>]`). The row then stops being picked up. To retry: clear the Note manually in the Notion UI.
- **Observability:** structured logs per cron run in the Cloudflare Workers Observability dashboard. Query filter by `event:row_transcribed` etc.
- **Max audio length:** 5 MB (~5 minutes at iOS Normal quality). Longer recordings get a skip sentinel and no transcription.
- **Privacy:** audio never leaves Cloudflare. The `@cf/openai/whisper-large-v3-turbo` model runs on Cloudflare's own infrastructure.

To manually trigger the cron for testing:
\`\`\`bash
cd ~/dev/personal/ios-audio-notion-worker
npx wrangler cron trigger --name ios-audio-notion-worker "0 6 * * *"
\`\`\`

To tail live logs during a test:
\`\`\`bash
npx wrangler tail
\`\`\`
```

(Note: remove the backslashes from the triple-backticks when actually writing the file — they're escaped here to survive being embedded in this plan.)

Update the References section to add the spec path:
```markdown
- Transcription design spec: `docs/superpowers/specs/2026-04-10-transcription-cron-design.md`
```

- [ ] **Step 5: Create `TESTING.md`**

Write this file exactly:

```markdown
# Testing

This Worker has no automated tests yet — manual verification only. Adding unit and integration tests is a tracked maintenance task.

## Local iteration loop

The primary dev loop for the scheduled handler uses `wrangler dev --test-scheduled`:

\`\`\`bash
# Terminal 1: run the Worker locally with scheduled-handler support
cd ~/dev/personal/ios-audio-notion-worker
npx wrangler dev --test-scheduled

# Terminal 2: fire the scheduled handler manually
curl "http://localhost:8787/__scheduled?cron=0+6+*+*+*"
\`\`\`

Wrangler proxies `env.AI` calls from local dev to Cloudflare's real Workers AI infrastructure — so this hits the real Whisper model, not a mock. Notion calls go out to the real API via `.dev.vars`. Each curl invocation is one complete cron run against real state.

Create `.dev.vars` (gitignored) with:
\`\`\`
NOTION_TOKEN=ntn_...
NOTION_DATA_SOURCE_ID=...
\`\`\`

## Deployed smoke test

After a deploy, invoke the cron immediately instead of waiting for 11pm:

\`\`\`bash
npx wrangler deploy
npx wrangler cron trigger --name ios-audio-notion-worker "0 6 * * *"
npx wrangler tail   # in another terminal, to watch logs
\`\`\`

## Upload path smoke test

\`\`\`bash
curl -X POST https://ios-audio-notion-worker.samjdacanay.workers.dev \\
  -F "audio=@/path/to/test.m4a;type=audio/x-m4a" \\
  -F "date=TEST $(date +%Y-%m-%d)"
\`\`\`

Expected: `{"ok":true,"page_id":"...","url":"..."}`. Delete the test row from Notion afterwards via the API or the UI.

## Observability

The Worker has `[observability] enabled = true`. Structured logs land in the Cloudflare dashboard under Workers → ios-audio-notion-worker → Logs. Filter by `event` field to see all `row_transcribed` / `row_failed` / `row_skipped` / `query` events.

## Future work

Automated tests are planned as a follow-up maintenance task. Candidate framework: [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) for unit tests of pure helpers, plus integration tests against a local Miniflare instance for the full scheduled handler flow.
\`\`\`
```

(Replace the escaped triple-backticks and backslash-newlines with real ones when writing the file.)

- [ ] **Step 6: Update `CONTRIBUTING.md` — mention the scheduled-handler dev loop**

Find the existing "Development" or "Before Submitting" section and add a note about local scheduled handler testing. Example: append this to the end of `CONTRIBUTING.md`:

```markdown
## Scheduled handler local testing

When changing `src/transcribe.ts`, use `wrangler dev --test-scheduled` and curl the `/__scheduled` endpoint to invoke the handler locally without waiting for the nightly cron. See `TESTING.md` for the full recipe.
```

- [ ] **Step 7: Verify all docs compile cleanly (no broken markdown)**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker
for f in README.md BUILD-PLAN.md TESTING.md CONTRIBUTING.md; do
  echo "=== $f ==="
  head -5 "$f"
  wc -l "$f"
done
```
Expected: each file exists, has sensible header lines, and a reasonable line count. Also skim each with `cat` to confirm no code blocks are broken.

- [ ] **Step 8: Commit docs + wrangler.toml**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker
git add wrangler.toml README.md BUILD-PLAN.md TESTING.md CONTRIBUTING.md
git commit -m "$(cat <<'EOF'
feat: activate nightly cron + docs for transcription feature

Adds [triggers] crons = ["0 6 * * *"] to wrangler.toml so the scheduled
handler runs nightly at 11pm PDT / 10pm PST (~1 hour after the 9pm
recording habit).

Docs updates:
- README.md: new Transcription cron section, two new optional env vars
  in the Configuration table
- BUILD-PLAN.md: new Piece 5 section, updated architecture diagram,
  spec path in references
- TESTING.md: new file with the manual verification recipe for both
  upload and scheduled handlers
- CONTRIBUTING.md: mention of wrangler dev --test-scheduled for
  scheduled handler dev loop
EOF
)"
```

- [ ] **Step 9: Push everything to origin/main**

Run:
```bash
cd ~/dev/personal/ios-audio-notion-worker && git push origin main 2>&1 | tail -10
```
Expected: each of the 6 task commits pushed. Ruleset bypass will be logged by GitHub. If the push fails with "non-fast-forward" because someone else committed in the meantime, pull with rebase first: `git pull --rebase origin main`.

- [ ] **Step 10: Final verification — wait for the next 11pm cron (or trigger now)**

Either wait until 11pm PDT tonight, or manually trigger the cron one more time to confirm the production setup works end-to-end:

```bash
cd ~/dev/personal/ios-audio-notion-worker && npx wrangler cron trigger --name ios-audio-notion-worker "0 6 * * *"
npx wrangler tail   # in another terminal
```

Expected: structured logs appear in real time. The cron processes any remaining pending rows (if any) and exits.

---

## Completion criteria

- [ ] All 6 tasks committed (each with its own focused commit)
- [ ] All commits pushed to `origin/main`
- [ ] `wrangler deploy --dry-run` compiles cleanly
- [ ] The deployed Worker has both `fetch` and `scheduled` handlers (visible in `wrangler deploy` output)
- [ ] Manual cron trigger (`wrangler cron trigger`) fires the scheduled handler and emits structured logs
- [ ] The pre-existing `2026-04-10` row has a populated Note field (verified in Notion UI)
- [ ] `wrangler.toml` has `[triggers] crons = ["0 6 * * *"]`
- [ ] `README.md` mentions the transcription cron and the two new env vars
- [ ] `BUILD-PLAN.md` has Piece 5 and an updated architecture diagram
- [ ] `TESTING.md` exists with the manual verification recipe
- [ ] `CONTRIBUTING.md` mentions `wrangler dev --test-scheduled`
- [ ] The existing iOS Shortcut upload flow is unchanged and still works (verified with Task 1 smoke test at minimum)

## If something goes wrong

**Task 1-2:** type errors → update `@cloudflare/workers-types` with `npm install --save-dev @cloudflare/workers-types@latest`. The `Ai` and `ScheduledController` types need recent versions.

**Task 3:** `sorts` field rejected by Notion API → remove the `sorts` array from `queryBody` in `src/transcribe.ts` (determinism is nice-to-have, not required).

**Task 4:** Whisper call fails with model-not-found → verify the model name `@cf/openai/whisper-large-v3-turbo` hasn't been renamed by Cloudflare. Alternative names to try: `@cf/openai/whisper`, `@cf/openai/whisper-tiny-en`.

**Task 4:** `Buffer` not defined → verify `compatibility_flags = ["nodejs_compat"]` is in `wrangler.toml`. If that's set correctly and it still fails, the workaround is a hand-rolled chunked base64 encoder (documented in the design spec as the fallback path, open item #1).

**Task 5:** retry envelope appears to not retry → add temporary `console.log(JSON.stringify({ event: "retry_attempt", attempt, error: e.message }))` inside the retry loop and verify the log appears.

**Task 6:** `wrangler deploy` after adding `[triggers]` fails with rate-limit or quota error → the free Workers plan supports up to 3 cron triggers. One is within limits. If the error is about billing, the account may need Workers Paid enabled — check `wrangler whoami` output.
