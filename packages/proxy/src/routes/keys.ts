import type { Database } from "bun:sqlite"
import { Hono } from "hono"
import { RoutingError } from "../core/routing-types.ts"
import { createApiKey, deleteApiKey, listApiKeys, revokeApiKey, updateApiKeyRule } from "../db/keys.ts"
import { createKeySchema, parseInput, updateKeySchema } from "../db/routing-validation.ts"

export function createKeysRoute(db: Database): Hono {
  const route = new Hono()
  route.onError((error, c) => {
    if (error instanceof RoutingError) return c.json({ error: { type: error.type, message: error.message, references: error.references } }, error.status)
    if (error instanceof SyntaxError) return c.json({ error: { type: "validation_error", message: "Invalid JSON body" } }, 400)
    return c.json({ error: { type: "internal_error", message: "Key operation failed" } }, 500)
  })
  route.get("/keys", (c) => c.json(listApiKeys(db)))
  route.post("/keys", async (c) => {
    const input = parseInput(createKeySchema, await c.req.json())
    const key = createApiKey(db, input.name, input.rule_id)
    return c.json(key, 201)
  })
  route.patch("/keys/:id", async (c) => {
    const input = parseInput(updateKeySchema, await c.req.json())
    const key = updateApiKeyRule(db, c.req.param("id"), input.rule_id)
    if (!key) throw new RoutingError("Key not found", "not_found", 404)
    return c.json(key)
  })
  route.post("/keys/:id/revoke", (c) => {
    if (!revokeApiKey(db, c.req.param("id"))) throw new RoutingError("Key not found or already revoked", "not_found", 404)
    return c.json({ ok: true })
  })
  route.delete("/keys/:id", (c) => {
    if (!deleteApiKey(db, c.req.param("id"))) throw new RoutingError("Key not found", "not_found", 404)
    return c.json({ success: true })
  })
  return route
}
