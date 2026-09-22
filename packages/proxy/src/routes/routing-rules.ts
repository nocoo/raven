import type { Database } from "bun:sqlite"
import { Hono } from "hono"
import { RoutingError } from "../core/routing-types.ts"
import { createRoutingRule, deleteRoutingRule, getRoutingRule, listRoutingRules, updateRoutingRule } from "../db/routing-rules.ts"

export function createRoutingRulesRoute(db: Database): Hono {
  const route = new Hono()
  route.onError((error, c) => {
    if (error instanceof RoutingError) return c.json({ error: { type: error.type, message: error.message, references: error.references } }, error.status)
    if (error instanceof SyntaxError) return c.json({ error: { type: "validation_error", message: "Invalid JSON body" } }, 400)
    return c.json({ error: { type: "internal_error", message: "Routing rule operation failed" } }, 500)
  })
  route.get("/routing-rules", (c) => c.json(listRoutingRules(db)))
  route.post("/routing-rules", async (c) => c.json(createRoutingRule(db, await c.req.json()), 201))
  route.get("/routing-rules/:id", (c) => {
    const rule = getRoutingRule(db, c.req.param("id"))
    if (!rule) throw new RoutingError("Routing rule not found", "not_found", 404)
    return c.json(rule)
  })
  route.put("/routing-rules/:id", async (c) => {
    const rule = updateRoutingRule(db, c.req.param("id"), await c.req.json())
    if (!rule) throw new RoutingError("Routing rule not found", "not_found", 404)
    return c.json(rule)
  })
  route.delete("/routing-rules/:id", (c) => {
    if (!deleteRoutingRule(db, c.req.param("id"))) throw new RoutingError("Routing rule not found", "not_found", 404)
    return c.json({ success: true })
  })
  return route
}
