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
  use_socks5: number | null // null = default, 0 = force off, 1 = force on
  created_at: number
  updated_at: number
}

// ---------------------------------------------------------------------------
// Compiled Provider (Runtime)
// ---------------------------------------------------------------------------

/** Pre-parsed pattern for efficient matching. */
export interface CompiledPattern {
  /** Original pattern string */
  raw: string
  /** True if exact match (no wildcards) */
  isExact: boolean
  /** Prefix for glob patterns (e.g., "gpt-" for "gpt-*") */
  prefix?: string
}

/** Runtime provider with pre-compiled patterns. */
export interface CompiledProvider extends Omit<ProviderRecord, "model_patterns"> {
  /** Pre-parsed patterns for efficient matching */
  patterns: CompiledPattern[]
}

/**
 * Compile a provider record for runtime use.
 * Parses model_patterns JSON and pre-computes match structures.
 * Returns null if provider has invalid JSON (should be skipped).
 *
 * Pure function - no side effects. Logging is handled by callers like cacheProviders().
 */
export function compileProvider(record: ProviderRecord): CompiledProvider | null {
  try {
    const rawPatterns: string[] = JSON.parse(record.model_patterns)
    const patterns = rawPatterns.map((p): CompiledPattern => {
      const base: Omit<CompiledPattern, 'prefix'> = {
        raw: p,
        isExact: !p.includes("*"),
      }
      if (p.endsWith("*")) {
        return { ...base, prefix: p.slice(0, -1) }
      }
      return base
    })

    // Destructure to remove model_patterns from the spread
    const { model_patterns: _, ...rest } = record
    return { ...rest, patterns }
  } catch {
    // Invalid JSON - return null to indicate this provider should be skipped
    // Caller (e.g., cacheProviders) is responsible for logging warnings
    return null
  }
}

/** Public projection — masks api_key. */
export interface ProviderPublic {
  id: string
  name: string
  base_url: string
  format: ProviderFormat
  api_key_preview: string // "6b69d7c2...****"
  model_patterns: string[] // Parsed patterns (empty array if invalid JSON)
  raw_model_patterns: string // Original JSON string for debugging/recovery
  is_enabled: boolean
  supports_reasoning: boolean
  supports_models_endpoint: boolean | null // null = unknown
  compilation_error: string | null // null = compiled successfully, string = error message
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
  safeAddColumn("ALTER TABLE providers ADD COLUMN use_socks5 INTEGER DEFAULT NULL")
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
  // Check if provider can be compiled (no logging - pure validation)
  let compilationError: string | null = null
  try {
    const compiled = compileProvider(row)
    if (!compiled) {
      compilationError = "Invalid model_patterns JSON"
    }
  } catch {
    compilationError = "Invalid model_patterns JSON"
  }

  // Parse model_patterns for response (gracefully fallback to empty array)
  let modelPatterns: string[]
  try {
    modelPatterns = JSON.parse(row.model_patterns) as string[]
  } catch {
    modelPatterns = []
  }

  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    format: row.format,
    api_key_preview: maskApiKey(row.api_key),
    model_patterns: modelPatterns,
    raw_model_patterns: row.model_patterns, // Preserve original for debugging/recovery
    is_enabled: row.enabled === 1,
    supports_reasoning: row.supports_reasoning === 1,
    supports_models_endpoint: row.supports_models_endpoint === null ? null : row.supports_models_endpoint === 1,
    compilation_error: compilationError,
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
