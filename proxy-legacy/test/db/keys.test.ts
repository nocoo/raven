import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initApiKeys,
  createApiKey,
  validateApiKey,
  listApiKeys,
  revokeApiKey,
  deleteApiKey,
  getKeyCount,
} from "../../src/db/keys.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initApiKeys(db);
});

afterEach(() => {
  db.close();
});

describe("initApiKeys", () => {
  test("creates api_keys table", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'")
      .all();
    expect(tables.length).toBe(1);
  });

  test("is idempotent", () => {
    initApiKeys(db);
    initApiKeys(db);
    // No error
  });
});

describe("createApiKey", () => {
  test("returns full key with rk- prefix", () => {
    const result = createApiKey(db, "test-key");
    expect(result.key).toStartWith("rk-");
    expect(result.key.length).toBe(67); // rk- + 64 hex chars
  });

  test("stores record in DB", () => {
    const result = createApiKey(db, "test-key");
    expect(result.name).toBe("test-key");
    expect(result.key_prefix).toStartWith("rk-");
    expect(result.key_prefix.length).toBe(12);
    expect(result.created_at).toBeGreaterThan(0);
    expect(result.last_used_at).toBeNull();
    expect(result.revoked_at).toBeNull();
  });

  test("generates unique keys", () => {
    const a = createApiKey(db, "key-a");
    const b = createApiKey(db, "key-b");
    expect(a.key).not.toBe(b.key);
    expect(a.id).not.toBe(b.id);
  });
});

describe("validateApiKey", () => {
  test("returns record for valid key", () => {
    const created = createApiKey(db, "valid-key");
    const result = validateApiKey(db, created.key);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("valid-key");
  });

  test("updates last_used_at on validation", () => {
    const created = createApiKey(db, "used-key");
    expect(created.last_used_at).toBeNull();

    validateApiKey(db, created.key);
    // last_used_at is updated in the DB
    const keys = listApiKeys(db);
    const updated = keys.find((k) => k.id === created.id);
    expect(updated!.last_used_at).toBeGreaterThan(0);
  });

  test("returns null for unknown key", () => {
    const result = validateApiKey(db, "rk-0000000000000000000000000000000000000000000000000000000000000000");
    expect(result).toBeNull();
  });

  test("returns null for revoked key", () => {
    const created = createApiKey(db, "revoked-key");
    revokeApiKey(db, created.id);
    const result = validateApiKey(db, created.key);
    expect(result).toBeNull();
  });
});

describe("listApiKeys", () => {
  test("returns empty array when no keys", () => {
    expect(listApiKeys(db)).toEqual([]);
  });

  test("returns all keys", () => {
    createApiKey(db, "first");
    createApiKey(db, "second");
    const keys = listApiKeys(db);
    expect(keys.length).toBe(2);
    const names = keys.map((k) => k.name).sort();
    expect(names).toEqual(["first", "second"]);
  });

  test("does not expose key_hash", () => {
    createApiKey(db, "test");
    const keys = listApiKeys(db);
    expect(keys[0]).not.toHaveProperty("key_hash");
  });
});

describe("revokeApiKey", () => {
  test("sets revoked_at timestamp", () => {
    const created = createApiKey(db, "to-revoke");
    const ok = revokeApiKey(db, created.id);
    expect(ok).toBe(true);

    const keys = listApiKeys(db);
    expect(keys[0].revoked_at).toBeGreaterThan(0);
  });

  test("returns false for already-revoked key", () => {
    const created = createApiKey(db, "already-revoked");
    revokeApiKey(db, created.id);
    const ok = revokeApiKey(db, created.id);
    expect(ok).toBe(false);
  });

  test("returns false for nonexistent id", () => {
    expect(revokeApiKey(db, "nonexistent")).toBe(false);
  });
});

describe("deleteApiKey", () => {
  test("removes key from DB", () => {
    const created = createApiKey(db, "to-delete");
    const ok = deleteApiKey(db, created.id);
    expect(ok).toBe(true);
    expect(listApiKeys(db)).toEqual([]);
  });

  test("returns false for nonexistent id", () => {
    expect(deleteApiKey(db, "nonexistent")).toBe(false);
  });
});

describe("getKeyCount", () => {
  test("returns 0 when no keys", () => {
    expect(getKeyCount(db)).toBe(0);
  });

  test("counts all keys including revoked", () => {
    const created = createApiKey(db, "active");
    createApiKey(db, "also-active");
    revokeApiKey(db, created.id);
    expect(getKeyCount(db)).toBe(2);
  });
});
