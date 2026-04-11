# Testing

This Worker has no automated tests yet — manual verification only. Adding unit and integration tests is a tracked maintenance task.

## Local iteration loop

The primary dev loop for the scheduled handler uses `wrangler dev --test-scheduled`:

```bash
# Terminal 1: run the Worker locally with scheduled-handler support enabled
cd ~/dev/personal/ios-audio-notion-worker
npx wrangler dev --test-scheduled --port 8799

# Terminal 2: fire the scheduled handler manually
curl "http://127.0.0.1:8799/__scheduled?cron=0+6+*+*+*"
```

Wrangler proxies `env.AI` calls from local dev to Cloudflare's real Workers AI infrastructure — so this hits the real Whisper model, not a mock. Notion calls go out to the real API via `.dev.vars`. Each curl invocation is one complete cron run against real state.

Create `.dev.vars` (gitignored) with:
```
NOTION_TOKEN=ntn_...
NOTION_DATA_SOURCE_ID=...
```

Note: wrangler 4.81.1 removed the old `wrangler cron trigger` subcommand. The `--test-scheduled` + `/__scheduled` flow above is the current equivalent.

## Deployed smoke test

After a deploy, you can invoke the cron immediately by using the Cloudflare dashboard's "Send event" button on the Worker's Triggers page, or by waiting for the next 11pm PDT firing. Then watch logs with:

```bash
npx wrangler tail
```

in a second terminal.

## Upload path smoke test

```bash
curl -X POST https://ios-audio-notion-worker.samjdacanay.workers.dev \
  -F "audio=@/path/to/test.m4a;type=audio/x-m4a" \
  -F "date=TEST $(date +%Y-%m-%d)"
```

Expected: `{"ok":true,"page_id":"...","url":"..."}`. Delete the test row from Notion afterwards via the API or the UI.

## Observability

The Worker has `[observability] enabled = true`. Structured logs land in the Cloudflare dashboard under Workers → ios-audio-notion-worker → Logs. Filter by `event` field to see all `row_transcribed` / `row_failed` / `row_skipped` / `query` events.

## Future work

Automated tests are planned as a follow-up maintenance task. Candidate framework: [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) for unit tests of pure helpers, plus integration tests against a local Miniflare instance for the full scheduled handler flow.
