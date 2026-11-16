import { z } from "zod"
import { ClientInputError } from "../../lib/error"
import type { ChatCompletionsPayload, ContentPart, Message, ToolCall } from "../../upstream/copilot-openai"

const jsonObject = z.record(z.string(), z.json())
const name = z.string().min(1)
const textPart = z.strictObject({ text: z.string(), thought: z.boolean().optional() })
const imagePart = z.strictObject({ inlineData: z.strictObject({
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]),
  data: z.string().min(4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}) })
// Gemini CLI 0.68 injects this marker for unsigned function calls returned by compatible servers.
const callPart = z.strictObject({ functionCall: z.strictObject({ id: name.optional(), name, args: jsonObject.optional() }), thoughtSignature: z.literal("skip_thought_signature_validator").optional() })
const resultPart = z.strictObject({ functionResponse: z.strictObject({ id: name.optional(), name, response: jsonObject }) })
const content = z.strictObject({ role: z.enum(["user", "model"]).optional(), parts: z.array(z.union([textPart, imagePart, callPart, resultPart])).min(1) })
const declaration = z.strictObject({ name, description: z.string().optional(), parameters: jsonObject.optional(), parametersJsonSchema: jsonObject.optional() })
const generationConfig = z.strictObject({
  temperature: z.number().min(0).max(2).optional(), topP: z.number().min(0).max(1).optional(),
  topK: z.null().optional(), candidateCount: z.literal(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(), stopSequences: z.array(z.string()).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(), frequencyPenalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(), responseMimeType: z.enum(["text/plain", "application/json"]).optional(),
  responseSchema: jsonObject.optional(), responseJsonSchema: jsonObject.optional(),
  thinkingConfig: z.strictObject({
    includeThoughts: z.boolean().optional(), thinkingBudget: z.union([z.literal(-1), z.literal(0)]).optional(),
    thinkingLevel: z.enum(["MINIMAL", "LOW", "MEDIUM", "HIGH", "minimal", "low", "medium", "high"]).optional(),
  }).optional(),
})
const request = z.strictObject({
  contents: z.array(content).min(1),
  systemInstruction: z.strictObject({ role: z.string().optional(), parts: z.array(z.strictObject({ text: z.string() })).min(1) }).optional(),
  tools: z.array(z.strictObject({ functionDeclarations: z.array(declaration) })).optional(),
  toolConfig: z.strictObject({ functionCallingConfig: z.strictObject({
    mode: z.enum(["AUTO", "ANY", "NONE", "MODE_UNSPECIFIED"]).optional(), allowedFunctionNames: z.array(name).optional(),
  }) }).optional(),
  generationConfig: generationConfig.optional(),
})

export type GeminiPayload = z.infer<typeof request> & { model: string; stream: boolean }

export function parseGeminiRequest(value: unknown, model: string, stream: boolean): GeminiPayload {
  const parsed = request.safeParse(value)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") || "request"
    throw new ClientInputError(`Unsupported or invalid Gemini field: ${field}`)
  }
  return { ...parsed.data, model, stream }
}

export function parseGeminiTokenRequest(value: unknown, model: string): GeminiPayload {
  const parsed = z.union([request, z.strictObject({ generateContentRequest: request.extend({ model: name }) })]).safeParse(value)
  if (!parsed.success) throw new ClientInputError("Invalid Gemini token-count request")
  if (!("generateContentRequest" in parsed.data)) return { ...parsed.data, model, stream: false }
  const nested = parsed.data.generateContentRequest
  if (nested.model !== model && nested.model !== `models/${model}`) throw new ClientInputError("Token-count model must match the URL")
  return { ...nested, model, stream: false }
}

export function geminiSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ClientInputError("Invalid Gemini schema")
  const value = input as Record<string, unknown>
  const result = { ...value }
  if (typeof value.type === "string") result.type = value.type.toLowerCase()
  if (value.nullable === true && result.type) result.type = [result.type, "null"]
  delete result.nullable
  delete result.propertyOrdering
  if (value.properties !== undefined) {
    if (!value.properties || typeof value.properties !== "object" || Array.isArray(value.properties)) throw new ClientInputError("Invalid Gemini schema properties")
    result.properties = Object.fromEntries(Object.entries(value.properties).map(([key, schema]) => [key, geminiSchema(schema)]))
  }
  if (value.items !== undefined) result.items = geminiSchema(value.items)
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key])) throw new ClientInputError("Invalid Gemini schema alternatives")
      result[key] = value[key].map(geminiSchema)
    }
  }
  return result
}

