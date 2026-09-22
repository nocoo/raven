import type { Database } from "bun:sqlite"
import { matchingInterval } from "../core/schedule.ts"
import {
  RoutingError,
  type QuotaPolicy,
  type QuotaSettlementInput,
  type QuotaSettlementResult,
  type QuotaStatus,
} from "../core/routing-types.ts"
import { validateQuota } from "./routing-validation.ts"

interface QuotaRow {
  quota: string | null
  quota_window_id: string | null
}

interface QuotaWindow {
  id: string
  upstream_id: string
  starts_at: number
  ends_at: number
  charged: number
  usage_complete: number
}

const pending = new WeakMap<Database, Map<string, QuotaSettlementInput>>()

function readQuota(db: Database, upstreamId: string): QuotaRow {
  const row = db.query("SELECT quota, quota_window_id FROM providers WHERE id = ?").get(upstreamId) as QuotaRow | null
  if (!row) throw new RoutingError("Upstream not found", "not_found", 404)
  return row
}

function newWindow(db: Database, upstreamId: string, policy: QuotaPolicy, now: number): QuotaWindow {
  const duration = policy.window_minutes * 60000
  const start = now < policy.next_reset_at ? now : policy.next_reset_at + Math.floor((now - policy.next_reset_at) / duration) * duration
  const end = now < policy.next_reset_at ? policy.next_reset_at : start + duration
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) throw new Error("Invalid quota window")
  const id = crypto.randomUUID()
  db.query("INSERT INTO quota_windows (id, upstream_id, starts_at, ends_at) VALUES (?, ?, ?, ?)").run(id, upstreamId, start, end)
  db.query("UPDATE providers SET quota_window_id = ? WHERE id = ?").run(id, upstreamId)
  return { id, upstream_id: upstreamId, starts_at: start, ends_at: end, charged: 0, usage_complete: 1 }
}

function currentWindow(db: Database, upstreamId: string, row: QuotaRow, policy: QuotaPolicy, now: number): QuotaWindow {
  if (row.quota_window_id === null) return newWindow(db, upstreamId, policy, now)
  const window = db.query("SELECT * FROM quota_windows WHERE id = ?").get(row.quota_window_id) as QuotaWindow | null
  if (!window || window.upstream_id !== upstreamId || window.ends_at <= window.starts_at
    || !Number.isFinite(window.charged) || window.charged < 0 || now < window.starts_at) {
    throw new Error("Invalid stored quota window")
  }
  return now < window.ends_at ? window : newWindow(db, upstreamId, { ...policy, next_reset_at: window.ends_at }, now)
}

export function saveQuotaPolicy(db: Database, upstreamId: string, policy: QuotaPolicy | null, now = Date.now()): void {
  db.transaction(() => {
    const row = readQuota(db, upstreamId)
    if (policy === null) {
      db.query("UPDATE providers SET quota = NULL, quota_window_id = NULL WHERE id = ?").run(upstreamId)
      return
    }
    const next = validateQuota(policy)
    const previous = row.quota === null ? null : validateQuota(JSON.parse(row.quota))
    if (previous === null) {
      newWindow(db, upstreamId, next, now)
    } else if (next.next_reset_at !== previous.next_reset_at && next.next_reset_at <= now) {
      newWindow(db, upstreamId, next, now)
    } else {
      const window = currentWindow(db, upstreamId, row, previous, now)
      if (next.next_reset_at !== previous.next_reset_at) {
        db.query("UPDATE quota_windows SET ends_at = ? WHERE id = ?").run(next.next_reset_at, window.id)
      }
    }
    db.query("UPDATE providers SET quota = ? WHERE id = ?").run(JSON.stringify(next), upstreamId)
  }).immediate()
}

function hasPending(db: Database, upstreamId: string): boolean {
  return [...(pending.get(db)?.values() ?? [])].some((entry) => entry.capture.upstream_id === upstreamId)
}

