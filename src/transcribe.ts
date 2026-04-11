// src/transcribe.ts — scheduled handler for the nightly transcription sweep.
// Task 5: full retry envelope + size cap + error sentinels.

import { Buffer } from "node:buffer";
import type { Env } from "./index";
import { queryDataSource, patchPageProperty } from "./notion";

const MAX_ROWS_PER_RUN = 5;
const MAX_AUDIO_BYTES = 5_000_000;
const RETRY_ATTEMPTS = 3;
// RETRY_DELAYS_MS[i] is the delay *before* attempt i+2. No sleep after the
// final attempt, so this array needs exactly RETRY_ATTEMPTS - 1 entries.
// If you bump RETRY_ATTEMPTS, update this array too.
const RETRY_DELAYS_MS = [1000, 2000];
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
// Notion rich_text content caps at 2000 chars per block; sentinels are
// truncated to stay under this so a long error.message can't break the PATCH
// that surfaces the failure (which would silently trap rows in an infinite
// retry loop across cron runs).
const MAX_SENTINEL_CHARS = 2000;

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

  try {
    const { text, whisperMs } = await transcribeWithRetry(env, audioFile.url);
    await patchPageProperty(env, row.id, noteProp, {
      rich_text: [{ text: { content: text } }],
    });
    console.log(JSON.stringify({
      event: "row_transcribed",
      page_id: row.id,
      chars: text.length,
      whisper_ms: whisperMs,
      duration_ms: Date.now() - start,
    }));
  } catch (e) {
    const error = e as Error;
    const isSize = error instanceof SizeError;
    const rawContent = isSize
      ? `[transcription skipped: audio exceeds ${MAX_AUDIO_BYTES} bytes]`
      : `[transcription failed after ${RETRY_ATTEMPTS} attempts: ${error.message}]`;
    // Truncate to Notion's rich_text content limit. If we don't, a long
    // error.message from Whisper/Notion 5xx can blow past 2000 chars, the
    // sentinel PATCH itself fails, and the row silently re-enters the cron
    // loop forever because the filter still sees Note as empty.
    const content = rawContent.length > MAX_SENTINEL_CHARS
      ? rawContent.slice(0, MAX_SENTINEL_CHARS - 1) + "…"
      : rawContent;

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

async function transcribeWithRetry(
  env: Env,
  audioUrl: string,
): Promise<{ text: string; whisperMs: number }> {
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
      const whisperStart = Date.now();
      const result = await env.AI.run(WHISPER_MODEL, {
        audio: base64,
        vad_filter: true,
        language: "en",
      }) as { text?: string };
      const whisperMs = Date.now() - whisperStart;
      return { text: (result.text ?? "").trim(), whisperMs };
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
