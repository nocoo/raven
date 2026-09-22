import type { Database } from "bun:sqlite"
import { insertRequest, type RequestRecord } from "../../../packages/proxy/src/db/requests"
import { settleQuota } from "../../../packages/proxy/src/db/quota"
import type { RequestRoutingDetails } from "../../../packages/proxy/src/core/routing-log"
import type { LiveCase, LiveProtocol } from "../live-proxy-cases"
import type { LiveFrame } from "../live-proxy-wire"

type Wire = Record<string, unknown>

export function fixtureJson(item: LiveCase) {
  const tool = item.kind === "tool"
  const text = tool ? "" : item.marker
  const args = JSON.stringify({ text: item.marker })
  const model = "upstream-echo-model"
  if (item.protocol === "chat") return {
    id: "chat_fixture", object: "chat.completion", model,
    choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop", message: { role: "assistant", content: tool ? null : text, ...(tool ? { tool_calls: [{ id: "call_echo", type: "function", function: { name: "echo", arguments: args } }] } : {}) } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  }
  if (item.protocol === "messages") return {
    id: "msg_fixture", type: "message", role: "assistant", model,
    content: tool ? [{ type: "tool_use", id: "call_echo", name: "echo", input: { text: item.marker } }] : [{ type: "text", text }],
    stop_reason: tool ? "tool_use" : "end_turn", usage: { input_tokens: 6, cache_read_input_tokens: 4, output_tokens: 2 },
  }
  return {
    id: "resp_fixture", object: "response", model, status: "completed",
    output: tool ? [{ type: "function_call", call_id: "call_echo", name: "echo", arguments: args }]
      : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  }
}

export function frame(protocol: LiveProtocol, value: Wire | string): LiveFrame {
  return typeof value === "string" ? { event: null, data: value } : { event: protocol === "chat" ? null : String(value.type), data: JSON.stringify(value) }
}

export function fixtureFrames(item: LiveCase): LiveFrame[] {
  const json = fixtureJson(item)
  const tool = item.kind === "tool"
  const args = JSON.stringify({ text: item.marker })
  let values: (Wire | string)[]
  if (item.protocol === "chat") {
    const chunk = (delta: Wire, finish_reason: string | null = null) => ({ id: json.id, object: "chat.completion.chunk", model: json.model, choices: [{ index: 0, delta, finish_reason }] })
    values = [
      chunk({ role: "assistant", content: null }),
      ...(tool ? [
        chunk({ tool_calls: [{ index: 0, id: "call_echo", function: { name: "e", arguments: args.slice(0, 5) } }] }),
        chunk({ tool_calls: [{ index: 0, function: { name: "cho" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] }),
      ] : [chunk({ content: item.marker.slice(0, 5) }), chunk({ content: item.marker.slice(5) })]),
      chunk({}, tool ? "tool_calls" : "stop"),
      { id: json.id, object: "chat.completion.chunk", model: json.model, choices: [], usage: json.usage },
      "[DONE]",
    ]
  } else if (item.protocol === "messages") {
    values = [
      { type: "ping" },
      { type: "message_start", message: { ...json, content: [], stop_reason: null, usage: { ...json.usage, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Synthetic reasoning." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: tool ? { type: "tool_use", id: "call_echo", name: "echo", input: {} } : { type: "text", text: item.marker.slice(0, 5) } },
      ...(tool ? [
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: args.slice(0, 5) } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: args.slice(5) } },
      ] : [{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: item.marker.slice(5) } }]),
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: null } },
      { type: "message_delta", delta: { stop_reason: json.stop_reason }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]
  } else {
    values = [
      { type: "response.created", response: { ...json, status: "in_progress", output: [] } },
      { type: "response.in_progress", response: { ...json, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: tool ? { ...json.output![0], arguments: "" } : { ...json.output![0], content: [] } },
      ...(tool ? [
        { type: "response.function_call_arguments.delta", output_index: 0, delta: args.slice(0, 5) },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: args.slice(5) },
        { type: "response.function_call_arguments.done", output_index: 0, arguments: args },
      ] : [
        { type: "response.output_text.delta", output_index: 0, delta: item.marker.slice(0, 5) },
        { type: "response.output_text.delta", output_index: 0, delta: item.marker.slice(5) },
        { type: "response.output_text.done", output_index: 0, text: item.marker },
      ]),
      { type: "response.completed", response: json },
    ]
  }
  return values.map((value) => frame(item.protocol, value))
}

export function fixtureSse(item: LiveCase): string {
  return fixtureFrames(item).map((entry) => `${entry.event ? `event: ${entry.event}\r\n` : ""}data: ${entry.data}\r\n\r\n`).join("")
}

export function seedTelemetry(db: Database, item: LiveCase, keyId: string, clientName: string, overrides: Partial<RequestRecord> = {}) {
  const id = crypto.randomUUID()
  const captured_at = Date.now()
  const routing: RequestRoutingDetails = {
    requested_model: item.model, resolved_model: item.resolvedModel, rule_id: "builtin:copilot", period_id: null,
    upstream_id: "builtin:copilot", upstream_name: "GitHub Copilot", quota_window_id: null,
    multiplier: 1, weighted_tokens: 12, usage_complete: true, accounting_healthy: true,
    admitted_at: captured_at, skipped: [], diagnostic: false,
  }
  const record: RequestRecord = {
    id, timestamp: captured_at, path: item.path, client_format: item.clientFormat,
    model: item.model, resolved_model: "upstream-echo-model", stream: Number(item.stream),
    input_tokens: 6, cache_read_tokens: 4, cache_write_tokens: 0, output_tokens: 2,
    latency_ms: 1, ttft_ms: null, status: "success", status_code: 200, upstream_status: 200,
    error_message: null, account_name: "fixture", api_key_id: keyId, session_id: "fixture",
    client_name: clientName, client_version: null, processing_ms: null, strategy: item.strategy,
    upstream: "GitHub Copilot", upstream_format: item.upstreamFormat, translated_model: "", copilot_model: "",
    routing_path: "fixture", stop_reason: "stop", tool_call_count: Number(item.kind === "tool"), server_tools_used: 0,
    routing_details: JSON.stringify(routing), ...overrides,
  }
  insertRequest(db, record)
  settleQuota(db, {
    request_id: record.id, attempt_ordinal: 0,
    capture: { upstream_id: "builtin:copilot", window_id: null, multiplier: 1, captured_at },
    usage: { input_tokens: 6, cache_read_tokens: 4, cache_write_tokens: 0, output_tokens: 2, complete: true, usage_present: true },
  })
  return record.id
}
