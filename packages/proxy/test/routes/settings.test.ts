import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { Database } from "bun:sqlite";

// Stub the local-detection and AUR-fetch helpers that cacheVersions() awaits.
// Without these, PUT/DELETE /settings handlers reach out to the network
// (AUR pkgbuild) and the filesystem (~/.vscode/extensions), which races
// vitest's default 5s test timeout on slow CI runners and trips
// "Cannot use a closed database" when the deferred work outlives afterEach.
vi.mock("../../src/services/get-vscode-version", () => ({
  getVSCodeVersion: () => Promise.resolve(undefined),
}));
vi.mock("../../src/services/detect-local-versions", () => ({
  detectLocalVSCodeVersion: () => Promise.resolve(null),
  detectLocalCopilotVersion: () => Promise.resolve(null),
}));

const { createSettingsRoute } = await import("../../src/routes/settings.ts");
const { initSettings, getSetting, setSetting } = await import("../../src/db/settings.ts");
const { cacheServerTools, cacheIPWhitelist, cacheOptimizations, cacheCorsSettings } = await import("../../src/lib/utils.ts");
const { state } = await import("../../src/lib/state.ts");

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSettings(db);
  // Reset state to defaults
  state.optSanitizeOrphanedToolResults = false;
  state.optReorderToolResults = false;
  state.optToolCallDebug = false;
  state.stWebSearchEnabled = false;
  state.stWebSearchApiKey = null;
  state.ipWhitelistEnabled = false;
  state.ipWhitelistRanges = [];
  state.ipWhitelistTrustProxy = false;
  state.corsEnabled = false;
  state.corsAllowedOrigins = [];
  state.vsCodeVersion = "1.117.0";
  state.vsCodeVersionSource = "fallback";
  state.copilotChatVersion = "0.45.1";
  state.copilotChatVersionSource = "fallback";
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

  describe("IP whitelist settings", () => {
    test("GET /settings returns ip_whitelist section", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("ip_whitelist");
      expect(body.ip_whitelist).toEqual({ enabled: false, trust_proxy: false, ranges: [] });
    });

    test("sets ip_whitelist_enabled to true", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "ip_whitelist_enabled", value: "true" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ip_whitelist.enabled).toBe(true);
      expect(state.ipWhitelistEnabled).toBe(true);
    });

    test("sets ip_whitelist_enabled to false", async () => {
      setSetting(db, "ip_whitelist_enabled", "true");
      cacheIPWhitelist(db);

      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "ip_whitelist_enabled", value: "false" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ip_whitelist.enabled).toBe(false);
      expect(state.ipWhitelistEnabled).toBe(false);
    });

    test("rejects invalid boolean for ip_whitelist_enabled", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "ip_whitelist_enabled", value: "yes" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("validation_error");
    });

    test("sets ip_whitelist_ranges with valid ranges", async () => {
      const app = createSettingsRoute(db);
      const ranges = ["192.168.1.0/24", "10.0.0.1", "172.16.0.1-172.16.0.100"];
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "ip_whitelist_ranges",
          value: JSON.stringify(ranges),
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ip_whitelist.ranges).toEqual(ranges);
      expect(state.ipWhitelistRanges).toHaveLength(3);
    });

    test("rejects invalid JSON for ip_whitelist_ranges", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "ip_whitelist_ranges",
          value: "not json",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("validation_error");
    });

    test("rejects invalid IP range in ip_whitelist_ranges", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "ip_whitelist_ranges",
          value: JSON.stringify(["invalid-ip", "192.168.1.1"]),
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("validation_error");
    });

    test("deletes ip_whitelist_enabled", async () => {
      setSetting(db, "ip_whitelist_enabled", "true");
      cacheIPWhitelist(db);

      const app = createSettingsRoute(db);
      const res = await app.request("/settings/ip_whitelist_enabled", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ip_whitelist.enabled).toBe(false);
    });

    test("deletes ip_whitelist_ranges", async () => {
      setSetting(db, "ip_whitelist_ranges", '["192.168.1.0/24"]');
      cacheIPWhitelist(db);

      const app = createSettingsRoute(db);
      const res = await app.request("/settings/ip_whitelist_ranges", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ip_whitelist.ranges).toEqual([]);
    });

    test("sets ip_whitelist_trust_proxy to true", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "ip_whitelist_trust_proxy", value: "true" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ip_whitelist.trust_proxy).toBe(true);
      expect(state.ipWhitelistTrustProxy).toBe(true);
    });

    test("sets ip_whitelist_trust_proxy to false", async () => {
      setSetting(db, "ip_whitelist_trust_proxy", "true");
      cacheIPWhitelist(db);

      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "ip_whitelist_trust_proxy", value: "false" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ip_whitelist.trust_proxy).toBe(false);
      expect(state.ipWhitelistTrustProxy).toBe(false);
    });

    test("rejects invalid boolean for ip_whitelist_trust_proxy", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "ip_whitelist_trust_proxy", value: "yes" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("validation_error");
    });

    // SECURITY: Test that malformed IP ranges are rejected
    test("rejects IP range with extra CIDR segments (security)", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "ip_whitelist_ranges",
          value: JSON.stringify(["192.168.1.0/24/garbage"]),
        }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects IP range with extra dash segments (security)", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "ip_whitelist_ranges",
          value: JSON.stringify(["192.168.1.1-192.168.1.2-192.168.1.3"]),
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("version settings", () => {
    test("sets vscode_version with valid semver", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "vscode_version", value: "1.105.0" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.vscode_version.override).toBe("1.105.0");
    });

    test("sets vscode_version with pre-release suffix", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "vscode_version", value: "1.105.0-insider" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.vscode_version.override).toBe("1.105.0-insider");
    });

    test("rejects invalid vscode_version format", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "vscode_version", value: "invalid" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("validation_error");
      expect(body.error.message).toContain("invalid version format");
    });

    test("sets copilot_chat_version with valid semver", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "copilot_chat_version", value: "0.27.0" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.copilot_chat_version.override).toBe("0.27.0");
    });

    test("rejects invalid copilot_chat_version format", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "copilot_chat_version", value: "v0.27" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("validation_error");
    });

    test("deletes vscode_version override", async () => {
      setSetting(db, "vscode_version", "1.105.0");

      const app = createSettingsRoute(db);
      const res = await app.request("/settings/vscode_version", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.vscode_version.override).toBeNull();
      expect(getSetting(db, "vscode_version")).toBeNull();
    });

    test("deletes copilot_chat_version override", async () => {
      setSetting(db, "copilot_chat_version", "0.27.0");

      const app = createSettingsRoute(db);
      const res = await app.request("/settings/copilot_chat_version", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.copilot_chat_version.override).toBeNull();
      expect(getSetting(db, "copilot_chat_version")).toBeNull();
    });
  });

  describe("optimization settings", () => {
    test("sets opt_sanitize_orphaned_tool_results to true", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "opt_sanitize_orphaned_tool_results", value: "true" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.optimizations.sanitize_orphaned_tool_results.enabled).toBe(true);
      expect(state.optSanitizeOrphanedToolResults).toBe(true);
    });

    test("sets opt_reorder_tool_results to true", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "opt_reorder_tool_results", value: "true" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.optimizations.reorder_tool_results.enabled).toBe(true);
      expect(state.optReorderToolResults).toBe(true);
    });

    test("rejects removed opt_filter_whitespace_chunks key", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "opt_filter_whitespace_chunks", value: "true" }),
      });
      expect(res.status).toBe(400);
    });

    test("sets tool_call_debug to true", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "tool_call_debug", value: "true" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.debug.tool_call_debug.enabled).toBe(true);
      expect(state.optToolCallDebug).toBe(true);
    });

    test("rejects invalid boolean for optimization key", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "opt_sanitize_orphaned_tool_results", value: "yes" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("validation_error");
      expect(body.error.message).toContain("invalid boolean value");
    });

    test("deletes opt_sanitize_orphaned_tool_results", async () => {
      setSetting(db, "opt_sanitize_orphaned_tool_results", "true");
      cacheOptimizations(db);

      const app = createSettingsRoute(db);
      const res = await app.request("/settings/opt_sanitize_orphaned_tool_results", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(state.optSanitizeOrphanedToolResults).toBe(false);
      expect(getSetting(db, "opt_sanitize_orphaned_tool_results")).toBeNull();
    });

    test("deletes tool_call_debug", async () => {
      setSetting(db, "tool_call_debug", "true");
      cacheOptimizations(db);

      const app = createSettingsRoute(db);
      const res = await app.request("/settings/tool_call_debug", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(state.optToolCallDebug).toBe(false);
    });
  });

  describe("CORS settings", () => {
    test("GET /settings returns cors section", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("cors");
      expect(body.cors).toEqual({ enabled: false, allowed_origins: [] });
    });

    test("sets cors_enabled to true", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "cors_enabled", value: "true" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cors.enabled).toBe(true);
      expect(state.corsEnabled).toBe(true);
    });

    test("sets cors_enabled to false", async () => {
      setSetting(db, "cors_enabled", "true");
      cacheCorsSettings(db);

      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "cors_enabled", value: "false" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cors.enabled).toBe(false);
      expect(state.corsEnabled).toBe(false);
    });

    test("rejects invalid boolean for cors_enabled", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "cors_enabled", value: "yes" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("validation_error");
    });

    test("sets cors_allowed_origins with valid origins", async () => {
      const app = createSettingsRoute(db);
      const origins = ["http://localhost:3000", "https://app.example.com"];
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "cors_allowed_origins",
          value: JSON.stringify(origins),
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cors.allowed_origins).toEqual(origins);
      expect(state.corsAllowedOrigins).toEqual(origins);
    });

    test("rejects invalid JSON for cors_allowed_origins", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "cors_allowed_origins",
          value: "not json",
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("validation_error");
    });

    test("rejects non-array JSON for cors_allowed_origins", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "cors_allowed_origins",
          value: JSON.stringify({ origin: "http://localhost:3000" }),
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("validation_error");
    });

    test("rejects origins without http(s):// prefix", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "cors_allowed_origins",
          value: JSON.stringify(["localhost:3000", "http://valid.com"]),
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("validation_error");
      expect(body.error.message).toContain("localhost:3000");
    });

    test("rejects non-http schemes (ftp, ws)", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "cors_allowed_origins",
          value: JSON.stringify(["ftp://example.com", "ws://example.com"]),
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("validation_error");
      expect(body.error.message).toContain("ftp://example.com");
      expect(body.error.message).toContain("ws://example.com");
    });

    test("normalizes origins: strips trailing slash and path", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "cors_allowed_origins",
          value: JSON.stringify(["https://app.example.com/", "https://other.com/path/to/page"]),
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cors.allowed_origins).toEqual(["https://app.example.com", "https://other.com"]);
    });

    test("normalizes origins: lowercases scheme and host", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "cors_allowed_origins",
          value: JSON.stringify(["HTTPS://Example.COM"]),
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cors.allowed_origins).toEqual(["https://example.com"]);
    });

    test("normalizes origins: strips default port", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "cors_allowed_origins",
          value: JSON.stringify(["https://app.example.com:443", "http://app.example.com:80"]),
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cors.allowed_origins).toEqual(["https://app.example.com", "http://app.example.com"]);
    });

    test("preserves non-default port", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "cors_allowed_origins",
          value: JSON.stringify(["http://localhost:3000"]),
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cors.allowed_origins).toEqual(["http://localhost:3000"]);
    });

    test("deduplicates origins after normalization", async () => {
      const app = createSettingsRoute(db);
      const res = await app.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "cors_allowed_origins",
          value: JSON.stringify([
            "https://app.example.com",
            "https://app.example.com/",
            "https://App.Example.COM",
            "https://app.example.com:443",
          ]),
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cors.allowed_origins).toEqual(["https://app.example.com"]);
    });

    test("deletes cors_enabled", async () => {
      setSetting(db, "cors_enabled", "true");
      cacheCorsSettings(db);

      const app = createSettingsRoute(db);
      const res = await app.request("/settings/cors_enabled", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cors.enabled).toBe(false);
    });

    test("deletes cors_allowed_origins", async () => {
      setSetting(db, "cors_allowed_origins", '["http://localhost:3000"]');
      cacheCorsSettings(db);

      const app = createSettingsRoute(db);
      const res = await app.request("/settings/cors_allowed_origins", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cors.allowed_origins).toEqual([]);
    });
  });
});
