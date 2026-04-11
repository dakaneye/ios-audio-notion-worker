# Transcription cron — design spec

**Date:** 2026-04-10
**Status:** Approved for writing-plans phase
**Owner:** Sam (dakaneye)

## Summary

Add a Cloudflare Workers scheduled handler to `ios-audio-notion-worker` that periodically sweeps a Notion database for rows with audio but no transcription, transcribes them via Cloudflare Workers AI Whisper, and writes the result back into the row. The existing `fetch` handler (multipart upload proxy) is unchanged.

## Why

The Worker already solves the audio → Notion pipeline. Transcriptions make those rows useful for search, review, and later analysis. Without a transcription layer, the audio is write-only: you can record it, but you can't find it again a year from now.

A decoupled cron (rather than inline transcription in the upload path) is the right shape because:
1. The iOS Shortcut's upload latency stays fast — users aren't waiting on Whisper.
2. Rows added outside the Shortcut (manual imports, backfills) are also handled.
3. Retries and rate limiting are easier to reason about when separated from the synchronous request path.

## Out of scope (intentionally)

- **Automated tests.** Deferred as a maintenance task. The feature ships with a `TESTING.md` documenting the manual verification recipe and a `## Future work` note on vitest setup.
- **Audio chunking for files > 5 MB.** One-sentence voice notes are ~100 KB. The escape hatch for longer recordings is documented but not implemented.
- **OpenAI Whisper API fallback.** Cloudflare Workers AI is the primary and only transcription engine for this iteration.
- **Multiple languages.** `language: "en"` is pinned. Multilingual support can be added when the need appears.
- **Hallucination blocklist.** `vad_filter: true` is the primary defense. A post-hoc blocklist ships only if hallucinations appear in production logs.
- **Runtime kill switch.** Disabling the cron is done by editing `wrangler.toml` and redeploying (~60 seconds).
- **Cross-invocation retry counter.** In-invocation retry (3× with exponential backoff) is the only retry; final failures immediately surface in the Note field.

## Architecture

### One Worker, two handlers, one deployment

```
┌─────────────────┐                    ┌──────────────────────────────────────────┐
│ iOS Shortcut    │ ─POST multipart──> │ ios-audio-notion-worker                  │
│ (9pm daily)     │                    │                                          │
└─────────────────┘                    │   fetch()       scheduled()              │
                                       │   └── existing  └── NEW                  │
                                       │       unchanged                          │
                                       │                                          │
┌─────────────────┐                    │   env.AI binding (NEW)                   │
│ CF cron         │ ─scheduled()────>  │                                          │
│ 0 6 * * *       │                    │                                          │
│ (11pm PDT/      │                    └──┬───────────────┬─────────────┬─────────┘
│  10pm PST)      │                       │               │             │
└─────────────────┘                       ▼               ▼             ▼
                                    Notion API      Notion file     Workers AI
                                    (query +        signed S3       @cf/openai/
                                    patch)          URL             whisper-large-v3-turbo
```

### File layout (4 files total)

```
src/
├── index.ts       Entry point. Contains the Env interface and the default export
│                  { fetch: handleUpload, scheduled: handleScheduled }.
│                  Thin dispatch only. ~20 lines.
├── upload.ts      Existing multipart-proxy-to-Notion flow.
│                  Exports: handleUpload(request, env): Promise<Response>
│                  Contains its own Notion API calls to /v1/file_uploads and
│                  /v1/pages because those endpoints are upload-only.
│                  ~90 lines, mostly moved from current index.ts.
├── transcribe.ts  New cron sweep: query → for-of loop → transcribe → patch.
│                  Exports: handleScheduled(controller, env, ctx): Promise<void>
│                  Contains: retry envelope, Whisper call, per-row error-to-Note
│                  fallback, size cap check, base64 encoder helper.
│                  ~120 lines.
└── notion.ts      Shared Notion API helpers — code used by BOTH handlers.
                   Exports: notionHeaders, queryDataSource, patchPageProperty.
                   NOT a dumping ground. Upload-specific Notion calls stay in
                   upload.ts. Target: ≤ 60 lines.
```

**Why not 5 files** (with a separate `env.ts`): the `Env` interface is 6-8 fields. A dedicated file for one interface is ceremony without benefit at this scope. Lives next to the default export in `index.ts`. Handlers import with `import type { Env } from "./index"` (erased at compile time, no runtime circular dependency).

**Export style:** Each handler file exports one named function. The default export (the Workers entry point) lives only in `index.ts` and wires both handlers explicitly:

