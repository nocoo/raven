import type { Database } from "bun:sqlite"
import { RoutingError, type CatalogModel } from "../core/routing-types.ts"
import { getProviderRecord, listProviderRecords } from "./providers.ts"

export function replaceCatalog<T extends { id: string }>(db: Database, upstreamId: string, models: readonly T[], now = Date.now()): void {
  if (!Array.isArray(models) || models.some((model) => !model || typeof model.id !== "string" || !model.id.trim())) {
    throw new RoutingError("Catalog must contain models with nonempty raw IDs")
  }
  const unique = [...new Map(models.map((model) => [model.id, model])).values()]
  const result = db.query("UPDATE providers SET models = ?, last_refreshed_at = ?, last_refresh_error = NULL WHERE id = ?").run(JSON.stringify(unique), now, upstreamId)
  if (result.changes === 0) throw new RoutingError("Upstream not found", "not_found", 404)
}

export function recordCatalogError(db: Database, upstreamId: string, error: unknown): void {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const status = /\b(?:HTTP|status)\s*[:=]?\s*([45]\d{2})\b/i.exec(text)?.[1]
  const message = status ? `Model catalog refresh failed (HTTP ${status})` : "Model catalog refresh failed"
  if (db.query("UPDATE providers SET last_refresh_error = ? WHERE id = ?").run(message, upstreamId).changes === 0) {
    throw new RoutingError("Upstream not found", "not_found", 404)
  }
}

export function getCatalog(db: Database, upstreamId: string): CatalogModel[] {
  const upstream = getProviderRecord(db, upstreamId)
  if (!upstream) throw new RoutingError("Upstream not found", "not_found", 404)
  const models = new Map(upstream.models.map((model) => [model.id, model]))
  for (const id of upstream.manual_models) if (!models.has(id)) models.set(id, { id })
  return [...models.values()]
}

function copilotMetadata(model: CatalogModel): Record<string, unknown> {
  const capabilities = model.capabilities as { type?: unknown; limits?: Record<string, unknown>; supports?: Record<string, unknown> } | null | undefined
  const limits = capabilities?.limits
  const supports = capabilities?.supports
  const metadata: Record<string, unknown> = {}
  if (typeof model.name === "string" && model.name.trim()) metadata.display_name = model.name
  for (const [source, targets] of [
    ["max_context_window_tokens", ["context_length", "context_window"]],
    ["max_prompt_tokens", ["max_input_tokens"]],
    ["max_output_tokens", ["max_output_tokens"]],
  ] as const) {
    const value = limits?.[source]
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      for (const target of targets) metadata[target] = value
    }
  }
  if (capabilities?.type === "chat" && supports?.vision === true) metadata.modalities = { input: ["text", "image"] }
  if (typeof supports?.tool_calls === "boolean") metadata.tool_call = supports.tool_calls
  const levels = supports?.reasoning_effort
  if (Array.isArray(levels) && levels.every((level) => typeof level === "string" && level.trim())) {
    metadata.reasoning = levels.length > 0
    metadata.reasoning_levels = levels
    metadata.supported_reasoning_levels = levels.map((effort) => ({ effort }))
  }
  return metadata
}

export function projectCatalog(db: Database): CatalogModel[] {
  const models = new Map<string, CatalogModel>([["auto", { id: "auto", object: "model", owned_by: "raven" }]])
  for (const upstream of listProviderRecords(db)) {
    for (const model of upstream.models) if (!models.has(model.id)) models.set(model.id, {
      ...model,
      ...(upstream.kind === "copilot" ? copilotMetadata(model) : {}),
      object: model.object ?? "model",
      owned_by: model.owned_by ?? model.vendor ?? upstream.name,
    })
    for (const id of upstream.manual_models) if (!models.has(id)) models.set(id, { id, object: "model", owned_by: upstream.name })
  }
  return [...models.values()]
}
