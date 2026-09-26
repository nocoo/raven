import { expect, it } from "vitest";
import { logEntry, filterLogGroups } from "@/lib/log-entry";
import type { LogEvent } from "@/hooks/use-log-stream";
const events: LogEvent[] = [
  { ts: 1, level: "info", type: "request_start", requestId: "request-1", msg: "start", data: { model: "auto", path: "/v1/messages", accountName: "Editor", clientIP: "2001:db8::1", format: "anthropic" } },
  { ts: 2, level: "info", type: "request_end", requestId: "request-1", msg: "done", data: { status: "success", resolvedModel: "raw-model", latencyMs: 0, inputTokens: 0, outputTokens: 2, upstreamFormat: "anthropic" } },
];
it("keeps whole request groups when searching any identity or IP", () => {
  for (const query of ["2001:DB8", "Editor", "auto", "request-1", "messages", "done", ""]) expect(filterLogGroups(events, query)[0]?.events).toHaveLength(2);
  expect(filterLogGroups(events, "missing")).toEqual([]);
});
it("merges start identity with the result and preserves zeros", () => {
  expect(logEntry(events)).toMatchObject({ timestamp: 1, status: "success", model: "auto", resolvedModel: "raw-model", clientIP: "2001:db8::1", latencyMs: 0, tokens: 2, system: false });
});
it("handles denied, cancelled, pending, orphaned and system events", () => {
  expect(logEntry([events[0]!])).toMatchObject({ status: "pending", tokens: null, latencyMs: null });
  for (const status of ["denied", "cancelled", "error"]) expect(logEntry([{ ...events[1]!, data: { status, error: "reason" } }])).toMatchObject({ status, error: "reason", timestamp: 2 });
  expect(logEntry([{ ts: 3, level: "warn", type: "system", requestId: null, msg: "startup" }])).toMatchObject({ system: true, status: "warn", model: "startup", clientIP: "", path: "System" });
  expect(logEntry([{ ...events[1]!, data: { inputTokens: 2 } }]).tokens).toBeNull();
  expect(logEntry([])).toMatchObject({ status: "pending", timestamp: 0, model: "Request", clientIP: "" });
});
