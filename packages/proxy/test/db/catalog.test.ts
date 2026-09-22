import type { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { COPILOT_UPSTREAM_ID } from "../../src/core/routing-types.ts"
import { getCatalog, projectCatalog, recordCatalogError, replaceCatalog } from "../../src/db/catalog.ts"
import { createProvider, deleteProvider, getProvider, updateProvider } from "../../src/db/providers.ts"
import { NOW, providerInput, routingFixture } from "./routing-fixture.ts"

let fixture: ReturnType<typeof routingFixture>
let db: Database
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  fixture = routingFixture()
  db = fixture.db
})
afterEach(() => { fixture.close(); vi.useRealTimers() })

describe("durable raw model catalogs", () => {
  test("keeps fetched metadata and manual IDs separate across successful replacement and reopen", () => {
    const provider = createProvider(db, providerInput({ manual_models: ["typed", "shared", "auto"] }))
    replaceCatalog(db, provider.id, [
      { id: "shared", supported_endpoints: ["/v1/responses"], capabilities: { limits: { max_context_window_tokens: 100000 } }, custom_metadata: [1, "raw"] },
      { id: "fetched" }, { id: "fetched", label: "latest declaration" },
    ])
    expect(getCatalog(db, provider.id).map((model) => model.id)).toEqual(["shared", "fetched", "typed", "auto"])
    db = fixture.reopen()
    expect(getProvider(db, provider.id)).toMatchObject({ manual_models: ["typed", "shared", "auto"], last_refreshed_at: NOW, last_refresh_error: null,
      models: [{ id: "shared", supported_endpoints: ["/v1/responses"], capabilities: { limits: { max_context_window_tokens: 100000 } }, custom_metadata: [1, "raw"] }, { id: "fetched", label: "latest declaration" }] })
    replaceCatalog(db, provider.id, [{ id: "replacement" }], NOW + 5)
    expect(getProvider(db, provider.id)).toMatchObject({ manual_models: ["typed", "shared", "auto"], models: [{ id: "replacement" }], last_refreshed_at: NOW + 5 })
    updateProvider(db, provider.id, { manual_models: ["another"] })
    expect(getProvider(db, provider.id)?.models).toEqual([{ id: "replacement" }])
  })

  test("failed refresh retains the last good snapshot and timestamp while sanitizing errors", () => {
    const provider = createProvider(db, providerInput({ manual_models: ["typed"] }))
    replaceCatalog(db, provider.id, [{ id: "good" }])
    for (const error of [new Error("HTTP 401 fixture-only-credential Bearer confidential"), "status: 403 token=secret", { dangerous: "body" }]) {
      recordCatalogError(db, provider.id, error)
      const saved = getProvider(db, provider.id)!
      expect(saved).toMatchObject({ models: [{ id: "good" }], last_refreshed_at: NOW, manual_models: ["typed"] })
      expect(saved.last_refresh_error).toMatch(/^Model catalog refresh failed/)
      expect(saved.last_refresh_error).not.toContain("secret")
      expect(saved.last_refresh_error).not.toContain("credential")
    }
    db = fixture.reopen()
    expect(getProvider(db, provider.id)?.last_refresh_error).toBe("Model catalog refresh failed")
    replaceCatalog(db, provider.id, [], NOW + 10)
    expect(getProvider(db, provider.id)).toMatchObject({ models: [], manual_models: ["typed"], last_refreshed_at: NOW + 10, last_refresh_error: null })
  })

  test("global projection is cache-only, includes disabled upstreams and deterministic exact-ID metadata", () => {
    expect(projectCatalog(db)).toEqual([{ id: "auto", object: "model", owned_by: "raven" }])
    const first = createProvider(db, providerInput({ is_enabled: false, manual_models: ["manual", "AUTO"] }))
    vi.setSystemTime(NOW + 10)
    const second = createProvider(db, providerInput())
    replaceCatalog(db, first.id, [{ id: "shared", label: "first custom" }, { id: "custom-shared", label: "earlier", object: "declared-model", owned_by: "declared-owner" }])
    replaceCatalog(db, second.id, [{ id: "shared", label: "second custom" }, { id: "custom-shared", label: "later" }])
    replaceCatalog(db, COPILOT_UPSTREAM_ID, [{ id: "auto", label: "cannot override virtual model" }, { id: "shared", vendor: "copilot-vendor", supported_endpoints: ["/v1/messages"] }])
    updateProvider(db, COPILOT_UPSTREAM_ID, { manual_models: ["copilot-manual", "shared"] })
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is forbidden"))
    try {
      const projection = projectCatalog(db)
      expect(projection.map((model) => model.id)).toEqual(["auto", "shared", "copilot-manual", "custom-shared", "manual", "AUTO"])
      expect(projection[0]).toEqual({ id: "auto", object: "model", owned_by: "raven" })
      expect(projection.find((model) => model.id === "shared")).toEqual({ id: "shared", vendor: "copilot-vendor", object: "model", owned_by: "copilot-vendor", supported_endpoints: ["/v1/messages"] })
      expect(projection.find((model) => model.id === "custom-shared")).toEqual({ id: "custom-shared", label: "earlier", object: "declared-model", owned_by: "declared-owner" })
      expect(getProvider(db, COPILOT_UPSTREAM_ID)?.models[1]).toEqual({ id: "shared", vendor: "copilot-vendor", supported_endpoints: ["/v1/messages"] })
      expect(fetch).not.toHaveBeenCalled()
      deleteProvider(db, first.id)
      expect(projectCatalog(db).find((model) => model.id === "custom-shared")?.label).toBe("later")
      expect(projectCatalog(db).find((model) => model.id === "custom-shared")?.owned_by).toBe(second.name)
    } finally { fetch.mockRestore() }
  })

  test("invalid snapshots and storage errors cannot destroy a good snapshot", () => {
    const provider = createProvider(db, providerInput())
    replaceCatalog(db, provider.id, [{ id: "good" }])
    for (const invalid of [null, [null], [{ id: " " }], [{ id: 1 }]]) expect(() => replaceCatalog(db, provider.id, invalid as any)).toThrow()
    db.exec("CREATE TRIGGER block_catalog BEFORE UPDATE OF models ON providers BEGIN SELECT RAISE(ABORT, 'catalog write failure'); END")
    expect(() => replaceCatalog(db, provider.id, [{ id: "bad" }])).toThrow("catalog write failure")
    expect(getCatalog(db, provider.id)).toEqual([{ id: "good" }])
    expect(() => getCatalog(db, "missing")).toThrow("not found")
    expect(() => replaceCatalog(db, "missing", [])).toThrow("not found")
    expect(() => recordCatalogError(db, "missing", "HTTP 500")).toThrow("not found")
  })
})
