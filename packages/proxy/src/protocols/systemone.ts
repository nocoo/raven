export interface SystemonePayload {
  model: string
  state: unknown
  questions: Record<string, Record<string, unknown>>
  stream?: false
  [key: string]: unknown
}

export class SystemoneUpstreamError extends Error {
  override name = "SystemoneUpstreamError"
}

export function parseSystemoneJson(text: string): SystemonePayload {
  // Bun supports source-preserving JSON; the installed TypeScript lib omits its types.
  const json = JSON as typeof JSON & {
    rawJSON(source: string): unknown
    parse(text: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown): unknown
  }
  return json.parse(text, (_key: string, value: unknown, context: { source?: string }) =>
    typeof value === "number" ? json.rawJSON(context.source!) : value) as SystemonePayload
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function systemoneInputError(value: Record<string, unknown>): string | null {
  if (value.stream !== undefined && value.stream !== false) return "Raven systemone supports non-streaming JSON only"
  if (!Object.hasOwn(value, "state")) return "Systemone requires state"
  if (!isRecord(value.questions) || Object.keys(value.questions).length === 0) return "Systemone requires a non-empty questions object"
  if (Object.values(value.questions).some(question => !isRecord(question) || typeof question.type !== "string" || !question.type)) {
    return "Each systemone question requires a type"
  }
  return null
}

export function systemoneFailed(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.error != null) return true
  const answers = value.answers
  return (Array.isArray(answers) ? answers : isRecord(answers) ? Object.values(answers) : [])
    .some(answer => isRecord(answer) && answer.type === "refusal")
}
