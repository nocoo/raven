import net from "node:net";
import { SocksClient } from "socks";
import type { CompiledProvider } from "../db/providers";
import type { State } from "./state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Socks5BridgeConfig {
  host: string;
  port: number;
  userId?: string;
  password?: string;
}

export class Socks5BridgeUnavailableError extends Error {
  constructor() {
    super(
      "SOCKS5 proxy is enabled but the bridge is not running. Check proxy settings.",
    );
    this.name = "Socks5BridgeUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Bridge state
// ---------------------------------------------------------------------------

let bridgeServer: net.Server | null = null;
let bridgePort: number | null = null;
let currentConfig: Socks5BridgeConfig | null = null;

export function getBridgePort(): number | null {
  return bridgePort;
}

// ---------------------------------------------------------------------------
// Bridge lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the in-process HTTP CONNECT -> SOCKS5 bridge.
 * Listens on 127.0.0.1 with a random port.
 * Returns the port number on success.
 */
export async function startBridge(
  config: Socks5BridgeConfig,
): Promise<number> {
  // If already running with same config, return existing port
  if (
    bridgeServer &&
    bridgePort &&
    currentConfig &&
    configEqual(currentConfig, config)
  ) {
    return bridgePort;
  }

  // Start new bridge FIRST, only tear down old one after success (atomic swap)
  const oldServer = bridgeServer;

  const server = net.createServer((clientSocket) => {
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
            host: config.host,
            port: config.port,
            type: 5,
            ...(config.userId ? { userId: config.userId } : {}),
            ...(config.password ? { password: config.password } : {}),
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

  return new Promise<number>((resolve, reject) => {
    server.on("error", (err) => {
      // New bridge failed to start — old bridge (if any) is still running
      reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;

      // New bridge is listening — now safe to swap
      bridgeServer = server;
      bridgePort = addr.port;
      currentConfig = { ...config };

      // Tear down old bridge (fire-and-forget, already replaced)
      if (oldServer) {
        oldServer.close();
      }

      resolve(addr.port);
    });
  });
}

/**
 * Stop the bridge. Idempotent.
 */
export async function stopBridge(): Promise<void> {
  if (!bridgeServer) return;

  const server = bridgeServer;
  bridgeServer = null;
  bridgePort = null;
  currentConfig = null;

  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// Proxy URL resolver (fail-closed)
// ---------------------------------------------------------------------------

/**
 * Get the proxy URL for fetch(), or undefined if the upstream should direct-connect.
 * Throws Socks5BridgeUnavailableError if the upstream requires proxy but bridge is down.
 */
export function getProxyUrl(
  upstream: "copilot" | "github" | CompiledProvider,
  state: State,
): string | undefined {
  if (!state.socks5Enabled) return undefined;

  // --- SOCKS5 is enabled ---

  if (upstream === "copilot" || upstream === "github") {
    const policy = state.socks5CopilotPolicy;
    if (policy === "off") return undefined;
    // policy === "on" || "default" -> requires proxy
    if (!bridgePort) throw new Socks5BridgeUnavailableError();
    return `http://127.0.0.1:${bridgePort}`;
  }

  // ProviderRecord
  const provider = upstream;
  if (provider.use_socks5 === 0) return undefined;
  if (provider.use_socks5 === null || provider.use_socks5 === undefined) {
    return undefined; // custom provider default = no proxy
  }
  // use_socks5 === 1 -> requires proxy
  if (!bridgePort) throw new Socks5BridgeUnavailableError();
  return `http://127.0.0.1:${bridgePort}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function configEqual(a: Socks5BridgeConfig, b: Socks5BridgeConfig): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.userId === b.userId &&
    a.password === b.password
  );
}
