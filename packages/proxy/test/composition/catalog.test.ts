import { beforeEach, afterEach, expect, test, vi } from "vitest"
import { COPILOT_UPSTREAM_ID } from "../../src/core/routing-types"
import { refreshCatalog, restoreCopilotCatalog, startCopilotCatalogRefresh } from "../../src/composition/catalog"
import { getProviderRecord } from "../../src/db/providers"
import { replaceCatalog } from "../../src/db/catalog"
import { state } from "../../src/lib/state"
import { routingHarness, jsonResponse } from "../helpers/routing"

let h: ReturnType<typeof routingHarness>
let saved: typeof state
let network: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  h = routingHarness()
  saved = { ...state }
  state.copilotToken = "fixture-copilot-token"
  network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"))
})
afterEach(() => { h.close(); Object.assign(state, saved); vi.useRealTimers(); vi.restoreAllMocks() })

test("restores successful Copilot snapshots and treats an uninitialized cache as absent", async () => {
  restoreCopilotCatalog(h.db)
  expect(state.models).toBeNull()
  network.mockResolvedValueOnce(jsonResponse({ data: [{ id: "gpt-5.6-sol", supported_endpoints: ["/responses"] }] }))
  await refreshCatalog(h.db, COPILOT_UPSTREAM_ID, 123)
  expect(state.models?.data[0]).toMatchObject({ id: "gpt-5.6-sol" })
  expect(getProviderRecord(h.db, COPILOT_UPSTREAM_ID)?.last_refreshed_at).toBe(123)
  restoreCopilotCatalog(h.reopen())
  expect(state.models?.data[0]?.id).toBe("gpt-5.6-sol")
})

test("refresh replaces fetched IDs only and deduplicates concurrent refreshes", async () => {
  const upstream = h.upstream({ manual_models: ["manual"] })
  replaceCatalog(h.db, upstream.id, [{ id: "old" }], 1)
  let complete!: (response: Response) => void
  network.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve }))
  const first = refreshCatalog(h.db, upstream.id, 2)
  const second = refreshCatalog(h.db, upstream.id, 3)
  expect(first).toBe(second)
  complete(jsonResponse({ data: [{ id: "new", owner: "a" }, { id: "new", owner: "b" }] }))
  await first
  expect(network).toHaveBeenCalledTimes(1)
  expect(getProviderRecord(h.db, upstream.id)).toMatchObject({ models: [{ id: "new", owner: "a" }], manual_models: ["manual"], last_refreshed_at: 2, last_refresh_error: null })
})

test.each([
  [401, { secret: "never-persist-fixture-secret" }],
  [200, { data: "invalid" }],
  [200, { data: [{ id: "" }] }],
  [200, { data: [null] }],
  [200, null],
])("failed discovery preserves the last good snapshot and sanitizes errors (%s)", async (status, body) => {
  const upstream = h.upstream()
  replaceCatalog(h.db, upstream.id, [{ id: "old" }], 1)
  network.mockResolvedValueOnce(jsonResponse(body, status as number))
  await expect(refreshCatalog(h.db, upstream.id)).rejects.toMatchObject({ type: "catalog_refresh_failed" })
  expect(getProviderRecord(h.db, upstream.id)).toMatchObject({ models: [{ id: "old" }], last_refreshed_at: 1 })
  expect(getProviderRecord(h.db, upstream.id)?.last_refresh_error).not.toContain("never-persist")
  expect(network).toHaveBeenCalledTimes(1)
})

test("network failures retain catalogs and a later explicit refresh can recover", async () => {
  const upstream = h.upstream({ base_url: "https://fixture.invalid///", format: "anthropic_messages" })
  await expect(refreshCatalog(h.db, upstream.id)).rejects.toMatchObject({ status: 503 })
  network.mockResolvedValueOnce(jsonResponse({ data: [] }))
  await refreshCatalog(h.db, upstream.id)
  expect(network.mock.calls[1]?.[0]).toBe("https://fixture.invalid/v1/models")
  expect(network.mock.calls[1]?.[1]).toMatchObject({ headers: { "x-api-key": "fixture-secret", Authorization: "Bearer fixture-secret" } })
  expect(getProviderRecord(h.db, upstream.id)?.last_refresh_error).toBeNull()
  await expect(refreshCatalog(h.db, "missing")).rejects.toMatchObject({ status: 404 })
})

test("the independent Copilot timer does not block startup or retry after a failure", async () => {
  vi.useFakeTimers()
  network.mockRejectedValue(new Error("fixture outage"))
  const stop = startCopilotCatalogRefresh(h.db, 1000)
  expect(network).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(0)
  expect(network).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(999)
  expect(network).toHaveBeenCalledTimes(1)
  network.mockResolvedValue(jsonResponse({ data: [] }))
  await vi.advanceTimersByTimeAsync(1)
  expect(network).toHaveBeenCalledTimes(2)
  stop()
  await vi.advanceTimersByTimeAsync(1000)
  expect(network).toHaveBeenCalledTimes(2)
})

test("an in-progress Copilot timer refresh is never overlapped", async () => {
  vi.useFakeTimers()
  let complete!: (response: Response) => void
  network.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve }))
  const stop = startCopilotCatalogRefresh(h.db, 1000)
  await vi.advanceTimersByTimeAsync(3000)
  expect(network).toHaveBeenCalledTimes(1)
  stop()
  complete(jsonResponse({ data: [] }))
  await vi.advanceTimersByTimeAsync(0)
})
