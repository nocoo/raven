import type { Database } from "bun:sqlite"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderFormat = "openai" | "anthropic"

/** Full DB row. */
export interface ProviderRecord {
  id: string
  name: string
  base_url: string
  format: ProviderFormat
  api_key: string
  model_patterns: string // JSON array
  enabled: number // 0 | 1
  supports_reasoning: number // 0 | 1
  supports_models_endpoint: number // 0 | 1 | null (null = unknown)
  created_at: number
  updated_at: number
}

/** Public projection — masks api_key. */
export interface ProviderPublic {
  id: string
  name: string
  base_url: string
  format: ProviderFormat
  api_key_preview: string // "6b69d7c2...****"
  model_patterns: string[]
  is_enabled: boolean
  supports_reasoning: boolean
  supports_models_endpoint: boolean | null // null = unknown
  created_at: number
  updated_at: number
}

/** Create input. */
export interface CreateProviderInput {
  name: string
  base_url: string
  format: ProviderFormat
  api_key: string
  model_patterns: string[]
  is_enabled?: boolean
  supports_reasoning?: boolean
}

/** Update input — all fields optional. */
export interface UpdateProviderInput {
  name?: string
  base_url?: string
  format?: ProviderFormat
  api_key?: string
  model_patterns?: string[]
  is_enabled?: boolean
  supports_reasoning?: boolean
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS providers (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  base_url           TEXT NOT NULL,
  format             TEXT NOT NULL CHECK(format IN ('openai', 'anthropic')),
  api_key            TEXT NOT NULL,
  model_patterns     TEXT NOT NULL DEFAULT '[]',
  enabled            INTEGER NOT NULL DEFAULT 1,
  supports_reasoning INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
`

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export function initProviders(db: Database): void {
  db.exec(CREATE_TABLE)

  // Migration: add supports_reasoning column (idempotent)
  const safeAddColumn = (sql: string) => {
    try {
      db.exec(sql)
    } catch (e) {
      if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e
    }
  }
  safeAddColumn("ALTER TABLE providers ADD COLUMN supports_reasoning INTEGER NOT NULL DEFAULT 0")
  safeAddColumn("ALTER TABLE providers ADD COLUMN supports_models_endpoint INTEGER DEFAULT NULL")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, "0")
  const rand = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  )
    .join("")
    .toUpperCase()
  return ts + rand
}

function maskApiKey(key: string): string {
  if (key.length === 0) return "****"
  const prefix = key.slice(0, 8)
  return prefix + "...****"
}

function toPublic(row: ProviderRecord): ProviderPublic {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    format: row.format,
    api_key_preview: maskApiKey(row.api_key),
    model_patterns: JSON.parse(row.model_patterns) as string[],
    is_enabled: row.enabled === 1,
    supports_reasoning: row.supports_reasoning === 1,
    supports_models_endpoint: row.supports_models_endpoint === null ? null : row.supports_models_endpoint === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

const INSERT_SQL = `
INSERT INTO providers (id, name, base_url, format, api_key, model_patterns, enabled, supports_reasoning, created_at, updated_at)
VALUES ($id, $name, $base_url, $format, $api_key, $model_patterns, $enabled, $supports_reasoning, $created_at, $updated_at)
`

export function createProvider(
  db: Database,
  input: CreateProviderInput,
): ProviderPublic {
  const id = generateId()
  const now = Date.now()

  db.query(INSERT_SQL).run({
    $id: id,
    $name: input.name,
    $base_url: input.base_url,
    $format: input.format,
    $api_key: input.api_key,
    $model_patterns: JSON.stringify(input.model_patterns),
    $enabled: input.is_enabled === false ? 0 : 1,
    $supports_reasoning: input.supports_reasoning === true ? 1 : 0,
    $created_at: now,
    $updated_at: now,
  })

  const row = db
    .query("SELECT * FROM providers WHERE id = $id")
    .get({ $id: id }) as ProviderRecord
  return toPublic(row)
}

export function listProviders(db: Database): ProviderPublic[] {
  const rows = db
    .query("SELECT * FROM providers ORDER BY created_at ASC")
    .all() as ProviderRecord[]
  return rows.map(toPublic)
}

export function getProvider(
  db: Database,
  id: string,
): ProviderPublic | null {
  const row = db
    .query("SELECT * FROM providers WHERE id = $id")
    .get({ $id: id }) as ProviderRecord | null
  return row ? toPublic(row) : null
}

export function updateProvider(
  db: Database,
  id: string,
  input: UpdateProviderInput,
): ProviderPublic | null {
  const existing = db
    .query("SELECT * FROM providers WHERE id = $id")
    .get({ $id: id }) as ProviderRecord | null
  if (!existing) return null

  const now = Date.now()
  const updated = {
    name: input.name ?? existing.name,
    base_url: input.base_url ?? existing.base_url,
    format: input.format ?? existing.format,
    api_key: input.api_key ?? existing.api_key,
    model_patterns:
      input.model_patterns !== undefined
        ? JSON.stringify(input.model_patterns)
        : existing.model_patterns,
    enabled:
      input.is_enabled !== undefined
        ? input.is_enabled
          ? 1
          : 0
        : existing.enabled,
    supports_reasoning:
      input.supports_reasoning !== undefined
        ? input.supports_reasoning
          ? 1
          : 0
        : existing.supports_reasoning,
  }

  db.query(
    `UPDATE providers
     SET name = $name, base_url = $base_url, format = $format,
         api_key = $api_key, model_patterns = $model_patterns,
         enabled = $enabled, supports_reasoning = $supports_reasoning,
         updated_at = $updated_at
     WHERE id = $id`,
  ).run({
    $id: id,
    $name: updated.name,
    $base_url: updated.base_url,
    $format: updated.format,
    $api_key: updated.api_key,
    $model_patterns: updated.model_patterns,
    $enabled: updated.enabled,
    $supports_reasoning: updated.supports_reasoning,
    $updated_at: now,
  })

  const row = db
    .query("SELECT * FROM providers WHERE id = $id")
    .get({ $id: id }) as ProviderRecord
  return toPublic(row)
}

export function deleteProvider(db: Database, id: string): boolean {
  const result = db
    .query("DELETE FROM providers WHERE id = $id")
    .run({ $id: id })
  return result.changes > 0
}

/**
 * Returns full records (with raw api_key) for enabled providers only.
 * Used by the routing engine — never exposed via API.
 * Ordered by created_at ASC for deterministic routing priority.
 */
export function getEnabledProviders(db: Database): ProviderRecord[] {
  return db
    .query(
      "SELECT * FROM providers WHERE enabled = 1 ORDER BY created_at ASC",
    )
    .all() as ProviderRecord[]
}

/**
 * Update supports_models_endpoint flag for a provider.
 * Called after probing the upstream's /v1/models endpoint.
 */
export function updateProviderModelsSupport(
  db: Database,
  id: string,
  supports: boolean,
): void {
  db.query(
    "UPDATE providers SET supports_models_endpoint = $supports, updated_at = $updated_at WHERE id = $id",
  ).run({
    $id: id,
    $supports: supports ? 1 : 0,
    $updated_at: Date.now(),
  })
}
