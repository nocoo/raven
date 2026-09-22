import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import net from "node:net";
import { once } from "node:events";
import { SocksClient } from "socks";

import { state } from "../../src/lib/state";
import { initSettings, setSetting, getSetting } from "../../src/db/settings";
import { initProviders } from "../../src/db/providers";
import { cacheSocks5Settings } from "../../src/lib/utils";
import { createSocks5SettingsRoute } from "../../src/routes/settings-socks5";
import * as socks5Bridge from "../../src/lib/socks5-bridge";

const { stopBridge, getBridgePort } = socks5Bridge;

// ESM module-namespace exports cannot be reassigned, so vi.spyOn(netModule,
// "createServer") fails. Hoist a mockable wrapper for node:net so the two
// outer-catch tests below can swap createServer's behaviour at runtime.
const netMocks = vi.hoisted(() => ({
  createServerImpl: null as ((...args: unknown[]) => unknown) | null,
}));

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createServer: ((...args: unknown[]) =>
      netMocks.createServerImpl
        ? netMocks.createServerImpl(...args)
        : (actual.createServer as (...a: unknown[]) => unknown)(...args)) as typeof actual.createServer,
  };
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: Database;
let outboundFetch: ReturnType<typeof vi.spyOn>;

function createApp() {
  const app = new Hono();
  app.route("/api", createSocks5SettingsRoute(db));
  return app;
}

