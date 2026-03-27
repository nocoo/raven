import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createSettingsRoute } from "../../src/routes/settings.ts";
import { initSettings, getSetting, setSetting } from "../../src/db/settings.ts";
import { cacheServerTools } from "../../src/lib/utils.ts";
import { state } from "../../src/lib/state.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSettings(db);
  // Reset state to defaults
  state.optSanitizeOrphanedToolResults = false;
  state.optReorderToolResults = false;
  state.optFilterWhitespaceChunks = false;
  state.optToolCallDebug = false;
  state.stWebSearchEnabled = false;
  state.stWebSearchApiKey = null;
});

afterEach(() => {
  db.close();
});

describe("settings route", () => {
  describe("GET /settings", () => {
    test("returns default settings snapshot", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings");
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body).toHaveProperty("vscode_version");
      expect(body).toHaveProperty("copilot_chat_version");
      expect(body).toHaveProperty("optimizations");
      expect(body).toHaveProperty("debug");
      expect(body).toHaveProperty("server_tools");
    });

    test("server_tools reflects default state", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings");
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.server_tools.web_search.enabled).toBe(false);
      expect(body.server_tools.web_search.has_api_key).toBe(false);
    });
  });

  describe("PUT /settings", () => {
    test("rejects unknown key", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "unknown_key", value: "true" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("validation_error");
    });

    test("rejects missing key", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "true" }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects missing value", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "st_web_search_enabled" }),
      });
      expect(res.status).toBe(400);
    });

    describe("server tool settings", () => {
      test("sets st_web_search_enabled to true", async () => {
        const app = createSettingsRoute(db);
        const res = await app.request("/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "st_web_search_enabled", value: "true" }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.server_tools.web_search.enabled).toBe(true);
        expect(state.stWebSearchEnabled).toBe(true);
      });

      test("sets st_web_search_enabled to false", async () => {
        setSetting(db, "st_web_search_enabled", "true");
        cacheServerTools(db);

        const app = createSettingsRoute(db);
        const res = await app.request("/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "st_web_search_enabled", value: "false" }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.server_tools.web_search.enabled).toBe(false);
        expect(state.stWebSearchEnabled).toBe(false);
      });

      test("rejects invalid boolean for st_web_search_enabled", async () => {
        const app = createSettingsRoute(db);
        const res = await app.request("/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "st_web_search_enabled", value: "yes" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.type).toBe("validation_error");
      });

      test("sets st_web_search_api_key", async () => {
        const app = createSettingsRoute(db);
        const res = await app.request("/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "st_web_search_api_key",
            value: "tvly-test-key-12345",
          }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.server_tools.web_search.has_api_key).toBe(true);
        expect(state.stWebSearchApiKey).toBe("tvly-test-key-12345");
      });

      test("API key is not returned in response", async () => {
        setSetting(db, "st_web_search_api_key", "tvly-secret-key");
        cacheServerTools(db);

        const app = createSettingsRoute(db);
        const res = await app.request("/settings");
        expect(res.status).toBe(200);
        const body = await res.json();

        // Response should not contain the actual API key
        expect(JSON.stringify(body)).not.toContain("tvly-secret-key");
        // But should indicate key is present
        expect(body.server_tools.web_search.has_api_key).toBe(true);
      });
    });
  });

  describe("DELETE /settings/:key", () => {
    test("deletes st_web_search_enabled override", async () => {
      setSetting(db, "st_web_search_enabled", "true");
      cacheServerTools(db);

      const app = createSettingsRoute(db);
      const res = await app.request("/settings/st_web_search_enabled", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.server_tools.web_search.enabled).toBe(false);
      expect(getSetting(db, "st_web_search_enabled")).toBeNull();
    });

    test("deletes st_web_search_api_key", async () => {
      setSetting(db, "st_web_search_api_key", "tvly-test-key");
      cacheServerTools(db);

      const app = createSettingsRoute(db);
      const res = await app.request("/settings/st_web_search_api_key", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.server_tools.web_search.has_api_key).toBe(false);
      expect(getSetting(db, "st_web_search_api_key")).toBeNull();
    });

    test("rejects unknown key", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings/unknown_key", {
        method: "DELETE",
      });
      expect(res.status).toBe(400);
    });
  });
});
