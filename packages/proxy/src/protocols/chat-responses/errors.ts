/** Pure failure predicate for Responses JSON bodies (non-stream). */

export function isResponsesFailure(body: unknown): boolean {
  if (!body || typeof body !== "object") return false
  const b = body as { status?: unknown; error?: unknown }
  if (b.status === "failed") return true
  return b.error != null
}

export function responsesFailureMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "Responses upstream failed"
  const b = body as { error?: unknown; status?: unknown }
  if (b.error && typeof b.error === "object") {
    const msg = (b.error as { message?: unknown }).message
    if (typeof msg === "string" && msg.length > 0) return msg
  }
  if (typeof b.error === "string" && b.error.length > 0) return b.error
  return `Responses upstream failed (status=${String(b.status ?? "unknown")})`
}
