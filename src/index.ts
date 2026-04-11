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
