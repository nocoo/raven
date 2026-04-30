// ---------------------------------------------------------------------------
// DB sink — subscribes to LogEmitter and persists request_end events to SQLite.
//
// This decouples SQLite persistence from the route layer. Routes only emit
// LogEvents; the DB sink is responsible for extracting the RequestRecord
// fields from the event's data bag and writing them to the database.
//
// Only `request_end` events are persisted — every request (success or error)
// MUST emit a `request_end` event as its final event.
// ---------------------------------------------------------------------------

import type { Database } from "bun:sqlite";
import { logEmitter } from "../util/log-emitter.ts";
import type { LogEvent } from "../util/log-event.ts";
import { insertRequest, type RequestRecord } from "./requests.ts";

/**
 * Start the DB sink — subscribes to LogEmitter and writes request_end events.
 * Call once at bootstrap after database initialization.
 * Returns a cleanup function that removes the listener (for testing).
 */
export function startRequestSink(db: Database): () => void {
  const listener = (event: LogEvent) => {
    if (event.type !== "request_end") return;
    if (!event.requestId) return;

    const d = event.data ?? {};

    const record: RequestRecord = {
			id: event.requestId,
			timestamp: event.ts,
			path: (d.path as string) ?? "",
			client_format: (d.format as string) ?? "",
			model: (d.model as string) ?? "",
			resolved_model: (d.resolvedModel as string) ?? null,
			stream: d.stream ? 1 : 0,
			input_tokens: (d.inputTokens as number) ?? null,
			output_tokens: (d.outputTokens as number) ?? null,
			latency_ms: (d.latencyMs as number) ?? 0,
			ttft_ms: (d.ttftMs as number) ?? null,
			status: (d.status as string) ?? "unknown",
			status_code: (d.statusCode as number) ?? 0,
			upstream_status: (d.upstreamStatus as number) ?? null,
			error_message: (d.error as string) ?? null,
			account_name: (d.accountName as string) ?? "default",
			session_id: (d.sessionId as string) ?? "",
			client_name: (d.clientName as string) ?? "",
			client_version: (d.clientVersion as string) ?? null,
			processing_ms: (d.processingMs as number) ?? null,
			strategy: (d.strategy as string) ?? "",
			upstream: (d.upstream as string) ?? "",
			upstream_format: (d.upstreamFormat as string) ?? "",
			translated_model: (d.translatedModel as string) ?? "",
			copilot_model: (d.copilotModel as string) ?? "",
			routing_path: (d.routingPath as string) ?? "",
			stop_reason: (d.stopReason as string) ?? "",
			tool_call_count: (d.toolCallCount as number) ?? 0,
		};

    try {
      insertRequest(db, record);
    } catch (err) {
      // Log but don't crash — DB writes must never break request flow.
      // Use console.error directly to avoid infinite recursion through logEmitter.
      console.error(
        "[db-sink] Failed to persist request:",
        err instanceof Error ? err.message : err,
      );
    }
  };

  logEmitter.on("log", listener);

  return () => {
    logEmitter.off("log", listener);
  };
}
