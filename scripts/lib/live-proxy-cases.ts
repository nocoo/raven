import type { ClientProtocol, StrategyName } from "../../packages/proxy/src/core/router"

export type LiveProtocol = "chat" | "messages" | "responses"
export type LiveKind = "text" | "tool" | "continuation"

export interface LiveCase {
  id: string
  model: string
  resolvedModel: string
  protocol: LiveProtocol
  stream: boolean
  kind: LiveKind
  marker: string
  path: string
  clientFormat: ClientProtocol
  upstreamFormat: ClientProtocol
  strategy: StrategyName
  body: Record<string, unknown>
}

const models = ["gemini-3.8-flash", "grok-4.5", "gpt-5.6-sol", "claude-opus-5.5"]
const protocols: LiveProtocol[] = ["chat", "responses", "messages"]
const paths = { chat: "/v1/chat/completions", messages: "/v1/messages", responses: "/v1/responses" }
const clientFormats = { chat: "openai", messages: "anthropic", responses: "responses" } as const

function makeCase(model: string, protocol: LiveProtocol, kind: LiveKind, stream: boolean): LiveCase {
  const resolvedModel = model === "auto" ? "gpt-5.6-sol" : model
  const upstreamFormat = resolvedModel === "claude-opus-5.5"
    ? protocol === "messages" ? "anthropic" : "openai"
    : resolvedModel === "gemini-3.8-flash" ? "openai" : "responses"
  const strategy: StrategyName = protocol === "chat"
    ? upstreamFormat === "openai" ? "copilot-openai-direct" : "copilot-chat-via-responses"
    : protocol === "messages"
      ? upstreamFormat === "anthropic" ? "copilot-native" : upstreamFormat === "openai" ? "copilot-translated" : "protocol-converted"
      : upstreamFormat === "responses" ? "copilot-responses" : "protocol-converted"
  const id = `${model}.${protocol}.${kind}.${stream ? "sse" : "json"}`
  const marker = `RAVEN_${id.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`
  const prompt = kind === "tool"
    ? `Call echo exactly once with text equal to ${marker}. Do not answer in prose.`
    : kind === "continuation"
      ? "The echo tool has already returned. Reply only with its returned text. Do not call any tools."
      : `Reply with exactly ${marker}. Do not add any other text.`
  const parameters = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }
  const definition = { name: "echo", description: "Return the supplied text unchanged.", parameters }
  const argumentsText = JSON.stringify({ text: marker })
  const callId = "call_raven_echo"
  let body: Record<string, unknown>
  if (protocol === "chat") {
    body = {
      model, stream, max_tokens: 1024,
      messages: kind === "continuation" ? [
        { role: "user", content: "Call echo and report its result." },
        { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "echo", arguments: argumentsText } }] },
        { role: "tool", tool_call_id: callId, content: marker },
        { role: "user", content: prompt },
      ] : [{ role: "user", content: prompt }],
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(kind === "text" ? {} : { tools: [{ type: "function", function: definition }] }),
      ...(kind === "tool" ? { tool_choice: model === "claude-opus-5.5" ? "auto" : { type: "function", function: { name: "echo" } } } : {}),
    }
  } else if (protocol === "messages") {
    body = {
      model, stream, max_tokens: 1024,
      messages: kind === "continuation" ? [
        { role: "user", content: "Call echo and report its result." },
        { role: "assistant", content: [{ type: "tool_use", id: callId, name: "echo", input: { text: marker } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: marker }, { type: "text", text: prompt }] },
      ] : [{ role: "user", content: prompt }],
      ...(kind === "text" ? {} : { tools: [{ name: definition.name, description: definition.description, input_schema: parameters }] }),
      ...(kind === "tool" ? { tool_choice: model === "claude-opus-5.5" ? { type: "auto" } : { type: "tool", name: "echo" } } : {}),
    }
  } else {
    body = {
      model, stream, max_output_tokens: 1024,
      input: kind === "continuation" ? [
        { role: "user", content: "Call echo and report its result." },
        { type: "function_call", call_id: callId, name: "echo", arguments: argumentsText },
        { type: "function_call_output", call_id: callId, output: marker },
        { role: "user", content: prompt },
      ] : [{ role: "user", content: prompt }],
      ...(kind === "text" ? {} : { tools: [{ type: "function", ...definition }] }),
      ...(kind === "tool" ? { tool_choice: model === "claude-opus-5.5" ? "auto" : { type: "function", name: "echo" } } : {}),
    }
  }
  return { id, model, resolvedModel, protocol, stream, kind, marker, path: paths[protocol], clientFormat: clientFormats[protocol], upstreamFormat, strategy, body }
}

const textCases = models.flatMap((model) => protocols.flatMap((protocol) => [false, true].map((stream) => makeCase(model, protocol, "text", stream))))

export const liveCases: readonly LiveCase[] = [
  ...textCases.filter((item) => item.clientFormat === item.upstreamFormat),
  ...textCases.filter((item) => item.clientFormat !== item.upstreamFormat),
  ...protocols.flatMap((protocol) => [false, true].map((stream) => makeCase("auto", protocol, "text", stream))),
  ...models.flatMap((model) => protocols.flatMap((protocol) => [false, true].map((stream) => makeCase(model, protocol, "tool", stream)))),
  ...models.flatMap((model) => protocols.map((protocol) => makeCase(model, protocol, "continuation", false))),
]

export function selectLiveCases(ids: readonly string[]): readonly LiveCase[] {
  for (const id of ids) if (!liveCases.some((item) => item.id === id)) throw new Error(`Unknown live case: ${id}`)
  return ids.length ? liveCases.filter((item) => ids.includes(item.id)) : liveCases
}
