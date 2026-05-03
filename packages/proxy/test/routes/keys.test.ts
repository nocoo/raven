import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { createKeysRoute } from "../../src/routes/keys.ts";
import { initApiKeys, createApiKey, listApiKeys } from "../../src/db/keys.ts";
import { invalidateKeyCountCache } from "../../src/middleware.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initApiKeys(db);
  invalidateKeyCountCache();
});

afterEach(() => {
  db.close();
});

describe("keys route", () => {
  test("GET /keys returns empty list", async () => {
    const app = createKeysRoute(db);
    const res = await app.request("/keys");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  test("POST /keys creates a key", async () => {
    const app = createKeysRoute(db);
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-key" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("test-key");
    expect(body.key).toMatch(/^rk-/);
    expect(body.key.length).toBe(67);
  });

  test("POST /keys rejects empty name", async () => {
    const app = createKeysRoute(db);
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /keys rejects name > 64 chars", async () => {
    const app = createKeysRoute(db);
    const res = await app.request("/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "a".repeat(65) }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /keys/:id/revoke revokes a key", async () => {
    const created = createApiKey(db, "to-revoke");
    const app = createKeysRoute(db);
    const res = await app.request(`/keys/${created.id}/revoke`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const keys = listApiKeys(db);
    expect(keys[0]!.revoked_at).not.toBeNull();
  });

  test("POST /keys/:id/revoke returns 404 for unknown id", async () => {
    const app = createKeysRoute(db);
    const res = await app.request("/keys/unknown/revoke", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("DELETE /keys/:id deletes a key", async () => {
    const created = createApiKey(db, "to-delete");
    const app = createKeysRoute(db);
    const res = await app.request(`/keys/${created.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(listApiKeys(db)).toEqual([]);
  });

  test("DELETE /keys/:id returns 404 for unknown id", async () => {
    const app = createKeysRoute(db);
    const res = await app.request("/keys/unknown", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
