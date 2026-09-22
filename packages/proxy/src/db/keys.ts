import type { Database } from "bun:sqlite"
import { RoutingError } from "../core/routing-types.ts"
import { initRouting } from "./routing-migration.ts"
import { createKeySchema, parseInput, updateKeySchema } from "./routing-validation.ts"

export interface ApiKeyRecord {
  id: string
  name: string
  key_hash: string
  key_prefix: string
  rule_id: string
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}

export type ApiKeyPublic = Omit<ApiKeyRecord, "key_hash">
export interface ApiKeyCreated extends ApiKeyPublic {
  key: string
}

export function initApiKeys(db: Database): void {
  initRouting(db)
}

function hashKey(rawKey: string): string {
  return new Bun.CryptoHasher("sha256").update(rawKey).digest("hex")
}

function toPublic(record: ApiKeyRecord): ApiKeyPublic {
  const { key_hash: _hash, ...publicRecord } = record
  return publicRecord
}

function validateRuleReference(db: Database, ruleId: string): void {
  if (!db.query("SELECT 1 FROM routing_rules WHERE id = ?").get(ruleId)) throw new RoutingError("Routing rule does not exist")
}

export function createApiKey(db: Database, name: string, ruleId: string): ApiKeyCreated {
  const input = parseInput(createKeySchema, { name, rule_id: ruleId })
  return db.transaction(() => {
    validateRuleReference(db, input.rule_id)
    const id = crypto.randomUUID()
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const key = `rk-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    const prefix = key.slice(0, 12)
    const now = Date.now()
    db.query(`INSERT INTO api_keys (id, name, key_hash, key_prefix, rule_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, input.name, hashKey(key), prefix, input.rule_id, now)
    return { id, name: input.name, key, key_prefix: prefix, rule_id: input.rule_id, created_at: now, last_used_at: null, revoked_at: null }
  }).immediate()
}

export function validateApiKey(db: Database, rawKey: string): ApiKeyPublic | null {
  const row = db.query("SELECT * FROM api_keys WHERE key_hash = ?").get(hashKey(rawKey)) as ApiKeyRecord | null
  if (!row || row.revoked_at !== null) return null
  db.query("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id)
  return toPublic(row)
}

export function listApiKeys(db: Database): ApiKeyPublic[] {
  return (db.query("SELECT * FROM api_keys ORDER BY created_at DESC, id").all() as ApiKeyRecord[]).map(toPublic)
}

export function updateApiKeyRule(db: Database, id: string, ruleId: string): ApiKeyPublic | null {
  const input = parseInput(updateKeySchema, { rule_id: ruleId })
  return db.transaction(() => {
    const row = db.query("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRecord | null
    if (!row) return null
    validateRuleReference(db, input.rule_id)
    db.query("UPDATE api_keys SET rule_id = ? WHERE id = ?").run(input.rule_id, id)
    return toPublic({ ...row, rule_id: input.rule_id })
  }).immediate()
}

export function revokeApiKey(db: Database, id: string): boolean {
  return db.query("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id).changes > 0
}

export function deleteApiKey(db: Database, id: string): boolean {
  return db.query("DELETE FROM api_keys WHERE id = ?").run(id).changes > 0
}
