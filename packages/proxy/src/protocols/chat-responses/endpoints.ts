/**
 * Pure endpoint classifiers for catalog-driven chat↔responses routing.
 * No I/O, no state — safe for pickStrategy and unit tests.
 */

export function isChatEndpoint(ep: string): boolean {
  return ep === "/chat/completions" || ep === "/v1/chat/completions"
}

export function isResponsesEndpoint(ep: string): boolean {
  return ep === "/responses" || ep === "/v1/responses"
}

/**
 * True when the model exposes HTTP Responses but not Chat Completions.
 * Empty/missing endpoints → false (legacy Azure / unknown → keep chat path).
 * `ws:/responses` alone does not count as HTTP responses support.
 */
export function isResponsesOnly(endpoints: string[] | undefined | null): boolean {
  if (!endpoints || endpoints.length === 0) return false
  const hasChat = endpoints.some(isChatEndpoint)
  const hasResponses = endpoints.some(isResponsesEndpoint)
  return hasResponses && !hasChat
}
