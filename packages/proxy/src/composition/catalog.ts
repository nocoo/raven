import type { Database } from "bun:sqlite"
import { COPILOT_UPSTREAM_ID, RoutingError } from "../core/routing-types"
import { getProviderRecord } from "../db/providers"
import { recordCatalogError, replaceCatalog } from "../db/catalog"
import { state } from "../lib/state"
import type { Model } from "../services/copilot/get-models"
import { discoverModels } from "../upstream/catalog"

const activeRefreshes = new WeakMap<Database, Map<string, Promise<void>>>()

export function restoreCopilotCatalog(db: Database): void {
  const provider = getProviderRecord(db, COPILOT_UPSTREAM_ID)
  state.models = provider?.last_refreshed_at === null || !provider
    ? null
    : { object: "list", data: provider.models as unknown as Model[] }
}

export function refreshCatalog(db: Database, id: string, now = Date.now()): Promise<void> {
  let active = activeRefreshes.get(db)
  if (!active) {
    active = new Map()
    activeRefreshes.set(db, active)
  }
  const pending = active.get(id)
  if (pending) return pending
  const provider = getProviderRecord(db, id)
  if (!provider) return Promise.reject(new RoutingError("Upstream not found", "not_found", 404))
  const task = (async () => {
    try {
      const models = await discoverModels(provider)
      replaceCatalog(db, id, models, now)
      if (provider.kind === "copilot") restoreCopilotCatalog(db)
    } catch (error) {
      const message = error instanceof RoutingError && error.type === "catalog_refresh_failed"
        ? error.message
        : "Model refresh failed. Check the saved endpoint and credentials."
      recordCatalogError(db, id, message)
      throw new RoutingError(message, "catalog_refresh_failed", 503, [], error instanceof RoutingError ? error.details : undefined)
    } finally {
      active?.delete(id)
    }
  })()
  active.set(id, task)
  return task
}

export function startCopilotCatalogRefresh(db: Database, intervalMs = 60 * 60 * 1000): () => void {
  let running = false
  let stopped = false
  const refresh = async () => {
    if (running || stopped) return
    running = true
    try { await refreshCatalog(db, COPILOT_UPSTREAM_ID) } catch { /* The persisted error is visible in Upstreams. */ }
    finally { running = false }
  }
  const initial = setTimeout(() => { void refresh() }, 0)
  const timer = setInterval(() => { void refresh() }, intervalMs)
  initial.unref()
  timer.unref()
  return () => {
    stopped = true
    clearTimeout(initial)
    clearInterval(timer)
  }
}