```typescript
// src/index.ts (sketch)
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

## Configuration

### Environment variables

| Name | Required | Default | Purpose |
|---|---|---|---|
| `NOTION_TOKEN` | yes | — | Existing secret. Notion integration token with Insert + Update + Read on the target DB. |
| `NOTION_DATA_SOURCE_ID` | yes | — | Existing secret. Data source UUID for the target Notion database. |
| `TRANSCRIBE_AUDIO_PROPERTY` | no | `"Audio"` | Name of the files & media property the cron reads from. |
| `TRANSCRIBE_NOTE_PROPERTY` | no | `"Note"` | Name of the rich_text property the cron writes transcriptions to. |

### Hardcoded constants (in `transcribe.ts`)

Not env vars — operational safety limits not intended for user tuning.

| Constant | Value | Purpose |
|---|---|---|
| `MAX_ROWS_PER_RUN` | `5` | Cap on how many rows one cron invocation processes. Prevents a runaway backlog from blowing the Workers AI neuron budget in one shot. |
| `MAX_AUDIO_BYTES` | `5_000_000` | 5 MB hard cap on audio size sent to Whisper. Files larger than this get a "[transcription skipped: too large]" sentinel written to Note and stop being retried. |
| `RETRY_ATTEMPTS` | `3` | Number of attempts inside the retry envelope. |
| `RETRY_DELAYS_MS` | `[1000, 2000, 4000]` | Exponential backoff delays between retries. |

### wrangler.toml additions

```toml
# existing: name, main, compatibility_date, [observability]

compatibility_flags = ["nodejs_compat"]  # Needed for Buffer-based base64 encoding (see open item 1)

[ai]
binding = "AI"

