import { initIPPolicies } from "./ip-policy"
import type { Database } from "bun:sqlite"
import { COPILOT_RULE_ID, COPILOT_UPSTREAM_ID, type RoutingMigrationSummary } from "../core/routing-types.ts"
import { getSetting, initSettings, setSetting } from "./settings.ts"

export const ROUTING_SCHEMA_VERSION = 1
const SUMMARY_KEY = "routing:r3:migration"

const SCHEMA = `
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('copilot', 'custom')),
  format TEXT,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  supports_reasoning INTEGER NOT NULL DEFAULT 0 CHECK(supports_reasoning IN (0, 1)),
  auth_style TEXT CHECK(auth_style IN ('x-api-key', 'bearer')),
  use_socks5 INTEGER CHECK(use_socks5 IN (0, 1)),
  manual_models TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(manual_models)),
  models TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(models)),
  last_refreshed_at INTEGER,
  last_refresh_error TEXT,
  quota TEXT CHECK(quota IS NULL OR json_valid(quota)),
  quota_window_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((kind = 'copilot' AND id = 'builtin:copilot' AND format IS NULL AND enabled = 1)
    OR (kind = 'custom' AND id != 'builtin:copilot' AND format IS NOT NULL AND format IN ('anthropic_messages', 'chat_completions', 'responses')))
);
CREATE TABLE routing_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  allow_conversion INTEGER NOT NULL DEFAULT 0 CHECK(allow_conversion IN (0, 1)),
  mode TEXT NOT NULL CHECK(mode IN ('all_day', 'daily', 'weekly')),
  default_chain TEXT NOT NULL CHECK(json_valid(default_chain) AND json_array_length(default_chain) > 0),
  periods TEXT NOT NULL CHECK(json_valid(periods)),
  is_builtin INTEGER NOT NULL CHECK(is_builtin IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((is_builtin = 1 AND id = 'builtin:copilot') OR (is_builtin = 0 AND id != 'builtin:copilot'))
);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  rule_id TEXT NOT NULL REFERENCES routing_rules(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE quota_windows (
  id TEXT PRIMARY KEY,
  upstream_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK(ends_at > starts_at),
  charged REAL NOT NULL DEFAULT 0 CHECK(charged >= 0),
  usage_complete INTEGER NOT NULL DEFAULT 1 CHECK(usage_complete IN (0, 1))
);
CREATE INDEX idx_quota_windows_upstream ON quota_windows(upstream_id);
CREATE TABLE quota_settlements (
  request_id TEXT NOT NULL,
  attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal >= 0),
  upstream_id TEXT NOT NULL,
  window_id TEXT REFERENCES quota_windows(id) ON DELETE RESTRICT,
  captured_at INTEGER NOT NULL,
  usage_present INTEGER NOT NULL CHECK(usage_present IN (0, 1)),
  usage_complete INTEGER NOT NULL CHECK(usage_complete IN (0, 1)),
  input_tokens REAL,
  cache_read_tokens REAL,
  cache_write_tokens REAL,
  output_tokens REAL,
  multiplier REAL NOT NULL CHECK(multiplier > 0),
  weighted_debit REAL NOT NULL CHECK(weighted_debit >= 0),
  PRIMARY KEY(request_id, attempt_ordinal)
);
CREATE TRIGGER protect_copilot_delete BEFORE DELETE ON providers
WHEN OLD.kind = 'copilot' BEGIN SELECT RAISE(ABORT, 'Built-in Copilot upstream is protected'); END;
CREATE TRIGGER protect_copilot_identity BEFORE UPDATE OF id, kind ON providers
WHEN OLD.kind = 'copilot' BEGIN SELECT RAISE(ABORT, 'Built-in Copilot upstream is protected'); END;
CREATE TRIGGER protect_copilot_rule_delete BEFORE DELETE ON routing_rules
WHEN OLD.is_builtin = 1 BEGIN SELECT RAISE(ABORT, 'Built-in Copilot rule is protected'); END;
CREATE TRIGGER protect_copilot_rule_identity BEFORE UPDATE OF id, is_builtin ON routing_rules
WHEN OLD.is_builtin = 1 BEGIN SELECT RAISE(ABORT, 'Built-in Copilot rule is protected'); END;
`

interface LegacyProvider {
  id: string
  name: string
  base_url: string
  format: string
  api_key: string
  model_patterns: string
  enabled: number
  supports_reasoning?: number
  auth_style?: string | null
  use_socks5?: number | null
  created_at: number
  updated_at: number
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null
}

