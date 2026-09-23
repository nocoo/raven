import { describe, expect, test, vi } from "vitest"
import { liveRequestGuard } from "../live-proxy-guard"

const origin = "https://fixture.invalid"
const url = `${origin}/chat/completions`
const fakeFetch = () => vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true }))

describe("live upstream send guard", () => {
  test.each([0, -1, 101, 1.5, NaN])("rejects invalid budget %s", limit => {
    expect(() => liveRequestGuard(fakeFetch(), origin, limit)).toThrow("limit")
  })

  test("allows one actual send in each async request and prevents local replay", async () => {
    const fetcher = fakeFetch()
    const guard = liveRequestGuard(fetcher, origin, 2)
    await guard.run(async () => {
      expect((await guard.fetch(url, { method: "POST", body: "{}" })).ok).toBe(true)
      await expect(guard.fetch(url)).rejects.toThrow("second upstream")
    })
    await guard.run(() => guard.fetch(new Request(`${origin}/responses`, { method: "POST" })))
    expect(guard.count()).toBe(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", method: "POST", body: "{}" })
    await expect(guard.run(() => guard.fetch(url))).rejects.toThrow("closed")
  })

  test("blocks out-of-request HTTP, discovery, refresh and other providers before sending", async () => {
    const fetcher = fakeFetch()
    const guard = liveRequestGuard(fetcher, origin, 2)
    await expect(guard.fetch(url)).rejects.toThrow("second upstream")
    for (const destination of [`${origin}/models`, "https://api.github.com/copilot_internal/v2/token", "https://other.invalid/chat/completions"]) {
      await expect(guard.run(() => guard.fetch(destination))).rejects.toThrow("cannot refresh")
    }
    expect(fetcher).not.toHaveBeenCalled()
    await guard.run(() => guard.fetch(new URL(`${origin}/v1/messages`)))
    expect(guard.count()).toBe(1)
  })

  test.each(["http", "network"])("closes after the first %s error without any retry", async kind => {
    const fetcher = fakeFetch()
    if (kind === "http") fetcher.mockResolvedValueOnce(new Response("fixture refusal", { status: 401 }))
    else fetcher.mockRejectedValueOnce(new Error("fixture network failure"))
    const guard = liveRequestGuard(fetcher, origin, 5)
    if (kind === "http") expect((await guard.run(() => guard.fetch(url))).status).toBe(401)
    else await expect(guard.run(() => guard.fetch(url))).rejects.toThrow("fixture network failure")
    await expect(guard.run(() => guard.fetch(url))).rejects.toThrow("closed")
    expect(fetcher).toHaveBeenCalledOnce()
    expect(guard.count()).toBe(1)
  })
})
