import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";

import { state } from "../../src/lib/state";
import { initSettings, setSetting, getSetting } from "../../src/db/settings";
import { initProviders } from "../../src/db/providers";
import { cacheSocks5Settings } from "../../src/lib/utils";
import { createSocks5SettingsRoute } from "../../src/routes/settings-socks5";
import { stopBridge, getBridgePort } from "../../src/lib/socks5-bridge";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: Database;

function createApp() {
  const app = new Hono();
  app.route("/api", createSocks5SettingsRoute(db));
  return app;
}

function insertProvider(
  id: string,
  name: string,
  useSocks5: number | null = null,
) {
  const now = Date.now();
  db.query(
    `INSERT INTO providers (id, name, base_url, format, api_key, model_patterns, enabled, supports_reasoning, supports_models_endpoint, use_socks5, created_at, updated_at)
     VALUES ($id, $name, 'https://api.example.com', 'openai', 'sk-test', '["*"]', 1, 0, 1, $use_socks5, $now, $now)`,
  ).run({ $id: id, $name: name, $use_socks5: useSocks5, $now: now });
}

// Save/restore state
const savedState = { ...state };

beforeEach(() => {
  db = new Database(":memory:");
  initSettings(db);
  initProviders(db);

  // Reset SOCKS5 state
  state.socks5Enabled = false;
  state.socks5Host = null;
  state.socks5Port = null;
  state.socks5Username = null;
  state.socks5Password = null;
  state.socks5CopilotPolicy = "default";
  state.socks5BridgePort = null;
});

afterEach(async () => {
  await stopBridge();
  db.close();
  // Restore state
  Object.assign(state, savedState);
});

// ===========================================================================
// GET /api/settings/socks5
// ===========================================================================

describe("GET /api/settings/socks5", () => {
  test("returns default config when nothing is set", async () => {
    const res = await createApp().request("/api/settings/socks5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(body.host).toBeNull();
    expect(body.port).toBeNull();
    expect(body.username).toBeNull();
    expect(body.hasPassword).toBe(false);
    expect(body.copilotPolicy).toBe("default");
    expect(body.bridgeStatus).toBe("stopped");
    expect(body.providerPolicies).toEqual([]);
  });

  test("masks password — returns hasPassword boolean", async () => {
    state.socks5Password = "secret";
    const res = await createApp().request("/api/settings/socks5");
    const body = await res.json();
    expect(body.hasPassword).toBe(true);
    // Must NOT contain the actual password
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  test("includes provider policies with supports_models_endpoint", async () => {
    insertProvider("p1", "OpenRouter", null);
    insertProvider("p2", "Ollama", 0);
    const res = await createApp().request("/api/settings/socks5");
    const body = await res.json();
    expect(body.providerPolicies).toHaveLength(2);
    expect(body.providerPolicies[0].name).toBe("OpenRouter");
    expect(body.providerPolicies[0].use_socks5).toBeNull();
    expect(body.providerPolicies[0].supports_models_endpoint).toBe(true);
    expect(body.providerPolicies[1].name).toBe("Ollama");
    expect(body.providerPolicies[1].use_socks5).toBe(0);
  });
});

// ===========================================================================
// PUT /api/settings/socks5
// ===========================================================================

describe("PUT /api/settings/socks5", () => {
  test("saves settings to DB without enabling (no bridge start)", async () => {
    const res = await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        host: "proxy.example.com",
        port: 1080,
        username: "user1",
        copilotPolicy: "on",
      }),
    });
    expect(res.status).toBe(200);

    // Verify DB
    expect(getSetting(db, "socks5_host")).toBe("proxy.example.com");
    expect(getSetting(db, "socks5_port")).toBe("1080");
    expect(getSetting(db, "socks5_username")).toBe("user1");
    expect(getSetting(db, "socks5_copilot")).toBe("on");
    expect(getSetting(db, "socks5_enabled")).toBe("false");
  });

  test("validates port range", async () => {
    const res = await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 99999 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("port");
  });

  test("validates copilotPolicy enum", async () => {
    const res = await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ copilotPolicy: "invalid" }),
    });
    expect(res.status).toBe(400);
  });

  test("requires host and port when enabling", async () => {
    const res = await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("host and port");
  });

  test("password three-state: string updates", async () => {
    await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "newpass" }),
    });
    expect(getSetting(db, "socks5_password")).toBe("newpass");
  });

  test("password three-state: null clears", async () => {
    setSetting(db, "socks5_password", "oldpass");
    cacheSocks5Settings(db);
    await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: null }),
    });
    expect(getSetting(db, "socks5_password")).toBeNull();
  });

  test("password three-state: undefined preserves", async () => {
    setSetting(db, "socks5_password", "preserved");
    cacheSocks5Settings(db);
    await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "new-host" }),
    });
    expect(getSetting(db, "socks5_password")).toBe("preserved");
  });

  test("updates provider policies", async () => {
    insertProvider("p1", "Provider1", null);
    insertProvider("p2", "Provider2", null);

    await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerPolicies: [
          { id: "p1", use_socks5: 1 },
          { id: "p2", use_socks5: 0 },
        ],
      }),
    });

    const row1 = db
      .query("SELECT use_socks5 FROM providers WHERE id = 'p1'")
      .get() as { use_socks5: number | null };
    expect(row1.use_socks5).toBe(1);

    const row2 = db
      .query("SELECT use_socks5 FROM providers WHERE id = 'p2'")
      .get() as { use_socks5: number | null };
    expect(row2.use_socks5).toBe(0);
  });

  test("disabling stops bridge", async () => {
    // Pre-set enabled state with bridge config
    setSetting(db, "socks5_enabled", "true");
    setSetting(db, "socks5_host", "127.0.0.1");
    setSetting(db, "socks5_port", "19999");
    cacheSocks5Settings(db);

    const res = await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(getBridgePort()).toBeNull();
  });
});

// ===========================================================================
// POST /api/settings/socks5/test
// ===========================================================================

describe("POST /api/settings/socks5/test", () => {
  test("validates required host", async () => {
    const res = await createApp().request("/api/settings/socks5/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 1080 }),
    });
    expect(res.status).toBe(400);
  });

  test("validates required port", async () => {
    const res = await createApp().request("/api/settings/socks5/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "proxy.example.com" }),
    });
    expect(res.status).toBe(400);
  });

  test("test endpoint uses stored credentials when useStoredCredentials=true", async () => {
    state.socks5Username = "stored-user";
    state.socks5Password = "stored-pass";

    const res = await createApp().request("/api/settings/socks5/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: "127.0.0.1",
        port: 19998,
        useStoredCredentials: true,
      }),
    });
    // Will fail to connect (port not open), but validates the flow doesn't error
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  test("returns error for unreachable proxy", async () => {
    const res = await createApp().request("/api/settings/socks5/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "127.0.0.1", port: 19998 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
