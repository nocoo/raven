export interface NativeJsonPayload {
  model: string
  [key: string]: unknown
}

export function parseNativeJson(text: string): NativeJsonPayload {
  const json = JSON as typeof JSON & {
    rawJSON(source: string): unknown
    parse(text: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown): unknown
  }
  return json.parse(text, (_key: string, value: unknown, context: { source?: string }) =>
    typeof value === "number" ? json.rawJSON(context.source!) : value) as NativeJsonPayload
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function decisionsInputError(value: Record<string, unknown>): string | null {
  if (value.stream !== undefined && value.stream !== false) return "Raven decisions supports non-streaming JSON only"
  if (!Object.hasOwn(value, "input")) return "Decisions requires input"
  if (!Array.isArray(value.questions) || value.questions.length === 0) return "Decisions requires a non-empty questions array"
  if (value.questions.some(question => !isRecord(question)
    || typeof question.name !== "string" || !question.name
    || typeof question.type !== "string" || !question.type)) {
    return "Each decision question requires name and type"
  }
  return null
}

export function imagesInputError(value: Record<string, unknown>): string | null {
  if (value.stream !== undefined && value.stream !== false) return "Raven images generations supports non-streaming JSON only"
  if (typeof value.prompt !== "string" || !value.prompt.trim()) return "Image generations requires a prompt"
  return null
}

export function nativeJsonError(value: unknown): boolean {
  return isRecord(value) && value.error != null
}

export function decisionsFailed(value: unknown): boolean {
  if (nativeJsonError(value) || !isRecord(value)) return nativeJsonError(value)
  const answers = value.answers
  const entries = Array.isArray(answers) ? answers : isRecord(answers) ? Object.values(answers) : []
  return entries.some(answer => isRecord(answer) && answer.type === "refusal")
}
