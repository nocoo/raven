import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initSettings,
  getSetting,
  setSetting,
  deleteSetting,
  getAllSettings,
} from "../../src/db/settings.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSettings(db);
});

afterEach(() => {
  db.close();
});

describe("initSettings", () => {
  test("creates settings table", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
      .all();
    expect(tables.length).toBe(1);
  });

  test("is idempotent", () => {
    initSettings(db);
    initSettings(db);
    // No error
  });
});

describe("getSetting", () => {
  test("returns null for nonexistent key", () => {
    const result = getSetting(db, "nonexistent");
    expect(result).toBeNull();
  });

  test("returns value for existing key", () => {
    setSetting(db, "theme", "dark");
    const result = getSetting(db, "theme");
    expect(result).toBe("dark");
  });

  test("returns null for empty string key that does not exist", () => {
    const result = getSetting(db, "");
    expect(result).toBeNull();
  });

  test("handles special characters in key", () => {
    setSetting(db, "key:with:colons", "value");
    expect(getSetting(db, "key:with:colons")).toBe("value");
  });

  test("handles unicode keys", () => {
    setSetting(db, "日本語キー", "value");
    expect(getSetting(db, "日本語キー")).toBe("value");
  });
});

describe("setSetting", () => {
  test("inserts new setting", () => {
    setSetting(db, "language", "en");
    const result = getSetting(db, "language");
    expect(result).toBe("en");
  });

  test("updates existing setting", () => {
    setSetting(db, "count", "10");
    setSetting(db, "count", "20");
    const result = getSetting(db, "count");
    expect(result).toBe("20");
  });

  test("handles empty string value", () => {
    setSetting(db, "empty", "");
    expect(getSetting(db, "empty")).toBe("");
  });

  test("handles unicode values", () => {
    setSetting(db, "greeting", "こんにちは");
    expect(getSetting(db, "greeting")).toBe("こんにちは");
  });

  test("handles very long values", () => {
    const longValue = "x".repeat(10000);
    setSetting(db, "long", longValue);
    expect(getSetting(db, "long")).toBe(longValue);
  });

  test("handles special characters in value", () => {
    setSetting(db, "special", "val'ue\"with\\special");
    expect(getSetting(db, "special")).toBe("val'ue\"with\\special");
  });
});

describe("deleteSetting", () => {
  test("returns false for nonexistent key", () => {
    const result = deleteSetting(db, "nonexistent");
    expect(result).toBe(false);
  });

  test("returns true and removes existing key", () => {
    setSetting(db, "to-delete", "value");
    const result = deleteSetting(db, "to-delete");
    expect(result).toBe(true);
    expect(getSetting(db, "to-delete")).toBeNull();
  });

  test("returns false when deleting same key twice", () => {
    setSetting(db, "once", "value");
    expect(deleteSetting(db, "once")).toBe(true);
    expect(deleteSetting(db, "once")).toBe(false);
  });
});

describe("getAllSettings", () => {
  test("returns empty object when no settings", () => {
    const result = getAllSettings(db);
    expect(result).toEqual({});
  });

  test("returns all settings as key-value pairs", () => {
    setSetting(db, "a", "1");
    setSetting(db, "b", "2");
    setSetting(db, "c", "3");
    const result = getAllSettings(db);
    expect(result).toEqual({ a: "1", b: "2", c: "3" });
  });

  test("reflects latest values after updates", () => {
    setSetting(db, "key", "old");
    setSetting(db, "key", "new");
    const result = getAllSettings(db);
    expect(result).toEqual({ key: "new" });
  });

  test("excludes deleted settings", () => {
    setSetting(db, "keep", "yes");
    setSetting(db, "delete", "no");
    deleteSetting(db, "delete");
    const result = getAllSettings(db);
    expect(result).toEqual({ keep: "yes" });
  });
});
