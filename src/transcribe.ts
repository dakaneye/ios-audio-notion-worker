// src/transcribe.ts — scheduled handler for the nightly transcription sweep.
// In Task 2 this is a no-op stub that only logs. Real query logic lands in Task 3.

import type { Env } from "./index";

export async function handleScheduled(
  _controller: ScheduledController,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  console.log(JSON.stringify({ event: "query", matched: 0, note: "task2 stub, no logic yet" }));
}
