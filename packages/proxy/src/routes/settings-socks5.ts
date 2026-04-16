import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { setSetting, deleteSetting } from "../db/settings";
import { cacheSocks5Settings } from "../lib/utils";
import { state } from "../lib/state";
import {
  startBridge,
  stopBridge,
  getBridgePort,
  type Socks5BridgeConfig,
} from "../lib/socks5-bridge";

/** IP echo services — try in order, first success wins. */
const IP_ECHO_URLS = [
  "https://api.ipify.org?format=json",          // returns { "ip": "x.x.x.x" }
  "https://httpbin.org/ip",                      // returns { "origin": "x.x.x.x" }
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Socks5GetResponse {
  enabled: boolean;
  host: string | null;
  port: number | null;
  username: string | null;
  hasPassword: boolean;
  copilotPolicy: "default" | "on" | "off";
  bridgeStatus: "running" | "stopped";
  bridgePort: number | null;
  providerPolicies: Array<{
    id: string;
    name: string;
    use_socks5: number | null;
    supports_models_endpoint: boolean | null;
  }>;
}

interface Socks5PutBody {
  enabled?: boolean;
  host?: string;
  port?: number;
  username?: string | null;
  password?: string | null;
  copilotPolicy?: "default" | "on" | "off";
  providerPolicies?: Array<{ id: string; use_socks5: number | null }>;
}

interface Socks5TestBody {
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  useStoredCredentials?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProviderPolicies(db: Database): Socks5GetResponse["providerPolicies"] {
  const rows = db
    .query(
      "SELECT id, name, use_socks5, supports_models_endpoint FROM providers ORDER BY created_at ASC",
    )
    .all() as Array<{
    id: string;
    name: string;
    use_socks5: number | null;
    supports_models_endpoint: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    use_socks5: r.use_socks5,
    supports_models_endpoint:
      r.supports_models_endpoint === null
        ? null
        : r.supports_models_endpoint === 1,
  }));
}

