import type { LogEvent } from "@/hooks/use-log-stream";
import { groupEvents } from "@/app/logs/group-events";
import { logProtocol } from "./log-protocol";

export function logEntry(events: LogEvent[]) {
  const first = events[0];
  const start = events.find(event => event.type === "request_start");
  const end = events.findLast(event => event.type === "request_end");
  const data = { ...first?.data, ...start?.data, ...end?.data };
  const text = (key: string) => typeof data[key] === "string" ? data[key] : "";
  const number = (key: string) => typeof data[key] === "number" ? data[key] : null;
  const system = !!first && !first.requestId;
  const input = number("inputTokens"), output = number("outputTokens");
  return {
    data, system, timestamp: start?.ts ?? first?.ts ?? 0, requestId: first?.requestId ?? null,
    status: system ? first.level : text("status") || "pending",
    model: system ? first.msg : text("model") || "Request",
    resolvedModel: text("resolvedModel"), path: system ? "System" : text("path"),
    clientIP: text("clientIP"), account: text("accountName"), error: text("error"),
    latencyMs: number("latencyMs"), tokens: input !== null && output !== null ? input + output : null,
    protocol: logProtocol(data, !!end),
  };
}

export function filterLogGroups(events: LogEvent[], search: string) {
  const query = search.trim().toLowerCase();
  return groupEvents(events).filter(group => !query || group.events.some(event => [event.msg, event.requestId, ...["model", "resolvedModel", "accountName", "clientIP", "path"].map(key => event.data?.[key])].some(value => typeof value === "string" && value.toLowerCase().includes(query))));
}