export function geminiToChat(req: GeminiPayload): ChatCompletionsPayload {
  const messages: Message[] = []
  const pending = new Map<string, ToolCall>()
  const usedIds = new Set<string>()
  if (req.systemInstruction) messages.push({ role: "system", content: req.systemInstruction.parts.map(part => part.text).join("\n") })
  for (const [turn, item] of req.contents.entries()) {
    const assistant = item.role === "model"
    const parts: ContentPart[] = []
    const calls: ToolCall[] = []
    const results: Message[] = []
    for (const [index, part] of item.parts.entries()) {
      if ("text" in part) {
        if (part.thought) {
          if (!assistant) throw new ClientInputError("Thought parts require the model role")
          continue
        }
        parts.push({ type: "text", text: part.text })
      } else if ("inlineData" in part) {
        if (assistant) throw new ClientInputError("Model image output is not supported on Gemini chat conversion")
        parts.push({ type: "image_url", image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` } })
      } else if ("functionCall" in part) {
        if (!assistant) throw new ClientInputError("Function calls require the model role")
        const call = part.functionCall
        const id = call.id ?? `gemini_${turn}_${index}`
        if (usedIds.has(id)) throw new ClientInputError("Duplicate function call ID")
        usedIds.add(id)
        calls.push({ id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })
      } else {
        if (assistant) throw new ClientInputError("Function responses require the user role")
        const result = part.functionResponse
        const matches = [...pending.values()].filter(call => result.id ? call.id === result.id : call.function.name === result.name)
        if (matches.length !== 1 || matches[0]!.function.name !== result.name) throw new ClientInputError("Function response must identify one pending call")
        const call = matches[0]!
        pending.delete(call.id)
        results.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result.response) })
      }
    }
    if (pending.size && (assistant || parts.length)) throw new ClientInputError("Pending function calls need responses before another message")
    messages.push(...results)
    if (parts.length || calls.length) messages.push({
      role: assistant ? "assistant" : "user", content: parts.length ? parts : null,
      ...(calls.length ? { tool_calls: calls } : {}),
    })
    for (const call of calls) pending.set(call.id, call)
  }
  if (pending.size) throw new ClientInputError("Pending function calls need responses")
  if (!messages.some(message => message.role !== "system")) throw new ClientInputError("Gemini contents contain no chat messages")
  const cfg = req.generationConfig ?? {}
  const payload: ChatCompletionsPayload = { model: req.model, messages, stream: req.stream,
    ...(req.stream ? { stream_options: { include_usage: true } } : {}),
  }
  for (const [source, target] of [["temperature", "temperature"], ["topP", "top_p"], ["maxOutputTokens", "max_tokens"], ["presencePenalty", "presence_penalty"], ["frequencyPenalty", "frequency_penalty"], ["seed", "seed"]] as const) {
    if (cfg[source] !== undefined) payload[target] = cfg[source]
  }
  if (cfg.stopSequences) payload.stop = cfg.stopSequences
  const thinking = cfg.thinkingConfig
  if (thinking?.thinkingLevel && thinking.thinkingBudget !== undefined) throw new ClientInputError("Use one thinking control")
  if (thinking?.thinkingLevel) payload.reasoning_effort = thinking.thinkingLevel.toLowerCase() as "minimal" | "low" | "medium" | "high"
  if (thinking?.thinkingBudget === 0) payload.reasoning_effort = "none"
  if (cfg.responseSchema && cfg.responseJsonSchema) throw new ClientInputError("Use one response schema")
  const schema = cfg.responseSchema ?? cfg.responseJsonSchema
  if (schema && cfg.responseMimeType !== "application/json") throw new ClientInputError("A response schema requires application/json")
  if (cfg.responseMimeType === "application/json") payload.response_format = schema
    ? { type: "json_schema", json_schema: { name: "gemini_response", schema: cfg.responseSchema ? geminiSchema(schema) : schema } }
    : { type: "json_object" }
  const declarations = req.tools?.flatMap(tool => tool.functionDeclarations) ?? []
  if (new Set(declarations.map(tool => tool.name)).size !== declarations.length) throw new ClientInputError("Duplicate function declaration")
  if (declarations.length) payload.tools = declarations.map(tool => {
    if (tool.parameters && tool.parametersJsonSchema) throw new ClientInputError("Use one function parameter schema")
    return { type: "function", function: { name: tool.name, description: tool.description ?? null,
      parameters: tool.parametersJsonSchema ?? (tool.parameters ? geminiSchema(tool.parameters) : { type: "object", properties: {} }),
    } }
  })
  const choice = req.toolConfig?.functionCallingConfig
  if (choice) {
    const allowed = choice.allowedFunctionNames ?? []
    if (allowed.some(name => !declarations.some(tool => tool.name === name))) throw new ClientInputError("Allowed functions must be declared")
    if (allowed.length && choice.mode !== "ANY") throw new ClientInputError("Allowed functions require ANY mode")
    if (choice.mode === "ANY") {
      if (!declarations.length) throw new ClientInputError("ANY mode requires functions")
      if (allowed.length) payload.tools = payload.tools!.filter(tool => allowed.includes(tool.function.name))
      payload.tool_choice = allowed.length === 1 ? { type: "function", function: { name: allowed[0]! } } : "required"
    } else if (choice.mode === "NONE") payload.tool_choice = "none"
    else payload.tool_choice = "auto"
  }
  return payload
}
