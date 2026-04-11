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
