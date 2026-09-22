import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { initRouting } from "../../src/db/routing-migration.ts"
import type { CreateProviderInput, QuotaPolicy, RoutingRuleInput } from "../../src/core/routing-types.ts"
import { COPILOT_UPSTREAM_ID } from "../../src/core/routing-types.ts"

export const NOW = Date.UTC(2026, 8, 21)
export const HOUR = 3600000

export function routingFixture(initialize = true) {
  const directory = mkdtempSync(join(tmpdir(), "raven-routing-"))
  const path = join(directory, "fixture.sqlite")
  let db = new Database(path)
  if (initialize) initRouting(db)
  return {
    get db() { return db },
    path,
    reopen() {
      db.close()
      db = new Database(path)
      initRouting(db)
      return db
    },
    close() {
      db.close()
      if (!basename(directory).startsWith("raven-routing-")) throw new Error("Unsafe fixture cleanup path")
      rmSync(directory, { recursive: true })
    },
  }
}

export function providerInput(overrides: Partial<CreateProviderInput> = {}): CreateProviderInput {
  return { name: "Fixture upstream", format: "responses", base_url: "https://fixture.invalid/v1", api_key: "fixture-only-credential", ...overrides }
}

export function ruleInput(overrides: Partial<RoutingRuleInput> = {}): RoutingRuleInput {
  return { name: "Fixture rule", mode: "all_day", default_chain: [{ upstream_id: COPILOT_UPSTREAM_ID, model: "fixture-model" }], periods: [], ...overrides }
}

export function quotaPolicy(overrides: Partial<QuotaPolicy> = {}): QuotaPolicy {
  return { limit_tokens: 100, window_minutes: 60, next_reset_at: NOW + HOUR, mode: "all_day", multipliers: [], ...overrides }
}
