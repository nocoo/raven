import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  deleteApiKey,
} from "../db/keys.ts";
import { invalidateKeyCountCache } from "../middleware.ts";

/**
 * Create CRUD routes for API key management.
 * Mounted at /api in app.ts, so paths become /api/keys, /api/keys/:id, etc.
 */
export function createKeysRoute(db: Database): Hono {
  const route = new Hono();

  // List all keys
  route.get("/keys", (c) => {
    const keys = listApiKeys(db);
    return c.json(keys);
  });

  // Create a new key
  route.post("/keys", async (c) => {
    const body = await c.req.json<{ name?: string }>();
    const name = body.name?.trim();

    if (!name) {
      return c.json(
        { error: { type: "validation_error", message: "name is required" } },
        400,
      );
    }
    if (name.length > 64) {
      return c.json(
        { error: { type: "validation_error", message: "name must be <= 64 characters" } },
        400,
      );
    }

    const created = createApiKey(db, name);
    invalidateKeyCountCache();
    return c.json(created, 201);
  });

  // Revoke a key (soft delete)
  route.post("/keys/:id/revoke", (c) => {
    const id = c.req.param("id");
    const ok = revokeApiKey(db, id);
    if (!ok) {
      return c.json(
        { error: { type: "not_found", message: "Key not found or already revoked" } },
        404,
      );
    }
    return c.json({ ok: true });
  });

  // Delete a key (hard delete)
  route.delete("/keys/:id", (c) => {
    const id = c.req.param("id");
    const ok = deleteApiKey(db, id);
    if (!ok) {
      return c.json(
        { error: { type: "not_found", message: "Key not found" } },
        404,
      );
    }
    invalidateKeyCountCache();
    return c.json({ ok: true });
  });

  return route;
}
