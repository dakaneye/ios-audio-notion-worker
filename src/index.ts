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