[triggers]
crons = ["0 6 * * *"]  # 11pm PDT / 10pm PST (~1 hour after 9pm recording habit)
```

### Cron time rationale

- Cloudflare cron triggers run in UTC.
- `0 6 * * *` = 6 AM UTC = **11 PM PDT** (summer) / **10 PM PST** (winter).
- User's recording habit is 9 PM local via an iOS Reminder → Shortcut.
- Cron fires 1-2 hours after the recording, whichever DST state is active. Transcriptions are ready by the next morning.
- DST drift (between 10 PM and 11 PM local) is acceptable for a personal habit tool. Documented in README.

## Data flow (scheduled handler, happy path)

```
scheduled(controller, env, ctx)
│
├─ 1. Parse config with defaults
│     audioProp = env.TRANSCRIBE_AUDIO_PROPERTY ?? "Audio"
│     noteProp  = env.TRANSCRIBE_NOTE_PROPERTY  ?? "Note"
│
├─ 2. Query Notion for untranscribed rows
│     POST /v1/data_sources/{NOTION_DATA_SOURCE_ID}/query
│     Body: {
│       filter: { and: [
│         { property: audioProp, files:     { is_not_empty: true } },
│         { property: noteProp,  rich_text: { is_empty:     true } },
│       ]},
│       page_size: MAX_ROWS_PER_RUN,
│       sorts: [{ timestamp: "created_time", direction: "ascending" }]
│     }
│     Log: { event: "query", matched: results.length }
│     If results.length === 0: return.
│
├─ 3. FOR EACH row in results (sequential for...of, NOT Promise.all)
│     │
│     ├─ 3a. Extract audio URL from the query response directly
│     │     row.properties[audioProp].files[0].file.url
│     │     Notion signed URLs are valid for 1 hour from query response time.
│     │     Worst-case cron wall-clock is ~50 seconds. No re-fetch needed.
│     │
│     ├─ 3b. Run the retry envelope (steps fetch→base64→Whisper as a unit):
│     │     try:
│     │       bytes   = await fetch(url).arrayBuffer()
│     │       if bytes.byteLength > MAX_AUDIO_BYTES:
│     │         throw new SizeError("audio too large")
│     │       base64  = encodeBase64(bytes)
│     │       result  = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
│     │         audio: base64,
│     │         vad_filter: true,
│     │         language: "en",
│     │       })
│     │       return result.text.trim()
│     │     catch:
│     │       if attempt < RETRY_ATTEMPTS: sleep(RETRY_DELAYS_MS[attempt-1]); continue
│     │       else: rethrow
│     │
│     │     Exception: SizeError is NOT retried — it's deterministic, not transient.
│     │     The outer catch handles it specially below.
│     │
│     ├─ 3c. PATCH the Note property with the transcription text
│     │     PATCH /v1/pages/{row.id}
│     │     Body: { properties: { [noteProp]: { rich_text: [
│     │       { text: { content: transcription } }
│     │     ]}}}
│     │     Log { event: "row_transcribed", page_id, bytes, chars, duration_ms }
│     │
│     └─ On per-row error:
│        - SizeError: PATCH Note with "[transcription skipped: audio exceeds 5MB]"
│                     Log { event: "row_skipped", page_id, reason: "too_large" }
│        - Other error after 3 retries: PATCH Note with
│                     "[transcription failed after 3 attempts: {error.message}]"
│                     Log { event: "row_failed", page_id, error }
│        - Both cases stop the row from being picked up next run (Note is non-empty).
│        - User can manually clear the Note to re-enqueue.
│
└─ 4. Return.
```

### Retry envelope boundary

The retry wrapper covers **fetch → base64 → Whisper** as one unit, not individual calls. Rationale: if Whisper transiently fails, we already have the downloaded bytes, so retrying the full sequence is wasteful — but if the fetch fails, we can't skip to Whisper. The cleanest boundary is "from 'I have a valid file URL' to 'I have transcription text'" as one atomic retry unit.

- Step 3c (PATCH) is **not** retried by the envelope. If PATCH fails, the row stays Note-empty and the next cron picks it up naturally.
- The query itself (step 2) is **not** retried. If the query fails, the whole cron invocation aborts and the next run retries.

### Retry wall-clock math (verified)

- Per row: up to 3 Whisper attempts, backoff `[1000, 2000, 4000]` ms between retries.
- Worst case per failing row: 7 seconds of `await sleep()` (plus actual API latencies).
- Worst case per run: 5 rows × (~7s sleep + ~3s API) ≈ 50 seconds wall-clock.
- Scheduled handler limit: CPU time ≤ 30s (same as HTTP), wall-clock ≤ 15 minutes.
- `await sleep()` does not count as CPU time — it's idle await, not active JS execution.
- **Comfortable margin on both limits.**

## Concurrency

**Sequential processing only.** The for-of loop awaits each row's complete flow before starting the next. This is load-bearing, not a preference:

- Notion rate limit: ~3 requests/second average, 429 on burst.
- Each row makes 2 Notion API calls (query already happened; per-row = 1 download from S3 + 1 PATCH) + 1 AI call.
- At 5 rows processed in parallel: 10 Notion calls + 5 AI calls issued simultaneously → 429 storm.
- Sequential: 5 rows × (1 fetch + 1 AI + 1 PATCH) serialized → stays under the limit.
- Code MUST use `for (const row of results)` with `await` inside, NOT `Promise.all(results.map(...))`.
- A code comment will call this out explicitly so no future "optimization" introduces a regression.

## Idempotency

The idempotency key is **"Note is empty"**:
- Filter: `Audio.files.is_not_empty AND Note.rich_text.is_empty`
- On success: Note contains the transcription → filter excludes the row → no re-transcription.
- On final failure: Note contains an error sentinel → filter excludes the row → no re-transcription.
- User manually clears Note → row re-qualifies → next cron retries it.
- Partial failure between step 3b and 3c (Whisper succeeded, PATCH failed): Note stays empty, next cron retries the *full* envelope. Whisper is called a second time but at ~1 neuron/audio-second this is negligible cost.

**Empirical verification (2026-04-10):** live query against the real Notion DB confirmed that the `rich_text.is_empty: true` filter correctly matches rows where Note was written as `rich_text: [{ text: { content: "" } }]` (the shape the existing `upload.ts` writes on page creation). The existing upload path does not need to change.

## Error handling

All errors fall into three categories:

1. **Transient, retryable:** Network glitches, Workers AI 503s, Notion 5xx. Caught by retry envelope → 3 attempts with exponential backoff. On success, invisible to user. On final failure, fall through to category 3.
2. **Deterministic, skip:** `SizeError` from the size cap check. Not retried. Writes a skip sentinel to Note.
3. **Final failure after retry:** Writes `"[transcription failed after 3 attempts: <error>]"` to Note. User sees the error in the Notion UI. Manual recovery: clear the Note to re-enqueue.

Global errors (e.g., the query itself fails, bad config) propagate out of `handleScheduled` and are logged by Cloudflare Workers Observability. Next cron run retries.

## Observability

Workers Observability is already enabled in `wrangler.toml`. The scheduled handler emits four structured log events via `console.log(JSON.stringify({...}))`:

- `{ event: "query", matched: number }` — once per invocation, right after the data source query
- `{ event: "row_transcribed", page_id, audio_bytes, transcription_chars, duration_ms }` — per successful row
- `{ event: "row_skipped", page_id, reason }` — per row hitting the size cap
- `{ event: "row_failed", page_id, error, attempts }` — per row hitting final failure after retries

Queryable in the Cloudflare dashboard. No other logging (no debug spam).

## Testing strategy

**No automated tests ship with this feature.** Testing is manual until the maintenance task adds vitest.

### Local iteration

```bash
# Terminal 1: run the Worker with scheduled trigger enabled
cd ~/dev/personal/ios-audio-notion-worker
npx wrangler dev --test-scheduled