function buildGetResponse(db: Database): Socks5GetResponse {
  return {
    enabled: state.socks5Enabled,
    host: state.socks5Host,
    port: state.socks5Port,
    username: state.socks5Username,
    hasPassword: state.socks5Password !== null,
    copilotPolicy: state.socks5CopilotPolicy,
    bridgeStatus: getBridgePort() !== null ? "running" : "stopped",
    bridgePort: getBridgePort(),
    providerPolicies: getProviderPolicies(db),
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function createSocks5SettingsRoute(db: Database): Hono {
  const route = new Hono();

  // GET /settings/socks5 — return current config (password masked)
  route.get("/settings/socks5", (c) => {
    return c.json(buildGetResponse(db));
  });

  // PUT /settings/socks5 — atomic save with try-before-commit
  route.put("/settings/socks5", async (c) => {
    const body = await c.req.json<Socks5PutBody>();

    // --- Validate ---
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return c.json(
        { error: { type: "validation_error", message: "enabled must be a boolean" } },
        400,
      );
    }
    if (body.host !== undefined && (typeof body.host !== "string" || body.host.trim() === "")) {
      return c.json(
        { error: { type: "validation_error", message: "host must be a non-empty string" } },
        400,
      );
    }
    if (body.port !== undefined) {
      if (typeof body.port !== "number" || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
        return c.json(
          { error: { type: "validation_error", message: "port must be an integer between 1 and 65535" } },
          400,
        );
      }
    }
    if (body.copilotPolicy !== undefined && !["default", "on", "off"].includes(body.copilotPolicy)) {
      return c.json(
        { error: { type: "validation_error", message: 'copilotPolicy must be "default", "on", or "off"' } },
        400,
      );
    }

    // --- Determine new state ---
    const newEnabled = body.enabled ?? state.socks5Enabled;
    const newHost = body.host ?? state.socks5Host;
    const newPort = body.port ?? state.socks5Port;
    const newUsername =
      body.username === null ? null : body.username ?? state.socks5Username;
    // password three-state: string=update, null=clear, undefined=preserve
    const newPassword =
      body.password === null
        ? null
        : body.password !== undefined
          ? body.password
          : state.socks5Password;
    const newCopilotPolicy = body.copilotPolicy ?? state.socks5CopilotPolicy;

    // --- Try-before-commit for bridge ---
    if (newEnabled) {
      if (!newHost || !newPort) {
        return c.json(
          { error: { type: "validation_error", message: "host and port are required when enabling SOCKS5" } },
          400,
        );
      }

      const bridgeConfig: Socks5BridgeConfig = {
        host: newHost,
        port: newPort,
        ...(newUsername ? { userId: newUsername } : {}),
        ...(newPassword ? { password: newPassword } : {}),
      };

      try {
        await startBridge(bridgeConfig);
      } catch (err) {
        return c.json(
          {
            error: {
              type: "bridge_error",
              message: `Failed to start SOCKS5 bridge: ${err instanceof Error ? err.message : String(err)}`,
            },
          },
          400,
        );
      }
    } else if (!newEnabled && state.socks5Enabled) {
      // Disabling — stop bridge
      await stopBridge();
    }

    // --- Write to DB ---
    setSetting(db, "socks5_enabled", String(newEnabled));
    if (newHost) setSetting(db, "socks5_host", newHost);
    if (newPort) setSetting(db, "socks5_port", String(newPort));

    if (body.username === null) {
      deleteSetting(db, "socks5_username");
    } else if (body.username !== undefined) {
      setSetting(db, "socks5_username", body.username);
    }

    if (body.password === null) {
      deleteSetting(db, "socks5_password");
    } else if (body.password !== undefined) {
      setSetting(db, "socks5_password", body.password);
    }

    setSetting(db, "socks5_copilot", newCopilotPolicy);

    // --- Update provider policies ---
    if (body.providerPolicies && Array.isArray(body.providerPolicies)) {
      for (const pp of body.providerPolicies) {
        if (!pp.id) continue;
        const val =
          pp.use_socks5 === null ? null : pp.use_socks5 === 1 ? 1 : 0;
        db.query(
          "UPDATE providers SET use_socks5 = $val, updated_at = $now WHERE id = $id",
        ).run({ $val: val, $now: Date.now(), $id: pp.id });
      }
    }

    // --- Refresh state cache ---
    cacheSocks5Settings(db);
    state.socks5BridgePort = getBridgePort();

    return c.json(buildGetResponse(db));
  });

  // POST /settings/socks5/test — test connectivity with provided config
  route.post("/settings/socks5/test", async (c) => {
    const body = await c.req.json<Socks5TestBody>();

    if (!body.host || typeof body.host !== "string") {
      return c.json(
        { error: { type: "validation_error", message: "host is required" } },
        400,
      );
    }
    if (!body.port || typeof body.port !== "number") {
      return c.json(
        { error: { type: "validation_error", message: "port is required" } },
        400,
      );
    }

    const startTime = Date.now();

    // Resolve credentials: explicit body values take priority, fall back to stored
    const testUsername = body.username !== undefined ? body.username : (body.useStoredCredentials ? state.socks5Username : null);
    const testPassword = body.password !== undefined ? body.password : (body.useStoredCredentials ? state.socks5Password : null);

    try {
      // Spin up a temporary bridge to test the provided config
      const tempBridgeConfig: Socks5BridgeConfig = {
        host: body.host,
        port: body.port,
        ...(testUsername ? { userId: testUsername } : {}),
        ...(testPassword ? { password: testPassword } : {}),
      };

      // Use a separate net.Server so we don't disturb the main bridge
      const net = await import("node:net");
      const { SocksClient } = await import("socks");

      const tempServer = net.createServer((clientSocket) => {
        clientSocket.once("data", async (buf) => {
          const request = buf.toString();
          const match = request.match(/^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/\d\.\d/);
          if (!match) {
            clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
            clientSocket.destroy();
            return;
          }
          const targetHost = match[1]!;
          const targetPort = Number.parseInt(match[2]!, 10);
          try {
            const { socket: socksSocket } = await SocksClient.createConnection({
              proxy: {
                host: tempBridgeConfig.host,
                port: tempBridgeConfig.port,
                type: 5,
                ...(tempBridgeConfig.userId ? { userId: tempBridgeConfig.userId } : {}),
                ...(tempBridgeConfig.password ? { password: tempBridgeConfig.password } : {}),
              },
              command: "connect",
              destination: { host: targetHost, port: targetPort },
              timeout: 10_000,
            });
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            socksSocket.pipe(clientSocket);
            clientSocket.pipe(socksSocket);
            socksSocket.on("error", () => clientSocket.destroy());
            clientSocket.on("error", () => socksSocket.destroy());
            socksSocket.on("close", () => clientSocket.destroy());
            clientSocket.on("close", () => socksSocket.destroy());
          } catch {
            clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            clientSocket.destroy();
          }
        });
      });

      const tempPort = await new Promise<number>((resolve, reject) => {
        tempServer.on("error", reject);
        tempServer.listen(0, "127.0.0.1", () => {
          const addr = tempServer.address() as import("node:net").AddressInfo;
          resolve(addr.port);
        });
      });

      try {
        // Fetch egress IP through the temporary bridge
        let ip: string | null = null;
        for (const url of IP_ECHO_URLS) {
          try {
            const res = await fetch(url, {
              proxy: `http://127.0.0.1:${tempPort}`,
              signal: AbortSignal.timeout(10_000),
            } as RequestInit);
            if (res.ok) {
              const json = await res.json();
              ip = json.ip ?? json.origin ?? null;
              if (ip) break;
            }
          } catch {
            // Try next service
          }
        }

        const latencyMs = Date.now() - startTime;

        if (!ip) {
          return c.json(
            {
              success: false,
              error: "Connected to SOCKS5 proxy but could not verify egress IP (all IP echo services failed)",
              latencyMs,
            },
            400,
          );
        }

        return c.json({
          success: true,
          ip,
          latencyMs,
        });
      } finally {
        tempServer.close();
      }
    } catch (err) {
      return c.json(
        {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - startTime,
        },
        400,
      );
    }
  });

  return route;
}
