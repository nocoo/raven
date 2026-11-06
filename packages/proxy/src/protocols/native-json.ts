export interface NativeJsonPayload {
  model: string
  [key: string]: unknown
}

export type ImageEndpoint = "/v1/images/generations" | "/v1/images/edits"

export function parseImageEdits(form: FormData): NativeJsonPayload {
  const models = form.getAll("model")
  if (models.length !== 1 || typeof models[0] !== "string" || !models[0].trim()) {
    throw new Error("Image edits requires one model")
  }
  const prompts = form.getAll("prompt")
  if (prompts.length !== 1 || typeof prompts[0] !== "string" || !prompts[0].trim()) {
    throw new Error("Image edits requires one prompt")
  }
  const images = [...form.getAll("image"), ...form.getAll("image[]")]
  if (!images.length || images.some(image => typeof image === "string" || !image.size)) {
    throw new Error("Image edits requires uploaded image or image[] files")
  }
  if (form.getAll("stream").some(stream => stream !== "false")) {
    throw new Error("Raven image edits supports non-streaming multipart only")
  }
  return { model: models[0], form }
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