# Terminal 2: fire the scheduled handler manually
curl "http://localhost:8787/__scheduled?cron=0+6+*+*+*"
```

Wrangler proxies `env.AI` calls to Cloudflare's remote Workers AI from local dev, so this hits the real Whisper model. Notion calls go out to the real API via `.dev.vars`. Each curl invocation = one full cron run against real state.

### Deployed smoke test

```bash
npx wrangler deploy
npx wrangler cron trigger --name ios-audio-notion-worker "0 6 * * *"
```

Triggers the deployed scheduled handler once, bypassing the 11pm schedule.

### Observation

```bash
npx wrangler tail
```

Streams production logs in real time. Run this in one terminal while triggering the cron in another.

### Manual end-to-end

1. Record a new audio via the iOS Shortcut.
2. Trigger the cron via `wrangler cron trigger` or wait until 11pm.
3. Open the Notion row and verify the Note field is populated.

### Completion criteria

- `wrangler deploy --dry-run` compiles cleanly.
- Local `wrangler dev --test-scheduled` + curl successfully transcribes the one existing untranscribed row in the Home Log DB (the 2026-04-10 Shortcut upload that verified the filter semantics).
- Deployed `wrangler cron trigger` does the same for a freshly recorded row.
- An intentional failure (e.g., temporarily set `NOTION_TOKEN` to `"bad"`) writes the error into Note after 3 retries.
- Workers Observability dashboard shows the 4 structured events.

## Documentation updates shipped with this feature

- `README.md` — new section "Transcription cron" explaining the scheduled handler, the two new env vars, the 5 MB cap, and what happens on failure. Update the "Configuration" table.
- `BUILD-PLAN.md` — add "Piece 5: Transcription" section. Update the architecture diagram. Update references section with the spec path.
- `TESTING.md` (new) — the manual verification recipe from the Testing section above, plus a "Future work: vitest setup" note.
- `CONTRIBUTING.md` — one-line mention of the `wrangler dev --test-scheduled` loop for local development of the cron.

## Open items for the writing-plans phase

These are design-level non-decisions; writing-plans will resolve them with small spikes:

1. **Base64 encoding default:** `Buffer.from(bytes).toString('base64')` with `nodejs_compat` flag. Rationale: it matches Cloudflare's own official Whisper example, is one line of code, and the Worker runs scheduled once a day where cold start latency is irrelevant. **Fallback** (if measurement during writing-plans shows the `nodejs_compat` flag measurably slows the `fetch` handler's cold start for the daily iOS Shortcut upload): swap to a hand-rolled chunked base64 encoder (~20 lines, no compat flag). Decision is reversible in writing-plans after timing both.
2. **Exact Whisper response shape assumptions:** Check once against a real call whether `result.text` is ever `undefined` or always string. Defensive or bare access?
3. **`sorts` field on the data source query:** Confirm the `timestamp` sort field is valid on the 2026-03-11 Notion API version. If not, fall back to a property-based sort on the Date title or drop sorting entirely (deterministic order is a nice-to-have, not a requirement).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Whisper model quality poor on user's specific voice | Low | Medium | Try it. If bad, swap to OpenAI Whisper API — one file change in `transcribe.ts`, add one secret. |
| Notion rate limit hit despite sequential loop | Very low | Medium | Per-row latencies give natural spacing. If it happens: add `await sleep(400)` between rows. |
| `nodejs_compat` flag measurably slows cold start | Low | Low | Test during writing-plans; fall back to hand-rolled base64 if slow. |
| Workers AI free tier neuron budget exhausted | Very low | Medium | 1M neurons/day free, ~1 neuron per second of audio. A 10-second clip = 10 neurons. Budget would fit ~100k transcriptions per day. |
| User manually edits Note to fix transcription, cron overwrites next run | Low | High | Does not happen — "Note not empty" filter excludes the row. Manually-cleared Notes *will* be re-transcribed, which is documented as the recovery path. |
| DST drift in cron schedule | Guaranteed | Low | Documented in README. 10pm ↔ 11pm local is acceptable for a personal habit tool. |

## Success looks like

Six months from now, a year of daily voice memos sits in the Home Log database. Each one has its audio attachment *and* a searchable transcription in the Note field. Sam can open Notion, search for "Ford" (the kid's name) and find every day he mentioned it. The Worker has been running on the cron untouched since deploy. No manual intervention has been needed. No transcription errors appear in the logs beyond the expected zero-to-one-per-week rate of transient Whisper hiccups.
