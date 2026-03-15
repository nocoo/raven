import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiKeyRecord {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** Public projection — never exposes key_hash */
export interface ApiKeyPublic {
  id: string;
  name: string;
  key_prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** Returned only at creation time — includes the raw key */
export interface ApiKeyCreated extends ApiKeyPublic {
  key: string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
`;

const CREATE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
`;

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export function initApiKeys(db: Database): void {
  db.exec(CREATE_TABLE);
  db.exec(CREATE_INDEX);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, "0");
  const rand = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36)
      .toString(36),
  )
    .join("")
    .toUpperCase();
  return ts + rand;
}

function generateRawKey(): string {
  const bytes = new Uint8Array(32); // 256 bits
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `rk-${hex}`;
}

function hashKey(rawKey: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(rawKey);
  return hasher.digest("hex");
}

function toPublic(record: ApiKeyRecord): ApiKeyPublic {
  return {
    id: record.id,
    name: record.name,
    key_prefix: record.key_prefix,
    created_at: record.created_at,
    last_used_at: record.last_used_at,
    revoked_at: record.revoked_at,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

const INSERT_SQL = `
INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at, last_used_at, revoked_at)
VALUES ($id, $name, $key_hash, $key_prefix, $created_at, NULL, NULL)
`;

export function createApiKey(
  db: Database,
  name: string,
): ApiKeyCreated {
  const id = generateId();
  const rawKey = generateRawKey();
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12); // "rk-a1b2c3d4e"
  const now = Date.now();

  db.query(INSERT_SQL).run({
    $id: id,
    $name: name,
    $key_hash: keyHash,
    $key_prefix: keyPrefix,
    $created_at: now,
  });

  return {
    id,
    name,
    key: rawKey,
    key_prefix: keyPrefix,
    created_at: now,
    last_used_at: null,
    revoked_at: null,
  };
}

/**
 * Validate a raw API key against the database.
 * Returns the public key record if valid (exists and not revoked),
 * updates last_used_at on success, returns null otherwise.
 */
export function validateApiKey(
  db: Database,
  rawKey: string,
): ApiKeyPublic | null {
  const keyHash = hashKey(rawKey);

  const row = db
    .query("SELECT * FROM api_keys WHERE key_hash = $hash")
    .get({ $hash: keyHash }) as ApiKeyRecord | null;

  if (!row) return null;
  if (row.revoked_at !== null) return null;

  // Update last_used_at
  db.query("UPDATE api_keys SET last_used_at = $now WHERE id = $id").run({
    $now: Date.now(),
    $id: row.id,
  });

  return toPublic(row);
}

export function listApiKeys(db: Database): ApiKeyPublic[] {
  const rows = db
    .query("SELECT * FROM api_keys ORDER BY created_at DESC")
    .all() as ApiKeyRecord[];
  return rows.map(toPublic);
}

export function revokeApiKey(db: Database, id: string): boolean {
  const result = db
    .query("UPDATE api_keys SET revoked_at = $now WHERE id = $id AND revoked_at IS NULL")
    .run({ $now: Date.now(), $id: id });
  return result.changes > 0;
}

export function deleteApiKey(db: Database, id: string): boolean {
  const result = db
    .query("DELETE FROM api_keys WHERE id = $id")
    .run({ $id: id });
  return result.changes > 0;
}

/**
 * Returns the count of all API keys (including revoked).
 * Used by auth middleware to determine dev-mode eligibility.
 */
export function getKeyCount(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) as count FROM api_keys")
    .get() as { count: number };
  return row.count;
}
