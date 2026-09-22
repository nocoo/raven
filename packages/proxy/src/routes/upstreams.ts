import type { Database } from "bun:sqlite"
import { Hono } from "hono"
import { RoutingError } from "../core/routing-types"
import { createProvider, deleteProvider, getProvider, listProviders, updateProvider } from "../db/providers"
import { getRoutingMigrationSummary } from "../db/routing-migration"
import { refreshCatalog } from "../composition/catalog"
import { runUpstreamDiagnostic } from "../composition/diagnostic"
import { forwardError } from "../lib/error"

export function createUpstreamsRoute(db: Database): Hono {
  const route = new Hono()
  route.onError((error, c) => {
    if (error instanceof RoutingError) return c.json({ error: { type: error.type, message: error.message, references: error.references } }, error.status)
    if (error instanceof SyntaxError) return c.json({ error: { type: "validation_error", message: "Invalid JSON body" } }, 400)
    return forwardError(c, error)
  })
  route.get("/upstreams", (c) => c.json(listProviders(db)))
  route.get("/upstreams/migration", (c) => c.json(getRoutingMigrationSummary(db)))
  route.post("/upstreams", async (c) => c.json(createProvider(db, await c.req.json()), 201))
  route.get("/upstreams/:id", (c) => {
    const provider = getProvider(db, c.req.param("id"))
    if (!provider) throw new RoutingError("Upstream not found", "not_found", 404)
    return c.json(provider)
  })
  route.put("/upstreams/:id", async (c) => {
    const provider = updateProvider(db, c.req.param("id"), await c.req.json())
    if (!provider) throw new RoutingError("Upstream not found", "not_found", 404)
    return c.json(provider)
  })
  route.delete("/upstreams/:id", (c) => {
    if (!deleteProvider(db, c.req.param("id"))) throw new RoutingError("Upstream not found", "not_found", 404)
    return c.json({ success: true })
  })
  route.post("/upstreams/:id/models/refresh", async (c) => {
    const id = c.req.param("id")
    await refreshCatalog(db, id)
    return c.json(getProvider(db, id))
  })
  route.post("/upstreams/:id/test", async (c) => {
    const body: unknown = await c.req.json()
    if (!body || typeof body !== "object" || !("model" in body) || typeof body.model !== "string") throw new RoutingError("A model is required")
    return c.json(await runUpstreamDiagnostic(c, db, c.req.param("id"), body.model))
  })
  return route
}
