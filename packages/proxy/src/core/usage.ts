export type UsageProtocol = "openai" | "anthropic" | "responses" | "embeddings"

export interface NormalizedUsage {
  input_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  output_tokens: number | null
  complete: boolean
  usage_present: boolean
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function tokens(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

export function normalizeUsage(protocol: UsageProtocol, value: unknown): NormalizedUsage {
  const usage = object(value)
  const usage_present = value !== null && typeof value === "object" && !Array.isArray(value)
  if (protocol === "anthropic") {
    const input = tokens(usage.input_tokens)
    const output = tokens(usage.output_tokens)
    const read = tokens(usage.cache_read_input_tokens)
    const write = tokens(usage.cache_creation_input_tokens)
    return {
      input_tokens: input,
      cache_read_tokens: read,
      cache_write_tokens: write,
      output_tokens: output,
      complete: input !== null && output !== null && read !== null && write !== null,
      usage_present,
    }
  }
  const responses = protocol === "responses"
  const input = tokens(responses ? usage.input_tokens : usage.prompt_tokens)
  const output = protocol === "embeddings" ? 0 : tokens(responses ? usage.output_tokens : usage.completion_tokens)
  const details = object(responses ? usage.input_tokens_details : usage.prompt_tokens_details)
  const cached = tokens(details.cached_tokens ?? (input === null ? null : 0))
  const read = cached === null ? null : input === null ? cached : Math.min(input, cached)
  return {
    input_tokens: input === null ? null : input - (read ?? 0),
    cache_read_tokens: read,
    cache_write_tokens: input === null ? null : 0,
    output_tokens: output,
    complete: input !== null && output !== null && cached !== null && cached <= input,
    usage_present,
  }
}

export function usageTotal(usage: NormalizedUsage): number {
  return (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0)
    + (usage.cache_write_tokens ?? 0) + (usage.output_tokens ?? 0)
}

export function createUsageCollector(protocol: UsageProtocol, streaming: boolean) {
  let raw: Record<string, unknown> = {}
  let buffer = ""
  let data: string[] = []
  let event = ""
  let terminal = false
  let present = false

  const observe = (value: unknown) => {
    const payload = object(value)
    const candidate = payload.usage ?? object(payload.response).usage ?? object(payload.message).usage
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) present = true
    const usage = object(candidate)
    raw = { ...raw, ...usage }
    if (["message_stop", "response.completed", "response.incomplete", "response.failed"].includes(String(payload.type ?? event))) {
      terminal = true
    }
  }
  const parse = (text: string) => {
    if (text.trim() === "[DONE]") {
      terminal = true
      return
    }
    try { observe(JSON.parse(text)) } catch { /* Malformed output remains the protocol adapter's responsibility. */ }
  }
  const line = (text: string) => {
    if (text === "") {
      if (data.length) parse(data.join("\n"))
      data = []
      event = ""
    } else if (text.startsWith("data:")) {
      data.push(text.slice(5).replace(/^ /, ""))
    } else if (text.startsWith("event:")) {
      event = text.slice(6).replace(/^ /, "")
    }
  }
  const drain = (flush: boolean) => {
    let offset = 0
    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i]
      if (char !== "\r" && char !== "\n") continue
      if (char === "\r" && i === buffer.length - 1 && !flush) break
      line(buffer.slice(offset, i))
      if (char === "\r" && buffer[i + 1] === "\n") i++
      offset = i + 1
    }
    buffer = buffer.slice(offset)
    if (flush) {
      if (buffer) line(buffer)
      buffer = ""
      line("")
    }
  }
  return {
    push(text: string) {
      buffer += text
      if (streaming) drain(false)
    },
    finish(completed: boolean): NormalizedUsage {
      if (streaming) drain(true)
      else parse(buffer)
      const result = normalizeUsage(protocol, raw)
      return { ...result, usage_present: present, complete: result.complete && (streaming ? terminal : completed) }
    },
  }
}