function sendTunnelRequest(proxy: string, request: string): Promise<string> {
  const endpoint = new URL(proxy);
  if (endpoint.hostname !== "127.0.0.1") throw new Error("Fixture bridge must be local");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    const chunks: Buffer[] = [];
    socket.setTimeout(1000, () => socket.destroy(new Error("Fixture bridge timed out")));
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function insertProvider(
  id: string,
  name: string,
  useSocks5: number | null = null,
) {
  const now = Date.now();
  db.query(
    `INSERT INTO providers (id, name, kind, base_url, format, api_key, enabled, supports_reasoning, manual_models, use_socks5, created_at, updated_at)
     VALUES ($id, $name, 'custom', 'https://api.example.com', 'chat_completions', 'sk-test', 1, 0, '[]', $use_socks5, $now, $now)`,
  ).run({ $id: id, $name: name, $use_socks5: useSocks5, $now: now });
}

// Save/restore state
const savedState = { ...state };

beforeEach(() => {
  db = new Database(":memory:");
  initSettings(db);
  initProviders(db);
  outboundFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outbound HTTP request"));

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
  vi.restoreAllMocks();
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
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  test("includes custom upstream policies without legacy discovery flags", async () => {
    insertProvider("p1", "OpenRouter", null);
    insertProvider("p2", "Ollama", 0);
    const res = await createApp().request("/api/settings/socks5");
    const body = await res.json();
    expect(body.providerPolicies).toHaveLength(2);
    expect(body.providerPolicies[0].name).toBe("OpenRouter");
    expect(body.providerPolicies[0].use_socks5).toBeNull();
    expect(body.providerPolicies[0]).not.toHaveProperty("supports_models_endpoint");
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
    expect(getSetting(db, "socks5_host")).toBe("proxy.example.com");
    expect(getSetting(db, "socks5_port")).toBe("1080");
    expect(getSetting(db, "socks5_username")).toBe("user1");
    expect(getSetting(db, "socks5_copilot")).toBe("on");
    expect(getSetting(db, "socks5_enabled")).toBe("false");
  });

  test("validates enabled must be boolean", async () => {
    const res = await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("enabled must be a boolean");
  });

  test("validates host must be non-empty string", async () => {
    const res = await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("host must be a non-empty string");
  });

  test("validates host must be a string type", async () => {
    const res = await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: 123 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("host");
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

  test("validates port must be >= 1", async () => {
    const res = await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 0 }),
    });
    expect(res.status).toBe(400);
  });

  test("validates port must be integer", async () => {
    const res = await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 1.5 }),
    });
    expect(res.status).toBe(400);
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

  test("enabling starts bridge and returns running status", async () => {
    const res = await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        host: "127.0.0.1",
        port: 19999,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bridgeStatus).toBe("running");
    expect(body.bridgePort).toBeGreaterThan(0);
    expect(getBridgePort()).not.toBeNull();
  });

  test("enabling with credentials passes userId and password to bridge", async () => {
    const res = await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        host: "127.0.0.1",
        port: 19999,
        username: "user1",
        password: "pass1",
      }),
    });
    expect(res.status).toBe(200);
    expect(getBridgePort()).not.toBeNull();
  });

  test("returns bridge_error when startBridge fails with Error", async () => {
    const startSpy = vi.spyOn(socks5Bridge, "startBridge").mockRejectedValueOnce(
      new Error("EADDRINUSE"),
    );
    try {
      const res = await createApp().request("/api/settings/socks5", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          host: "127.0.0.1",
          port: 1080,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("bridge_error");
      expect(body.error.message).toContain("EADDRINUSE");
    } finally {
      startSpy.mockRestore();
    }
  });

  test("returns bridge_error when startBridge fails with non-Error", async () => {
    const startSpy = vi.spyOn(socks5Bridge, "startBridge").mockRejectedValueOnce(
      "string error",
    );
    try {
      const res = await createApp().request("/api/settings/socks5", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          host: "127.0.0.1",
          port: 1080,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("bridge_error");
      expect(body.error.message).toContain("string error");
    } finally {
      startSpy.mockRestore();
    }
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

  test("username null clears from DB", async () => {
    setSetting(db, "socks5_username", "olduser");
    cacheSocks5Settings(db);
    await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: null }),
    });
    expect(getSetting(db, "socks5_username")).toBeNull();
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

  test("provider policies skips entries without id", async () => {
    insertProvider("p1", "Provider1", null);
    const res = await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerPolicies: [
          { id: "", use_socks5: 1 },
          { id: "p1", use_socks5: 1 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const row = db
      .query("SELECT use_socks5 FROM providers WHERE id = 'p1'")
      .get() as { use_socks5: number | null };
    expect(row.use_socks5).toBe(1);
  });

  test("provider policies with use_socks5=null clears value", async () => {
    insertProvider("p1", "Provider1", 1);
    await createApp().request("/api/settings/socks5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerPolicies: [{ id: "p1", use_socks5: null }],
      }),
    });
    const row = db
      .query("SELECT use_socks5 FROM providers WHERE id = 'p1'")
      .get() as { use_socks5: number | null };
    expect(row.use_socks5).toBeNull();
  });

  test("disabling stops bridge", async () => {
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
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  test("explicit credentials override stored credentials", async () => {
    state.socks5Username = "stored-user";
    state.socks5Password = "stored-pass";

    const res = await createApp().request("/api/settings/socks5/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: "127.0.0.1",
        port: 19998,
        username: "explicit-user",
        password: "explicit-pass",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
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

  test("the temporary CONNECT bridge carries a local fixture response and closes its tunnel", async () => {
    const echo = net.createServer((socket) => socket.end('{"ip":"203.0.113.42"}'));
    const echoPort = await new Promise<number>((resolve) => {
      echo.listen(0, "127.0.0.1", () => resolve((echo.address() as net.AddressInfo).port));
    });
    const connect = vi.spyOn(SocksClient, "createConnection").mockImplementationOnce(async () => {
      const socket = net.createConnection({ host: "127.0.0.1", port: echoPort });
      await once(socket, "connect");
      return { socket };
    });
    outboundFetch.mockImplementationOnce(async (_url: string | URL | Request, init?: RequestInit) => {
      const wire = await sendTunnelRequest((init as RequestInit & { proxy: string }).proxy, "CONNECT fixture.invalid:443 HTTP/1.1\r\n\r\n");
      expect(wire).toBe('HTTP/1.1 200 Connection Established\r\n\r\n{"ip":"203.0.113.42"}');
      return new Response(wire.split("\r\n\r\n")[1], { headers: { "Content-Type": "application/json" } });
    });

    try {
      const res = await createApp().request("/api/settings/socks5/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: "127.0.0.1", port: 1080, username: "fixture-user", password: "fixture-password" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, ip: "203.0.113.42" });
      expect(outboundFetch).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledWith({
        proxy: { host: "127.0.0.1", port: 1080, type: 5, userId: "fixture-user", password: "fixture-password" },
        command: "connect", destination: { host: "fixture.invalid", port: 443 }, timeout: 10000,
      });
      expect(getBridgePort()).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => echo.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("malformed CONNECT requests receive 400 and close without opening a SOCKS connection", async () => {
    const connect = vi.spyOn(SocksClient, "createConnection").mockRejectedValue(new Error("Unexpected SOCKS connection"));
    const replies: string[] = [];
    outboundFetch.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      replies.push(await sendTunnelRequest((init as RequestInit & { proxy: string }).proxy, "GET / HTTP/1.1\r\nHost: fixture.invalid\r\n\r\n"));
      throw new Error("Tunnel rejected the request");
    });

    const res = await createApp().request("/api/settings/socks5/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "127.0.0.1", port: 1080 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: expect.stringContaining("could not verify egress IP") });
    expect(replies).toEqual(["HTTP/1.1 400 Bad Request\r\n\r\n", "HTTP/1.1 400 Bad Request\r\n\r\n"]);
    expect(connect).not.toHaveBeenCalled();
    expect(getBridgePort()).toBeNull();
  });

  test("a failed SOCKS connection sends 502 and closes the temporary tunnel", async () => {
    const connect = vi.spyOn(SocksClient, "createConnection").mockRejectedValue(new Error("Fixture connection refused"));
    const replies: string[] = [];
    outboundFetch.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      replies.push(await sendTunnelRequest((init as RequestInit & { proxy: string }).proxy, "CONNECT fixture.invalid:443 HTTP/1.1\r\n\r\n"));
      throw new Error("Tunnel connection failed");
    });

    const res = await createApp().request("/api/settings/socks5/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "127.0.0.1", port: 1080 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false });
    expect(replies).toEqual(["HTTP/1.1 502 Bad Gateway\r\n\r\n", "HTTP/1.1 502 Bad Gateway\r\n\r\n"]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("returns IP echo failure when fetch is mocked to fail", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Network error");
    });

    const socksServer = net.createServer((client) => {
      client.once("data", () => {
        client.write(Buffer.from([0x05, 0x00]));
        client.once("data", () => {
          client.destroy();
        });
      });
    });
    const socksPort = await new Promise<number>((resolve) => {
      socksServer.listen(0, "127.0.0.1", () => {
        resolve((socksServer.address() as net.AddressInfo).port);
      });
    });

    try {
      const res = await createApp().request("/api/settings/socks5/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: "127.0.0.1",
          port: socksPort,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("could not verify egress IP");
      expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      fetchSpy.mockRestore();
      socksServer.close();
    }
  }, 15000);

  test("returns IP echo failure when response is not ok", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("Service Unavailable", { status: 503 });
    });

    const socksServer = net.createServer((client) => {
      client.once("data", () => {
        client.write(Buffer.from([0x05, 0x00]));
        client.once("data", () => client.destroy());
      });
    });
    const socksPort = await new Promise<number>((resolve) => {
      socksServer.listen(0, "127.0.0.1", () => {
        resolve((socksServer.address() as net.AddressInfo).port);
      });
    });

    try {
      const res = await createApp().request("/api/settings/socks5/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: "127.0.0.1",
          port: socksPort,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("could not verify egress IP");
    } finally {
      fetchSpy.mockRestore();
      socksServer.close();
    }
  }, 15000);

  test("returns success when fetch returns valid IP", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ ip: "203.0.113.42" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const socksServer = net.createServer((client) => {
      client.once("data", () => {
        client.write(Buffer.from([0x05, 0x00]));
        client.once("data", () => client.destroy());
      });
    });
    const socksPort = await new Promise<number>((resolve) => {
      socksServer.listen(0, "127.0.0.1", () => {
        resolve((socksServer.address() as net.AddressInfo).port);
      });
    });

    try {
      const res = await createApp().request("/api/settings/socks5/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: "127.0.0.1",
          port: socksPort,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.ip).toBe("203.0.113.42");
      expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      fetchSpy.mockRestore();
      socksServer.close();
    }
  }, 15000);

  test("outer catch handles Error when temp server creation fails", async () => {
    const realNet = await vi.importActual<typeof import("node:net")>("node:net");
    const origCreateServer = realNet.createServer.bind(realNet);

    netMocks.createServerImpl = (...args: unknown[]) => {
      const server = origCreateServer(...(args as Parameters<typeof net.createServer>));
      server.listen = ((..._listenArgs: unknown[]) => {
        setTimeout(() => server.emit("error", new Error("EADDRINUSE mock")), 10);
        return server;
      }) as typeof server.listen;
      return server;
    };

    try {
      const res = await createApp().request("/api/settings/socks5/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: "127.0.0.1",
          port: 19998,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("EADDRINUSE mock");
      expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      netMocks.createServerImpl = null;
    }
  }, 15000);

  test("outer catch handles non-Error thrown", async () => {
    netMocks.createServerImpl = () => {
      throw "raw string error";
    };

    try {
      const res = await createApp().request("/api/settings/socks5/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: "127.0.0.1",
          port: 19998,
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe("raw string error");
    } finally {
      netMocks.createServerImpl = null;
    }
  }, 15000);
});
