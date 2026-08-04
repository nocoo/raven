// ---------------------------------------------------------------------------
// strategies/copilot-responses.ts — Responses API passthrough with Codex
// MCP namespace-tool flattening / restoration.
// ---------------------------------------------------------------------------

import type { SSEMessage } from "hono/streaming"

import type { Strategy } from "../core/strategy"
import type { ServerSentEvent } from "../util/sse"
import { emitUpstreamRawSse } from "../util/emit-upstream-raw"
import type {
  CopilotResponsesClient,
  ResponsesPayload,
} from "../upstream/copilot-responses"
import {
  extractNonStreamingMeta,
  extractResolvedModel,
  extractUsage,
  isTerminalResponseEvent,
} from "../protocols/responses/stream-state"

export interface CopilotResponsesDeps {
  client: CopilotResponsesClient
}

export interface CopilotResponsesStreamState {
  resolvedModel: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  namespaceToolMapping?: NamespaceToolMapping
}

type NamespaceToolMapping = Map<string, { namespace: string; name: string }>

// Keyed by the object identity of the prepared request returned from prepare().
// Runner preserves this identity through dispatch → adaptJson / initStreamState.
const namespaceToolMappings = new WeakMap<ResponsesPayload, NamespaceToolMapping>()

const MAX_REWRITE_DEPTH = 20

export const COPILOT_SUPPORTED_TOOL_TYPES: ReadonlySet<string> = new Set([
  "function",
  "web_search_preview",
])

function prepareResponsesTools(req: ResponsesPayload): ResponsesPayload {
  const tools = (req as { tools?: unknown }).tools
  const namespaceMapping: NamespaceToolMapping = new Map()

  let filteredTools: unknown[] | undefined
  let toolsChanged = false
  if (Array.isArray(tools)) {
    const filtered: unknown[] = []
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i]
      if (typeof tool !== "object" || tool === null) {
        toolsChanged = true
        continue
      }

      const toolType = (tool as { type?: unknown }).type
      if (toolType === "namespace") {
        toolsChanged = true
        flattenNamespaceTool(tool as Record<string, unknown>, filtered, namespaceMapping)
        continue
      }

      if (typeof toolType === "string" && COPILOT_SUPPORTED_TOOL_TYPES.has(toolType)) {
        filtered.push(tool)
      } else {
        toolsChanged = true
      }
    }

    if (toolsChanged && filtered.length > 0) filteredTools = filtered
  }

  const input = req.input
  const rewrittenInput = flattenNamespacedInputFunctionCalls(input, namespaceMapping)
  const inputChanged = rewrittenInput !== input

  if (!toolsChanged && !inputChanged) return req

  if (toolsChanged && filteredTools === undefined) {
    const { tools: _omit, ...rest } = req as Record<string, unknown>
    const prepared = {
      ...rest,
      ...(inputChanged ? { input: rewrittenInput } : {}),
    } as ResponsesPayload
    if (namespaceMapping.size > 0) namespaceToolMappings.set(prepared, namespaceMapping)
    return prepared
  }

  const prepared = {
    ...req,
    ...(inputChanged ? { input: rewrittenInput } : {}),
    ...(filteredTools ? { tools: filteredTools } : {}),
  } as ResponsesPayload
  if (namespaceMapping.size > 0) namespaceToolMappings.set(prepared, namespaceMapping)
  return prepared
}

function flattenNamespaceTool(
  tool: Record<string, unknown>,
  out: unknown[],
  mapping: NamespaceToolMapping,
): void {
  const namespace = tool.name
  const children = tool.tools
  if (typeof namespace !== "string" || !Array.isArray(children)) return

  for (const child of children) {
    if (typeof child !== "object" || child === null) continue
    const childTool = child as Record<string, unknown>
    if (childTool.type !== "function" || typeof childTool.name !== "string") continue

    const flatName = `${namespace}${childTool.name}`
    out.push({ ...childTool, name: flatName })
    mapping.set(flatName, { namespace, name: childTool.name })
  }
}

function flattenNamespacedInputFunctionCalls(
  value: unknown,
  mapping: NamespaceToolMapping,
  depth = 0,
): unknown {
  if (depth > MAX_REWRITE_DEPTH) return value

  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const rewritten = flattenNamespacedInputFunctionCalls(item, mapping, depth + 1)
      if (rewritten !== item) changed = true
      return rewritten
    })
    return changed ? next : value
  }

  if (typeof value !== "object" || value === null) return value

  const record = value as Record<string, unknown>
  const namespace = record.namespace
  const name = record.name
  const flatName = record.type === "function_call"
    && typeof namespace === "string"
    && typeof name === "string"
    ? flattenNamespacedFunctionName(namespace, name, mapping)
    : undefined

  let changed = false
  let next: Record<string, unknown> = record
  if (flatName) {
    const { namespace: _omit, ...rest } = record
    next = { ...rest, name: flatName }
    changed = true
  }

  for (const [key, child] of Object.entries(next)) {
    const rewritten = flattenNamespacedInputFunctionCalls(child, mapping, depth + 1)
    if (rewritten !== child) {
      if (!changed) {
        next = { ...next }
        changed = true
      }
      next[key] = rewritten
    }
  }

  return changed ? next : value
}

