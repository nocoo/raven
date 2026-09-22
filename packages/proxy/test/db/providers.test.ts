import type { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { COPILOT_UPSTREAM_ID, RoutingError } from "../../src/core/routing-types.ts"
import { createProvider, deleteProvider, getProvider, getProviderRecord, initProviders, listProviderRecords, listProviders, updateProvider } from "../../src/db/providers.ts"
import { createRoutingRule, deleteRoutingRule, updateRoutingRule } from "../../src/db/routing-rules.ts"
import { NOW, providerInput, quotaPolicy, routingFixture, ruleInput } from "./routing-fixture.ts"

let fixture: ReturnType<typeof routingFixture>
let db: Database
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  fixture = routingFixture()
  db = fixture.db
})
afterEach(() => { fixture.close(); vi.useRealTimers() })

describe("R3 upstream repository", () => {
  test("initializes once and returns the protected driver first without exposing a credential", () => {
    initProviders(db)
    expect(listProviders(db).map((provider) => provider.id)).toEqual([COPILOT_UPSTREAM_ID])
    const custom = createProvider(db, providerInput({ manual_models: ["raw/model", "raw/model", "auto"] }))
    expect(custom).toMatchObject({ format: "responses", kind: "custom", is_enabled: true, supports_reasoning: false, auth_style: null, use_socks5: null, models: [], manual_models: ["raw/model", "auto"], last_refreshed_at: null })
    expect(custom).not.toHaveProperty("api_key")
    expect(custom).not.toHaveProperty("quota_window_id")
    expect(custom).not.toHaveProperty("model_patterns")
    expect(custom.api_key_preview).toBe("fixture-...****")
    expect(getProviderRecord(db, custom.id)?.api_key).toBe("fixture-only-credential")
    expect(listProviderRecords(db).map((provider) => provider.id)).toEqual([COPILOT_UPSTREAM_ID, custom.id])
    expect(getProvider(db, "missing")).toBeNull()
    expect(getProviderRecord(db, "missing")).toBeNull()
  })

  test.each(["anthropic_messages", "chat_completions", "responses"] as const)("persists single format %s without probing", (format) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is forbidden"))
    try {
      const first = createProvider(db, providerInput({ format }))
      const second = createProvider(db, providerInput({ format, api_key: "short" }))
      expect(first.id).not.toBe(second.id)
      expect(second.api_key_preview).toBe("****")
      expect(fetch).not.toHaveBeenCalled()
      db = fixture.reopen()
      expect(getProvider(db, first.id)?.format).toBe(format)
    } finally { fetch.mockRestore() }
  })

  test.each([true, false, null])("persists proxy options and nullable auth (%s)", (use_socks5) => {
    const saved = createProvider(db, providerInput({ use_socks5, supports_reasoning: true, is_enabled: false, auth_style: "bearer" }))
    expect(saved).toMatchObject({ use_socks5, supports_reasoning: true, is_enabled: false, auth_style: "bearer" })
    expect(updateProvider(db, saved.id, { name: "Edited" })).toMatchObject({ name: "Edited", use_socks5, auth_style: "bearer", is_enabled: false })
    expect(updateProvider(db, saved.id, { auth_style: "x-api-key", supports_reasoning: false, is_enabled: true })).toMatchObject({ auth_style: "x-api-key", supports_reasoning: false, is_enabled: true })
    expect(updateProvider(db, saved.id, { auth_style: null, use_socks5: true })).toMatchObject({ auth_style: null, use_socks5: true })
    expect(updateProvider(db, saved.id, { use_socks5: false })).toMatchObject({ use_socks5: false })
    expect(updateProvider(db, saved.id, { use_socks5: null })).toMatchObject({ use_socks5: null })
  })

  test("updates config atomically, preserves catalog state, and keeps deleted IDs retired", () => {
    const saved = createProvider(db, providerInput())
    vi.setSystemTime(NOW + 1000)
    const changed = updateProvider(db, saved.id, { name: "New", base_url: "http://127.0.0.1:1234/v1", format: "chat_completions", api_key: "replacement-fixture-secret", manual_models: ["new", "new"], quota: quotaPolicy() })!
    expect(changed).toMatchObject({ id: saved.id, name: "New", format: "chat_completions", manual_models: ["new"], created_at: NOW, updated_at: NOW + 1000 })
    expect(changed.quota_status).toMatchObject({ starts_at: NOW + 1000, remaining_tokens: 100 })
    expect(updateProvider(db, saved.id, { quota: null })?.quota).toBeNull()
    expect(updateProvider(db, "missing", { name: "No entity" })).toBeNull()
    expect(deleteProvider(db, "missing")).toBe(false)
    expect(deleteProvider(db, saved.id)).toBe(true)
    expect(getProvider(db, saved.id)).toBeNull()
    expect(createProvider(db, providerInput()).id).not.toBe(saved.id)
  })

  test("Copilot permits quota, catalog and model options but protects its driver and enabled state", () => {
    expect(updateProvider(db, COPILOT_UPSTREAM_ID, { name: "Copilot", is_enabled: true, manual_models: ["typed"], use_socks5: false, quota: quotaPolicy() })).toMatchObject({ manual_models: ["typed"], quota: quotaPolicy() })
    for (const input of [{ is_enabled: false }, { format: "responses" }, { base_url: "https://fixture.invalid" }, { api_key: "fixture" }, { auth_style: "bearer" }]) {
      expect(() => updateProvider(db, COPILOT_UPSTREAM_ID, input as any)).toThrow(RoutingError)
    }
    expect(() => deleteProvider(db, COPILOT_UPSTREAM_ID)).toThrow("protected")
    expect(getProvider(db, COPILOT_UPSTREAM_ID)?.is_enabled).toBe(true)
  })

  test("reference conflicts include every rule and never rewrite chains", () => {
    const upstream = createProvider(db, providerInput())
    const first = createRoutingRule(db, ruleInput({ default_chain: [{ upstream_id: upstream.id, model: "manual-only" }] }))
    const second = createRoutingRule(db, ruleInput({ mode: "daily", periods: [{ id: "morning", start_minute: 0, end_minute: 60, targets: [{ upstream_id: upstream.id, model: "other" }] }] }))
    try { deleteProvider(db, upstream.id); throw new Error("Expected conflict") } catch (error) {
      expect(error).toMatchObject({ status: 409, type: "reference_conflict" })
      expect((error as RoutingError).references.map((reference) => reference.id).sort()).toEqual([first.id, second.id].sort())
    }
    expect(getProvider(db, upstream.id)).not.toBeNull()
    deleteRoutingRule(db, first.id)
    updateRoutingRule(db, second.id, ruleInput())
    expect(deleteProvider(db, upstream.id)).toBe(true)
  })

  test.each([
    { name: " " }, { name: "x".repeat(129) }, { api_key: "" }, { format: "openai" }, { base_url: "ftp://fixture.invalid" },
    { base_url: "https://user:secret@fixture.invalid" }, { base_url: "https://fixture.invalid/?key=secret" }, { base_url: "https://fixture.invalid/#fragment" },
    { base_url: "not-a-url" }, { is_enabled: 1 }, { auth_style: "both" }, { manual_models: [""] }, { manual_models: [" "] }, { model_patterns: [] },
    { quota: quotaPolicy({ limit_tokens: 0 }) }, { quota: quotaPolicy({ limit_tokens: Number.POSITIVE_INFINITY }) },
    { quota: quotaPolicy({ window_minutes: 0 }) }, { quota: quotaPolicy({ window_minutes: 0.000001 }) },
    { quota: quotaPolicy({ next_reset_at: 1.1 }) }, { quota: quotaPolicy({ mode: "daily", multipliers: [{ id: "bad", start_minute: 0, end_minute: 60, multiplier: 0 }] }) },
    { quota: quotaPolicy({ mode: "daily", multipliers: [{ id: "first", start_minute: 0, end_minute: 60, multiplier: 1 }, { id: "second", start_minute: 30, end_minute: 90, multiplier: 2 }] }) },
  ])("rejects invalid config without adding a row: %j", (invalid) => {
    expect(() => createProvider(db, { ...providerInput(), ...invalid } as any)).toThrow(RoutingError)
    expect(listProviders(db)).toHaveLength(1)
  })

  test("quota window storage failure rolls back provider fields and policy together", () => {
    const provider = createProvider(db, providerInput())
    db.exec("CREATE TRIGGER block_window BEFORE INSERT ON quota_windows BEGIN SELECT RAISE(ABORT, 'quota storage fault'); END")
    expect(() => updateProvider(db, provider.id, { name: "Must roll back", quota: quotaPolicy() })).toThrow("quota storage fault")
    expect(getProvider(db, provider.id)).toMatchObject({ name: provider.name, quota: null })
    expect(() => createProvider(db, providerInput({ quota: quotaPolicy() }))).toThrow("quota storage fault")
    expect(listProviders(db)).toHaveLength(2)
  })
})
