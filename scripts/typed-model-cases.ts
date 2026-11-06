export type TypedModelKind = "embeddings" | "decisions" | "image" | "completion"

export interface TypedModelCase {
  id: string
  model: string
  kind: TypedModelKind
  declaredPath: string | null
  path: string
  body: Record<string, unknown>
}

const state = "A small code change has not been tested."
const instructions = "Choose the next step."
const criteria = { test: "Run the focused tests.", merge: "Merge without testing." }

function embeddingCase(model: string): TypedModelCase {
  return {
    id: `${model}.embeddings`,
    model,
    kind: "embeddings",
    declaredPath: null,
    path: "/v1/embeddings",
    body: { model, input: ["Raven typed-model probe"] },
  }
}

export const typedModelCases: readonly TypedModelCase[] = [
  embeddingCase("text-embedding-3-small"),
  embeddingCase("text-embedding-3-small-inference"),
  embeddingCase("text-embedding-ada-002"),
  {
    id: "microsoft-decision-1.systemone",
    model: "microsoft-decision-1",
    kind: "decisions",
    declaredPath: "/v1/systemone",
    path: "/v1/systemone",
    body: {
      model: "microsoft-decision-1",
      state,
      questions: { next_step: { type: "choice", instructions, criteria } },
    },
  },
  {
    id: "gpt-6-luna-decisions.decisions",
    model: "gpt-6-luna-decisions",
    kind: "decisions",
    declaredPath: "/v1/decisions",
    path: "/v1/decisions",
    body: {
      model: "gpt-6-luna-decisions",
      input: state,
      questions: [
        {
          name: "next_step",
          instructions,
          type: "choice",
          choices: [
            { value: "test", description: criteria.test },
            { value: "merge", description: criteria.merge },
          ],
        },
      ],
    },
  },
  {
    id: "gpt-image-2.5-flare.image",
    model: "gpt-image-2.5-flare",
    kind: "image",
    declaredPath: "/v1/images/generations",
    path: "/v1/images/generations",
    body: {
      model: "gpt-image-2.5-flare",
      prompt: "A single red circle on a white background.",
      n: 1,
      size: "1024x1024",
    },
  },
  {
    id: "gpt-41-copilot.completion",
    model: "gpt-41-copilot",
    kind: "completion",
    declaredPath: null,
    path: "/v1/completions",
    body: { model: "gpt-41-copilot", prompt: "Reply with OK.", max_tokens: 16 },
  },
]

export function selectTypedModelCases(ids: readonly string[]): readonly TypedModelCase[] {
  for (const id of ids) if (!typedModelCases.some((item) => item.id === id)) throw new Error(`Unknown typed-model case: ${id}`)
  return ids.length ? typedModelCases.filter((item) => ids.includes(item.id)) : typedModelCases
}

export function typedModelReplyError(entry: TypedModelCase, status: number, contentType: string, text: string): string | null {
  if (status < 200 || status >= 300) return `HTTP ${status}`
  if (!contentType.toLowerCase().includes("application/json")) return `Unexpected content type: ${contentType || "none"}`
  let payload: unknown
  try { payload = JSON.parse(text) }
  catch { return "Response is not JSON" }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "Response is not a JSON object"
  const value = payload as Record<string, unknown>
  if (value.error != null) return "Response contains an error object"
  if (entry.kind === "embeddings") {
    const data = value.data
    if (!Array.isArray(data) || data.length === 0) return "Missing embedding data"
    const first = data[0] as Record<string, unknown> | null
    if (!first || !Array.isArray(first.embedding) || first.embedding.length === 0) return "Missing embedding vector"
  } else if (entry.kind === "decisions") {
    const answers = value.answers
    if (!answers || typeof answers !== "object") return "Missing answers"
  } else if (entry.kind === "image") {
    if (!Array.isArray(value.data) || value.data.length === 0) return "Missing image data"
  } else if (!Array.isArray(value.choices) && typeof value.text !== "string") {
    return "Missing completion output"
  }
  return null
}

export interface TypedModelCaseDeps {
  url: string
  key: string
  fetchImpl: typeof fetch
  timeoutMs?: number
}

export interface TypedModelResult {
  id: string
  status: number
  durationMs: number
  error: string | null
  excerpt: string
}

export async function runTypedModelCase(entry: TypedModelCase, deps: TypedModelCaseDeps): Promise<TypedModelResult> {
  const started = performance.now()
  let response: Response
  try {
    response = await deps.fetchImpl(new URL(entry.path, deps.url), {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(entry.body),
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000),
    })
  } catch (error) {
    return {
      id: entry.id,
      status: 0,
      durationMs: Math.round(performance.now() - started),
      error: `transport: ${error instanceof Error ? error.message : String(error)}`,
      excerpt: "",
    }
  }
  const text = (await response.text()).replaceAll(deps.key, "[REDACTED]")
  return {
    id: entry.id,
    status: response.status,
    durationMs: Math.round(performance.now() - started),
    error: typedModelReplyError(entry, response.status, response.headers.get("content-type") ?? "", text),
    excerpt: text.slice(0, 1200),
  }
}
