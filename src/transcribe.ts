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
