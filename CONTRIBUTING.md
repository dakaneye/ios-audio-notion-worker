# Contributing

## Development

```bash
git clone https://github.com/dakaneye/ios-audio-notion-worker.git
cd ios-audio-notion-worker
npm install
```

Create a local `.dev.vars` (gitignored) with your own Notion integration token and data source id:

```
NOTION_TOKEN=ntn_...
NOTION_DATA_SOURCE_ID=...
```

Run the Worker locally:

```bash
npx wrangler dev
```

## Before Submitting

1. Worker builds (`npx wrangler deploy --dry-run`)
2. Manual smoke test against a test Notion database you own
3. No secrets committed (check `git diff` for any `.dev.vars` leaks)

## Pull Requests

- Keep changes focused
- Preserve the Notion API version (`2026-03-11`) — downgrades will break the `data_source_id` parent shape
- Preserve the `audio/mp4` Blob re-tag — it's the entire reason this Worker exists
- Follow existing code style
