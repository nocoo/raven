export function isInlineStreamError(event: string | null, parsed?: unknown): boolean {
  if (event === "error" || event === "response.failed") return true
  if (!parsed || typeof parsed !== "object") return false
  const data = parsed as { type?: unknown; error?: unknown }
  return data.type === "error" || data.type === "response.failed" || data.error != null
}