function legacyPatterns(value: string): string[] {
  try {
    const patterns: unknown = JSON.parse(value)
    return Array.isArray(patterns) ? patterns.filter((pattern): pattern is string => typeof pattern === "string" && pattern.trim().length > 0) : []
  } catch {
    return []
  }
}

function verifyForeignKeys(db: Database): void {
  if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Routing database has invalid foreign keys")
}

export function initRouting(db: Database, now = Date.now()): void {
  db.exec("PRAGMA foreign_keys = ON")
  const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }
  if (foreignKeys.foreign_keys !== 1) throw new Error("Routing database requires foreign keys before migration")
  const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
  if (version > ROUTING_SCHEMA_VERSION) throw new Error(`Unsupported routing schema version ${version}`)
  if (version === ROUTING_SCHEMA_VERSION) {
    verifyForeignKeys(db)
    initIPPolicies(db)
    return
  }
  db.transaction(() => {
    const hasProviders = tableExists(db, "providers")
    const hasKeys = tableExists(db, "api_keys")
    const providers = hasProviders ? db.query("SELECT * FROM providers ORDER BY created_at, id").all() as LegacyProvider[] : []
    const keys = hasKeys ? db.query("SELECT id, name FROM api_keys ORDER BY created_at, id").all() as { id: string; name: string }[] : []
    if (hasProviders) db.exec("ALTER TABLE providers RENAME TO providers_legacy_r3")
    if (hasKeys) db.exec("ALTER TABLE api_keys RENAME TO api_keys_legacy_r3")
    db.exec(SCHEMA)
    initSettings(db)
    db.query(`INSERT INTO providers (id, name, kind, base_url, api_key, created_at, updated_at)
      VALUES (?, 'GitHub Copilot', 'copilot', '', '', ?, ?)`).run(COPILOT_UPSTREAM_ID, now, now)
    db.query(`INSERT INTO routing_rules (id, name, allow_conversion, mode, default_chain, periods, is_builtin, created_at, updated_at)
      VALUES (?, 'GitHub Copilot', 1, 'all_day', ?, '[]', 1, ?, ?)`).run(
      COPILOT_RULE_ID, JSON.stringify([{ upstream_id: COPILOT_UPSTREAM_ID, model: "gpt-5.6-sol" }]), now, now,
    )
    const summary: RoutingMigrationSummary = {
      migrated_at: now,
      upstreams: [],
      keys: keys.map((key) => ({ ...key, rule_id: COPILOT_RULE_ID })),
    }
    for (const provider of providers) {
      const patterns = legacyPatterns(provider.model_patterns)
      const retained = [...new Set(patterns.filter((pattern) => !pattern.includes("*")))]
      const format = provider.format === "openai" ? "chat_completions" : provider.format === "anthropic" ? "anthropic_messages" : provider.format
      db.query(`INSERT INTO providers
        (id, name, kind, format, base_url, api_key, enabled, supports_reasoning, auth_style, use_socks5, manual_models, created_at, updated_at)
        VALUES (?, ?, 'custom', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        provider.id, provider.name, format, provider.base_url, provider.api_key, provider.enabled,
        provider.supports_reasoning ?? 0, provider.auth_style ?? null, provider.use_socks5 ?? null,
        JSON.stringify(retained), provider.created_at, provider.updated_at,
      )
      summary.upstreams.push({ id: provider.id, name: provider.name, retained_models: retained, discarded_patterns: patterns.filter((pattern) => pattern.includes("*")) })
    }
    if (hasKeys) {
      db.query(`INSERT INTO api_keys (id, name, key_hash, key_prefix, rule_id, created_at, last_used_at, revoked_at)
        SELECT id, name, key_hash, key_prefix, ?, created_at, last_used_at, revoked_at FROM api_keys_legacy_r3`).run(COPILOT_RULE_ID)
      db.exec("DROP TABLE api_keys_legacy_r3")
    }
    if (hasProviders) db.exec("DROP TABLE providers_legacy_r3")
    db.exec("CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash)")
    db.exec("CREATE INDEX idx_api_keys_rule_id ON api_keys(rule_id)")
    if (hasProviders || hasKeys) setSetting(db, SUMMARY_KEY, JSON.stringify(summary))
    verifyForeignKeys(db)
    db.exec(`PRAGMA user_version = ${ROUTING_SCHEMA_VERSION}`)
  }).immediate()
  initIPPolicies(db)
}

export function getRoutingMigrationSummary(db: Database): RoutingMigrationSummary | null {
  const summary = getSetting(db, SUMMARY_KEY)
  return summary === null ? null : JSON.parse(summary) as RoutingMigrationSummary
}
