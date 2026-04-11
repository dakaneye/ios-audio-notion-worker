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
