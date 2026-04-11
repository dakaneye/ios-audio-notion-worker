# Contributing

## Development

```bash
git clone https://github.com/dakaneye/REPO.git
cd REPO
```

## Before Submitting

1. Build passes
2. Lint passes
3. Tests pass
4. New functionality has tests

## Pull Requests

- Keep changes focused
- Update tests for new functionality
- Follow existing code style

## Scheduled handler local testing

When changing `src/transcribe.ts`, use `wrangler dev --test-scheduled --port 8799` and curl `http://127.0.0.1:8799/__scheduled?cron=0+6+*+*+*` to invoke the handler locally without waiting for the nightly cron. See `TESTING.md` for the full recipe.
