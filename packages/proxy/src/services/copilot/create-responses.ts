import { events } from "../../util/sse"
import { copilotBaseUrl, copilotHeaders } from "../../lib/api-config"
import { HTTPError } from "../../lib/error"
import { getProxyUrl } from "../../lib/socks5-bridge"
import { state } from "../../lib/state"

export interface ResponsesPayload {
  model: string
  input: unknown
  stream?: boolean
  [key: string]: unknown
}

export const createResponses = async (payload: ResponsesPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = hasVisionContent(payload)
  const isAgentCall = hasAgentHistory(payload)

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const proxyUrl = getProxyUrl("copilot", state)
  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
  } as RequestInit)

  if (!response.ok) {
    throw await HTTPError.fromResponse("Failed to create responses", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return await response.json()
}

export function hasVisionContent(payload: ResponsesPayload): boolean {
  if (!Array.isArray(payload.input)) return false
  return payload.input.some((item: unknown) => {
    if (typeof item !== "object" || item === null) return false
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) return false
    return content.some((part: unknown) => {
      if (typeof part !== "object" || part === null) return false
      return (part as Record<string, unknown>).type === "input_image"
    })
  })
}

export function hasAgentHistory(payload: ResponsesPayload): boolean {
  if (!Array.isArray(payload.input)) return false
  return payload.input.some((item: unknown) => {
    if (typeof item !== "object" || item === null) return false
    const role = (item as Record<string, unknown>).role
    const type = (item as Record<string, unknown>).type
    return role === "assistant" || type === "function_call" || type === "function_call_output"
  })
}
