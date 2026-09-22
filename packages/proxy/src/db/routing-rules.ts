import type { Database } from "bun:sqlite"
import { RoutingError, type RoutingReference, type RoutingRule, type RoutingRuleInput } from "../core/routing-types.ts"
import { validateRule } from "./routing-validation.ts"

interface StoredRule extends Omit<RoutingRule, "allow_conversion" | "is_builtin" | "default_chain" | "periods"> {
  allow_conversion: number
  is_builtin: number
  default_chain: string
  periods: string
}

function decode(row: StoredRule): RoutingRule {
  return {
    ...row,
    allow_conversion: row.allow_conversion === 1,
    is_builtin: row.is_builtin === 1,
    default_chain: JSON.parse(row.default_chain),
    periods: JSON.parse(row.periods),
  }
}

function validateReferences(db: Database, rule: RoutingRuleInput): void {
  const ids = new Set([...rule.default_chain, ...rule.periods.flatMap((period) => period.targets)].map((target) => target.upstream_id))
  for (const id of ids) {
    if (!db.query("SELECT 1 FROM providers WHERE id = ?").get(id)) throw new RoutingError(`Unknown upstream: ${id}`)
  }
}

export function listRoutingRules(db: Database): RoutingRule[] {
  return (db.query("SELECT * FROM routing_rules ORDER BY is_builtin DESC, created_at, id").all() as StoredRule[]).map(decode)
}

export function getRoutingRule(db: Database, id: string): RoutingRule | null {
  const row = db.query("SELECT * FROM routing_rules WHERE id = ?").get(id) as StoredRule | null
  return row ? decode(row) : null
}

export function createRoutingRule(db: Database, input: RoutingRuleInput): RoutingRule {
  const rule = validateRule(input)
  return db.transaction(() => {
    validateReferences(db, rule)
    const id = crypto.randomUUID()
    const now = Date.now()
    db.query(`INSERT INTO routing_rules (id, name, allow_conversion, mode, default_chain, periods, is_builtin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(id, rule.name, rule.allow_conversion ? 1 : 0, rule.mode, JSON.stringify(rule.default_chain), JSON.stringify(rule.periods), now, now)
    return getRoutingRule(db, id)!
  }).immediate()
}

export function updateRoutingRule(db: Database, id: string, input: RoutingRuleInput): RoutingRule | null {
  const rule = validateRule(input)
  return db.transaction(() => {
    const existing = getRoutingRule(db, id)
    if (!existing) return null
    validateReferences(db, rule)
    db.query(`UPDATE routing_rules SET name = ?, allow_conversion = ?, mode = ?, default_chain = ?, periods = ?, updated_at = ? WHERE id = ?`).run(
      rule.name, (input.allow_conversion ?? existing.allow_conversion) ? 1 : 0, rule.mode,
      JSON.stringify(rule.default_chain), JSON.stringify(rule.periods), Date.now(), id,
    )
    return getRoutingRule(db, id)
  }).immediate()
}

export function deleteRoutingRule(db: Database, id: string): boolean {
  return db.transaction(() => {
    const rule = getRoutingRule(db, id)
    if (!rule) return false
    if (rule.is_builtin) throw new RoutingError("Built-in Copilot rule is protected", "protected_rule", 409, [{ kind: "builtin", id: "env:default", name: "Environment client key" }])
    const keys = db.query("SELECT id, name FROM api_keys WHERE rule_id = ? ORDER BY created_at, id").all(id) as { id: string; name: string }[]
    const references: RoutingReference[] = keys.map((key) => ({ kind: "key", ...key }))
    if (references.length) throw new RoutingError("Routing rule is referenced by client keys", "reference_conflict", 409, references)
    return db.query("DELETE FROM routing_rules WHERE id = ?").run(id).changes > 0
  }).immediate()
}