export function getQuotaStatus(db: Database, upstreamId: string, now = Date.now()): QuotaStatus {
  const status: QuotaStatus = {
    window_id: null, starts_at: null, ends_at: null, used_tokens: 0,
    limit_tokens: null, remaining_tokens: null, multiplier: 1,
    healthy: !hasPending(db, upstreamId), usage_complete: true,
  }
  try {
    return db.transaction(() => {
      const row = readQuota(db, upstreamId)
      if (row.quota === null) {
        status.usage_complete = db.query("SELECT 1 FROM quota_settlements WHERE upstream_id = ? AND usage_complete = 0 LIMIT 1").get(upstreamId) === null
        return status
      }
      const policy = validateQuota(JSON.parse(row.quota))
      status.limit_tokens = policy.limit_tokens
      status.multiplier = matchingInterval(policy.mode, policy.multipliers, now)?.multiplier ?? 1
      const window = currentWindow(db, upstreamId, row, policy, now)
      return {
        ...status, window_id: window.id, starts_at: window.starts_at, ends_at: window.ends_at,
        used_tokens: window.charged, remaining_tokens: Math.max(0, policy.limit_tokens - window.charged),
        usage_complete: window.usage_complete === 1,
      }
    }).immediate()
  } catch (error) {
    if (error instanceof RoutingError && error.status === 404) throw error
    return { ...status, healthy: false, usage_complete: false }
  }
}

function weightedDebit(input: QuotaSettlementInput): number {
  const { capture, usage } = input
  if (!input.request_id || !Number.isSafeInteger(input.attempt_ordinal) || input.attempt_ordinal < 0
    || !capture.upstream_id || !Number.isSafeInteger(capture.captured_at)
    || !Number.isFinite(capture.multiplier) || capture.multiplier <= 0) {
    throw new RoutingError("Invalid quota settlement identity or capture")
  }
  const buckets = [usage.input_tokens, usage.cache_read_tokens, usage.cache_write_tokens, usage.output_tokens]
  if (buckets.some((value) => value !== null && (!Number.isFinite(value) || value < 0))) throw new RoutingError("Invalid normalized usage")
  const debit = buckets.reduce<number>((total, value) => total + (value ?? 0), 0) * capture.multiplier
  if (!Number.isFinite(debit)) throw new RoutingError("Quota debit must be finite")
  return debit
}

function writeSettlement(db: Database, input: QuotaSettlementInput, debit: number): boolean {
  return db.transaction(() => {
    const { capture, usage } = input
    const present = usage.usage_present ?? [usage.input_tokens, usage.cache_read_tokens, usage.cache_write_tokens, usage.output_tokens].some((value) => value !== null)
    const complete = present && usage.complete
    const result = db.query(`INSERT INTO quota_settlements
      (request_id, attempt_ordinal, upstream_id, window_id, captured_at, usage_present, usage_complete,
       input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, multiplier, weighted_debit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id, attempt_ordinal) DO NOTHING`).run(
      input.request_id, input.attempt_ordinal, capture.upstream_id, capture.window_id, capture.captured_at,
      present ? 1 : 0, complete ? 1 : 0, usage.input_tokens, usage.cache_read_tokens,
      usage.cache_write_tokens, usage.output_tokens, capture.multiplier, debit,
    )
    if (result.changes === 0) return false
    if (capture.window_id !== null) {
      const updated = db.query(`UPDATE quota_windows SET charged = charged + ?, usage_complete = MIN(usage_complete, ?)
        WHERE id = ? AND upstream_id = ? AND charged <= ?`).run(debit, complete ? 1 : 0, capture.window_id, capture.upstream_id, Number.MAX_VALUE - debit)
      if (updated.changes !== 1) throw new Error("Captured quota window is unavailable")
    }
    return true
  }).immediate()
}

export function settleQuota(db: Database, input: QuotaSettlementInput): QuotaSettlementResult {
  const key = JSON.stringify([input.request_id, input.attempt_ordinal])
  const retained = pending.get(db)?.get(key) ?? input
  const debit = weightedDebit(retained)
  try {
    const inserted = writeSettlement(db, retained, debit)
    pending.get(db)?.delete(key)
    return { committed: true, duplicate: !inserted, weighted_debit: debit, error: null }
  } catch (error) {
    let queue = pending.get(db)
    if (!queue) {
      queue = new Map()
      pending.set(db, queue)
    }
    if (!queue.has(key)) queue.set(key, structuredClone(retained))
    return { committed: false, duplicate: false, weighted_debit: debit, error: error instanceof Error ? error.message : "Quota settlement storage failed" }
  }
}

export function recoverQuotaSettlements(db: Database, upstreamId: string): boolean {
  const queue = pending.get(db)
  if (!queue) return true
  for (const [key, input] of queue) {
    if (input.capture.upstream_id !== upstreamId) continue
    try {
      writeSettlement(db, input, weightedDebit(input))
      queue.delete(key)
    } catch {
      return false
    }
  }
  return !hasPending(db, upstreamId)
}