function flattenNamespacedFunctionName(
  namespace: string,
  name: string,
  mapping: NamespaceToolMapping,
): string {
  for (const [flatName, mapped] of mapping) {
    if (mapped.namespace === namespace && mapped.name === name) return flatName
  }

  if (name.startsWith(namespace)) return name
  return `${namespace}${name}`
}

function restoreNamespacedFunctionCalls(
  value: unknown,
  mapping: NamespaceToolMapping | undefined,
): unknown {
  if (!mapping || mapping.size === 0) return value
  return rewriteNamespacedFunctionCalls(value, mapping)
}

function rewriteNamespacedFunctionCalls(
  value: unknown,
  mapping: NamespaceToolMapping,
  depth = 0,
): unknown {
  if (depth > MAX_REWRITE_DEPTH) return value

  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const rewritten = rewriteNamespacedFunctionCalls(item, mapping, depth + 1)
      if (rewritten !== item) changed = true
      return rewritten
    })
    return changed ? next : value
  }

  if (typeof value !== "object" || value === null) return value

  const record = value as Record<string, unknown>
  const mapped = record.type === "function_call" && typeof record.name === "string"
    ? mapping.get(record.name)
    : undefined

  let changed = false
  let next: Record<string, unknown> = record
  if (mapped) {
    next = { ...record, name: mapped.name, namespace: mapped.namespace }
    changed = true
  }

  for (const [key, child] of Object.entries(next)) {
    const rewritten = rewriteNamespacedFunctionCalls(child, mapping, depth + 1)
    if (rewritten !== child) {
      if (!changed) {
        next = { ...next }
        changed = true
      }
      next[key] = rewritten
    }
  }

  return changed ? next : value
}

function restoreNamespacedFunctionCallData(
  data: string,
  mapping: NamespaceToolMapping | undefined,
): string {
  if (!mapping || mapping.size === 0) return data
  try {
    const parsed = JSON.parse(data) as unknown
    const rewritten = restoreNamespacedFunctionCalls(parsed, mapping)
    return rewritten === parsed ? data : JSON.stringify(rewritten)
  } catch {
    return data
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value) && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
}

export function makeCopilotResponses(deps: CopilotResponsesDeps): Strategy<
  ResponsesPayload,
  ResponsesPayload,
  unknown,
  unknown,
  ServerSentEvent,
  SSEMessage,
  CopilotResponsesStreamState
> {
  return {
    name: "copilot-responses",

    prepare: (req) => prepareResponsesTools(req),

    dispatch: async (up) => {
      const response = await deps.client.send(up)
      if (up.stream && isAsyncIterable<ServerSentEvent>(response)) {
        return { kind: "stream", chunks: response }
      }
      return { kind: "json", body: response }
    },

    adaptJson: (resp, req) => restoreNamespacedFunctionCalls(
      resp,
      namespaceToolMappings.get(req),
    ),

    initStreamState: (req) => {
      const namespaceToolMapping = namespaceToolMappings.get(req)
      return {
        resolvedModel: req.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        ...(namespaceToolMapping ? { namespaceToolMapping } : {}),
      }
    },

    adaptChunk: (chunk, st, ctx) => {
      emitUpstreamRawSse(ctx.requestId, { event: chunk.event, data: chunk.data })

      if (chunk.event === "response.created") {
        const m = extractResolvedModel(chunk.data)
        if (m) st.resolvedModel = m
      }

      if (isTerminalResponseEvent(chunk.event)) {
        const usage = extractUsage(chunk.data)
        if (usage) {
          st.inputTokens = usage.inputTokens
          st.outputTokens = usage.outputTokens
          st.cacheReadTokens = usage.cachedInputTokens
        }
      }

      const data = restoreNamespacedFunctionCallData(chunk.data, st.namespaceToolMapping)
      const sseMsg: SSEMessage = { data }
      if (chunk.event) sseMsg.event = chunk.event
      if (chunk.id) sseMsg.id = chunk.id
      if (chunk.retry !== null) sseMsg.retry = chunk.retry
      return [sseMsg]
    },

    adaptStreamError: () => [{
      event: "error",
      data: JSON.stringify({
        error: {
          type: "server_error",
          code: "stream_error",
          message: "An upstream error occurred during streaming.",
        },
      }),
    }],

    describeEndLog: (result) => {
      if (result.kind === "json") {
        const meta = extractNonStreamingMeta(result.resp, result.req.model)
        return {
          model: result.req.model,
          resolvedModel: meta.resolvedModel,
          inputTokens: meta.inputTokens,
          outputTokens: meta.outputTokens,
          cacheReadTokens: meta.cachedInputTokens,
        }
      }
      if (result.kind === "stream") {
        return {
          model: result.req.model,
          resolvedModel: result.state.resolvedModel,
          inputTokens: result.state.inputTokens,
          outputTokens: result.state.outputTokens,
          cacheReadTokens: result.state.cacheReadTokens,
        }
      }
      if (result.kind === "error") {
        return {
          model: result.req.model,
        }
      }
      return {}
    },
  }
}
