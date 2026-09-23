import { AsyncLocalStorage } from "node:async_hooks"
import assert from "node:assert/strict"

export function liveRequestGuard(fetchImpl: typeof fetch, origin: string, limit: number) {
  assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 100, "Live request limit must be 1–100")
  const scope = new AsyncLocalStorage<{ sent: boolean }>()
  let stopped = false
  let sent = 0
  const guarded = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = scope.getStore()
    const url = new URL(input instanceof Request ? input.url : input)
    assert.ok(!stopped && sent < limit, "Live upstream guard is closed")
    assert.ok(request && !request.sent, "Live request cannot send a second upstream call")
    assert.ok(url.origin === origin && ["/chat/completions", "/responses", "/v1/messages"].includes(url.pathname), "Live request cannot refresh, discover or call another upstream")
    request.sent = true
    sent++
    try {
      const response = await fetchImpl(input, { ...init, redirect: "error" })
      if (!response.ok) stopped = true
      return response
    } catch (error) {
      stopped = true
      throw error
    }
  }, { preconnect: fetchImpl.preconnect }) as typeof fetch
  return { fetch: guarded, run: <T>(callback: () => T): T => scope.run({ sent: false }, callback), count: () => sent }
}
