import type { Database } from "bun:sqlite"
import {
  RoutingError,
  type CreateProviderInput,
  type ProviderPublic,
  type RoutingReference,
  type UpdateProviderInput,
  type UpstreamRecord,
} from "../core/routing-types.ts"
import { getQuotaStatus, saveQuotaPolicy } from "./quota.ts"
import { initRouting } from "./routing-migration.ts"
import { listRoutingRules } from "./routing-rules.ts"
import { createProviderSchema, parseInput, updateProviderSchema, validateQuota } from "./routing-validation.ts"

export type { CreateProviderInput, ProviderAuthStyle, ProviderPublic, UpdateProviderInput, UpstreamFormat as ProviderFormat, UpstreamRecord as ProviderRecord } from "../core/routing-types.ts"

interface StoredProvider extends Omit<UpstreamRecord, "is_enabled" | "supports_reasoning" | "use_socks5" | "manual_models" | "models" | "quota"> {
  enabled: number
  supports_reasoning: number
  use_socks5: number | null
  manual_models: string
  models: string
  quota: string | null
  quota_window_id: string | null
}

function decode(row: StoredProvider): UpstreamRecord {
  const { enabled, quota_window_id: _window, ...rest } = row
  return {
    ...rest,
    is_enabled: enabled === 1,
    supports_reasoning: row.supports_reasoning === 1,
    use_socks5: row.use_socks5 === null ? null : row.use_socks5 === 1,
    manual_models: JSON.parse(row.manual_models),
    models: JSON.parse(row.models),
    quota: row.quota === null ? null : JSON.parse(row.quota),
  }
}

function toPublic(db: Database, row: UpstreamRecord): ProviderPublic {
  const { api_key, ...publicRecord } = row
  const quota_status = getQuotaStatus(db, row.id)
  return {
    ...publicRecord,
    quota: row.quota && quota_status.ends_at !== null ? { ...row.quota, next_reset_at: quota_status.ends_at } : row.quota,
    api_key_preview: api_key.length > 8 ? `${api_key.slice(0, 8)}...****` : "****",
    quota_status,
  }
}

export function initProviders(db: Database): void {
  initRouting(db)
}

export function getProviderRecord(db: Database, id: string): UpstreamRecord | null {
  const row = db.query("SELECT * FROM providers WHERE id = ?").get(id) as StoredProvider | null
  return row ? decode(row) : null
}

export function listProviderRecords(db: Database): UpstreamRecord[] {
  return (db.query("SELECT * FROM providers ORDER BY CASE kind WHEN 'copilot' THEN 0 ELSE 1 END, created_at, id").all() as StoredProvider[]).map(decode)
}

export function listProviders(db: Database): ProviderPublic[] {
  return listProviderRecords(db).map((row) => toPublic(db, row))
}

export function getProvider(db: Database, id: string): ProviderPublic | null {
  const row = getProviderRecord(db, id)
  return row ? toPublic(db, row) : null
}

export function createProvider(db: Database, input: CreateProviderInput): ProviderPublic {
  const data = parseInput(createProviderSchema, input)
  const quota = data.quota ? validateQuota(data.quota) : null
  return db.transaction(() => {
    const id = crypto.randomUUID()
    const now = Date.now()
    db.query(`INSERT INTO providers
      (id, name, kind, format, base_url, api_key, enabled, supports_reasoning, auth_style, use_socks5, manual_models, created_at, updated_at)
      VALUES (?, ?, 'custom', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, data.name, data.format, data.base_url, data.api_key, data.is_enabled === false ? 0 : 1,
      data.supports_reasoning === true ? 1 : 0, data.auth_style ?? null,
      data.use_socks5 === undefined || data.use_socks5 === null ? null : data.use_socks5 ? 1 : 0,
      JSON.stringify([...new Set(data.manual_models ?? [])]), now, now,
    )
    if (quota) saveQuotaPolicy(db, id, quota, now)
    return getProvider(db, id)!
  }).immediate()
}

export function updateProvider(db: Database, id: string, input: UpdateProviderInput): ProviderPublic | null {
  const data = parseInput(updateProviderSchema, input)
  const quota = data.quota ? validateQuota(data.quota) : null
  return db.transaction(() => {
    const existing = getProviderRecord(db, id)
    if (!existing) return null
    if (existing.kind === "copilot" && (data.is_enabled === false
      || data.format !== undefined || data.base_url !== undefined || data.api_key !== undefined || data.auth_style !== undefined)) {
      throw new RoutingError("Built-in Copilot driver and enabled state are protected", "protected_upstream", 409)
    }
    db.query(`UPDATE providers SET name = ?, base_url = ?, format = ?, api_key = ?, enabled = ?,
      supports_reasoning = ?, auth_style = ?, use_socks5 = ?, manual_models = ?, updated_at = ? WHERE id = ?`).run(
      data.name ?? existing.name, data.base_url ?? existing.base_url, data.format ?? existing.format,
      data.api_key ?? existing.api_key, (data.is_enabled ?? existing.is_enabled) ? 1 : 0,
      (data.supports_reasoning ?? existing.supports_reasoning) ? 1 : 0,
      data.auth_style === undefined ? existing.auth_style : data.auth_style,
      data.use_socks5 === undefined ? existing.use_socks5 === null ? null : existing.use_socks5 ? 1 : 0 : data.use_socks5 === null ? null : data.use_socks5 ? 1 : 0,
      JSON.stringify([...new Set(data.manual_models ?? existing.manual_models)]), Date.now(), id,
    )
    if (data.quota !== undefined) saveQuotaPolicy(db, id, quota)
    return getProvider(db, id)
  }).immediate()
}

export function deleteProvider(db: Database, id: string): boolean {
  return db.transaction(() => {
    const provider = getProviderRecord(db, id)
    if (!provider) return false
    if (provider.kind === "copilot") {
      throw new RoutingError("Built-in Copilot upstream is protected", "protected_upstream", 409, [{ kind: "builtin", id, name: provider.name }])
    }
    const references: RoutingReference[] = listRoutingRules(db)
      .filter((rule) => [...rule.default_chain, ...rule.periods.flatMap((period) => period.targets)].some((target) => target.upstream_id === id))
      .map((rule) => ({ kind: "rule", id: rule.id, name: rule.name }))
    if (references.length) throw new RoutingError("Upstream is referenced by routing rules", "reference_conflict", 409, references)
    return db.query("DELETE FROM providers WHERE id = ?").run(id).changes > 0
  }).immediate()
}
