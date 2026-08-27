import type { ResponsesPayload } from "../../upstream/copilot-responses"

/** gpt-5, gpt-5.4, gpt-5-mini — not gpt-50 / gpt-5chat. */
const GPT5_FAMILY = /^gpt-5(?:$|[.-])/

function gpt5FamilyId(model: unknown): string | null {
  if (typeof model !== "string") return null
  const id = model.split("/").pop() ?? model
  return GPT5_FAMILY.test(id) ? id : null
}

function reasoningEffort(reasoning: unknown): unknown {
  if (typeof reasoning !== "object" || reasoning === null) return undefined
  return (reasoning as { effort?: unknown }).effort
}

function keepTemperature(value: unknown, effort: unknown): boolean {
  if (effort === "none") return true
  return value === 1
}

function keepTopP(_value: unknown, effort: unknown): boolean {
  return effort === "none"
}

/**
 * Drop Copilot-Responses sampling fields that GPT-5 reasoning mode rejects.
 * Total: never throws; unknown model / malformed reasoning → no-op or treat effort as omitted.
 */
export function sanitizeCopilotResponsesSampling(
  payload: ResponsesPayload,
): ResponsesPayload {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload
  }
  if (!gpt5FamilyId(payload.model)) return payload

  const effort = reasoningEffort(payload.reasoning)
  const dropTemperature =
    payload.temperature !== undefined && !keepTemperature(payload.temperature, effort)
  const dropTopP =
    payload.top_p !== undefined && !keepTopP(payload.top_p, effort)
  if (!dropTemperature && !dropTopP) return payload

  const next = { ...payload }
  if (dropTemperature) delete next.temperature
  if (dropTopP) delete next.top_p
  return next
}
