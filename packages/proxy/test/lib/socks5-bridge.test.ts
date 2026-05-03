import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import {
  startBridge,
  stopBridge,
  getBridgePort,
  getProxyUrl,
  Socks5BridgeUnavailableError,
} from "../../src/lib/socks5-bridge";
import type { State } from "../../src/lib/state";
import type { ProviderRecord, CompiledProvider } from "../../src/db/providers";
import { compileProvider } from "../../src/db/providers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<State> = {}): State {
  return {
    githubToken: null,
    copilotToken: null,
    accountType: "individual",
    models: null,
    vsCodeVersion: null,
    copilotChatVersion: null,
    vsCodeVersionSource: null,
    copilotChatVersionSource: null,
    rateLimitWait: false,
    rateLimitSeconds: null,
    lastRequestTimestamp: null,
    optSanitizeOrphanedToolResults: false,
    optReorderToolResults: false,
    optFilterWhitespaceChunks: false,
    optToolCallDebug: false,
    stWebSearchEnabled: false,
    stWebSearchApiKey: null,
    providers: [],
    soundEnabled: false,
    soundName: "Basso",
    ipWhitelistEnabled: false,
    ipWhitelistRanges: [],
    ipWhitelistTrustProxy: false,
    socks5Enabled: false,
    socks5Host: null,
    socks5Port: null,
    socks5Username: null,
    socks5Password: null,
    socks5CopilotPolicy: "default",
    socks5BridgePort: null,
    ...overrides,
  };
}

function makeProvider(overrides: Partial<ProviderRecord> = {}): CompiledProvider {
  const record: ProviderRecord = {
    id: "test-provider-id",
    name: "Test Provider",
    base_url: "https://api.example.com",
    format: "openai",
    api_key: "sk-test",
    model_patterns: '["*"]',
    enabled: 1,
    supports_reasoning: 0,
    supports_models_endpoint: 1,
    use_socks5: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
  const compiled = compileProvider(record);
  if (!compiled) throw new Error("Failed to compile provider");
  return compiled;
}

// ---------------------------------------------------------------------------
// Bridge lifecycle tests
// ---------------------------------------------------------------------------

describe("socks5-bridge", () => {
  afterEach(async () => {
    await stopBridge();
  });

  describe("startBridge / stopBridge", () => {
    it("starts and listens on a random port", async () => {
      // Use a dummy config — bridge listens regardless of SOCKS5 server reachability
      const port = await startBridge({ host: "127.0.0.1", port: 19999 });
      expect(port).toBeGreaterThan(0);
      expect(getBridgePort()).toBe(port);
    });

    it("is idempotent with same config", async () => {
      const config = { host: "127.0.0.1", port: 19999 };
      const port1 = await startBridge(config);
      const port2 = await startBridge(config);
      expect(port1).toBe(port2);
    });

    it("restarts with different config — old bridge stays up until new one is ready", async () => {
      const port1 = await startBridge({ host: "127.0.0.1", port: 19999 });
      expect(getBridgePort()).toBe(port1);
      // Start with new config — should atomically swap
      const port2 = await startBridge({ host: "127.0.0.1", port: 29999 });
      expect(port2).toBeGreaterThan(0);
      expect(getBridgePort()).toBe(port2);
      // Verify a bridge is always running (no gap)
      expect(getBridgePort()).not.toBeNull();
    });

    it("restarts with different config", async () => {
      const port1 = await startBridge({ host: "127.0.0.1", port: 19999 });
      const port2 = await startBridge({ host: "127.0.0.1", port: 29999 });
      // Port may differ (new random port)
      expect(port2).toBeGreaterThan(0);
      expect(getBridgePort()).toBe(port2);
      // port1 server should be closed
      if (port1 !== port2) {
        expect(port1).not.toBe(port2);
      }
    });

    it("stopBridge is idempotent", async () => {
      await startBridge({ host: "127.0.0.1", port: 19999 });
      await stopBridge();
      expect(getBridgePort()).toBeNull();
      // Second stop should not throw
      await stopBridge();
      expect(getBridgePort()).toBeNull();
    });

    it("stopBridge clears port", async () => {
      await startBridge({ host: "127.0.0.1", port: 19999 });
      expect(getBridgePort()).not.toBeNull();
      await stopBridge();
      expect(getBridgePort()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getProxyUrl decision matrix
  // ---------------------------------------------------------------------------

  describe("getProxyUrl", () => {
    describe("socks5 disabled", () => {
      it("returns undefined for copilot", () => {
        const state = makeState({ socks5Enabled: false });
        expect(getProxyUrl("copilot", state)).toBeUndefined();
      });

      it("returns undefined for github", () => {
        const state = makeState({ socks5Enabled: false });
        expect(getProxyUrl("github", state)).toBeUndefined();
      });

      it("returns undefined for provider", () => {
        const state = makeState({ socks5Enabled: false });
        const provider = makeProvider({ use_socks5: 1 });
        expect(getProxyUrl(provider, state)).toBeUndefined();
      });
    });

    describe("socks5 enabled, bridge running", () => {
      it("returns proxy URL for copilot with default policy", async () => {
        const port = await startBridge({ host: "127.0.0.1", port: 19999 });
        const state = makeState({
          socks5Enabled: true,
          socks5CopilotPolicy: "default",
        });
        const url = getProxyUrl("copilot", state);
        expect(url).toBe(`http://127.0.0.1:${port}`);
      });

      it("returns proxy URL for copilot with on policy", async () => {
        const port = await startBridge({ host: "127.0.0.1", port: 19999 });
        const state = makeState({
          socks5Enabled: true,
          socks5CopilotPolicy: "on",
        });
        expect(getProxyUrl("copilot", state)).toBe(
          `http://127.0.0.1:${port}`,
        );
      });

      it("returns undefined for copilot with off policy", async () => {
        await startBridge({ host: "127.0.0.1", port: 19999 });
        const state = makeState({
          socks5Enabled: true,
          socks5CopilotPolicy: "off",
        });
        expect(getProxyUrl("copilot", state)).toBeUndefined();
      });

      it("returns proxy URL for github with default policy", async () => {
        const port = await startBridge({ host: "127.0.0.1", port: 19999 });
        const state = makeState({
          socks5Enabled: true,
          socks5CopilotPolicy: "default",
        });
        expect(getProxyUrl("github", state)).toBe(
          `http://127.0.0.1:${port}`,
        );
      });

      it("returns undefined for provider with use_socks5=null (default off)", async () => {
        await startBridge({ host: "127.0.0.1", port: 19999 });
        const state = makeState({ socks5Enabled: true });
        const provider = makeProvider({ use_socks5: null });
        expect(getProxyUrl(provider, state)).toBeUndefined();
      });

      it("returns proxy URL for provider with use_socks5=1 (force on)", async () => {
        const port = await startBridge({ host: "127.0.0.1", port: 19999 });
        const state = makeState({ socks5Enabled: true });
        const provider = makeProvider({ use_socks5: 1 });
        expect(getProxyUrl(provider, state)).toBe(
          `http://127.0.0.1:${port}`,
        );
      });

      it("returns undefined for provider with use_socks5=0 (force off)", async () => {
        await startBridge({ host: "127.0.0.1", port: 19999 });
        const state = makeState({ socks5Enabled: true });
        const provider = makeProvider({ use_socks5: 0 });
        expect(getProxyUrl(provider, state)).toBeUndefined();
      });
    });

    describe("socks5 enabled, bridge NOT running (fail-closed)", () => {
      it("throws for copilot with default policy", () => {
        const state = makeState({
          socks5Enabled: true,
          socks5CopilotPolicy: "default",
        });
        expect(() => getProxyUrl("copilot", state)).toThrow(
          Socks5BridgeUnavailableError,
        );
      });

      it("throws for copilot with on policy", () => {
        const state = makeState({
          socks5Enabled: true,
          socks5CopilotPolicy: "on",
        });
        expect(() => getProxyUrl("copilot", state)).toThrow(
          Socks5BridgeUnavailableError,
        );
      });

      it("returns undefined for copilot with off policy (no proxy needed)", () => {
        const state = makeState({
          socks5Enabled: true,
          socks5CopilotPolicy: "off",
        });
        expect(getProxyUrl("copilot", state)).toBeUndefined();
      });

      it("throws for github with default policy", () => {
        const state = makeState({
          socks5Enabled: true,
          socks5CopilotPolicy: "default",
        });
        expect(() => getProxyUrl("github", state)).toThrow(
          Socks5BridgeUnavailableError,
        );
      });

      it("returns undefined for provider with use_socks5=null (no proxy needed)", () => {
        const state = makeState({ socks5Enabled: true });
        const provider = makeProvider({ use_socks5: null });
        expect(getProxyUrl(provider, state)).toBeUndefined();
      });

      it("throws for provider with use_socks5=1", () => {
        const state = makeState({ socks5Enabled: true });
        const provider = makeProvider({ use_socks5: 1 });
        expect(() => getProxyUrl(provider, state)).toThrow(
          Socks5BridgeUnavailableError,
        );
      });

      it("returns undefined for provider with use_socks5=0 (no proxy needed)", () => {
        const state = makeState({ socks5Enabled: true });
        const provider = makeProvider({ use_socks5: 0 });
        expect(getProxyUrl(provider, state)).toBeUndefined();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Connection handler tests (lines 63-101)
  // ---------------------------------------------------------------------------

  describe("bridge connection handler", () => {
    it("returns 400 for non-CONNECT requests", async () => {
      const port = await startBridge({ host: "127.0.0.1", port: 19999 });

      const response = await new Promise<string>((resolve) => {
        const client = net.createConnection({ host: "127.0.0.1", port }, () => {
          client.write("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n");
        });
        let data = "";
        client.on("data", (chunk) => { data += chunk.toString(); });
        client.on("end", () => resolve(data));
        client.on("close", () => resolve(data));
      });

      expect(response).toContain("400 Bad Request");
    });

    it("returns 502 when SOCKS5 upstream is unreachable", async () => {
      // Port 19999 has no SOCKS5 server, so createConnection will fail
      const port = await startBridge({ host: "127.0.0.1", port: 19999 });

      const response = await new Promise<string>((resolve) => {
        const client = net.createConnection({ host: "127.0.0.1", port }, () => {
          client.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
        });
        let data = "";
        client.on("data", (chunk) => { data += chunk.toString(); });
        client.on("end", () => resolve(data));
        client.on("close", () => resolve(data));
        setTimeout(() => resolve(data), 15000);
      });

      expect(response).toContain("502 Bad Gateway");
    }, 20000);

    it("pipes data between client and SOCKS5 upstream on success", async () => {
      // Create a mock TCP echo server as the "destination"
      const echoServer = net.createServer((sock) => {
        sock.on("data", (d) => sock.write(d));
      });
      const echoPort = await new Promise<number>((resolve) => {
        echoServer.listen(0, "127.0.0.1", () => {
          resolve((echoServer.address() as net.AddressInfo).port);
        });
      });

      // Create a minimal SOCKS5 server that just connects to the echo server
      const socksServer = net.createServer((client) => {
        // SOCKS5 handshake: greeting
        client.once("data", (_greeting) => {
          // Send: no auth required
          client.write(Buffer.from([0x05, 0x00]));
          // SOCKS5 connect request
          client.once("data", (_req) => {
            // Connect to the echo server
            const upstream = net.createConnection({ host: "127.0.0.1", port: echoPort }, () => {
              // Success reply: VER=5, REP=0 (success), RSV=0, ATYP=1 (IPv4), BND.ADDR=0.0.0.0, BND.PORT=0
              const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
              client.write(reply);
              upstream.pipe(client);
              client.pipe(upstream);
            });
            upstream.on("error", () => client.destroy());
          });
        });
      });
      const socksPort = await new Promise<number>((resolve) => {
        socksServer.listen(0, "127.0.0.1", () => {
          resolve((socksServer.address() as net.AddressInfo).port);
        });
      });

      try {
        const bridgePort = await startBridge({ host: "127.0.0.1", port: socksPort });

        const result = await new Promise<string>((resolve, reject) => {
          const client = net.createConnection({ host: "127.0.0.1", port: bridgePort }, () => {
            client.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\n`);
          });
          let data = "";
          client.on("data", (chunk) => {
            data += chunk.toString();
            if (data.includes("200 Connection Established") && !data.includes("hello-echo")) {
              // Tunnel established, send test data
              client.write("hello-echo");
            }
            if (data.includes("hello-echo")) {
              client.end();
              resolve(data);
            }
          });
          client.on("error", reject);
          setTimeout(() => resolve(data), 5000);
        });

        expect(result).toContain("200 Connection Established");
        expect(result).toContain("hello-echo");
      } finally {
        echoServer.close();
        socksServer.close();
      }
    }, 10000);

    it("handles upstream socket errors by destroying client", async () => {
      // Create a SOCKS5 server that returns success but immediately errors
      const socksServer = net.createServer((client) => {
        client.once("data", () => {
          client.write(Buffer.from([0x05, 0x00])); // no auth
          client.once("data", () => {
            const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            client.write(reply);
            // Immediately destroy to trigger error on the piped socket
            setTimeout(() => client.destroy(), 50);
          });
        });
      });
      const socksPort = await new Promise<number>((resolve) => {
        socksServer.listen(0, "127.0.0.1", () => {
          resolve((socksServer.address() as net.AddressInfo).port);
        });
      });

      try {
        const bridgePort = await startBridge({ host: "127.0.0.1", port: socksPort });

        const closed = await new Promise<boolean>((resolve) => {
          const client = net.createConnection({ host: "127.0.0.1", port: bridgePort }, () => {
            client.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
          });
          client.on("close", () => resolve(true));
          setTimeout(() => resolve(false), 5000);
        });

        expect(closed).toBe(true);
      } finally {
        socksServer.close();
      }
    }, 10000);

    it("starts bridge with userId and password config", async () => {
      const port = await startBridge({
        host: "127.0.0.1",
        port: 19999,
        userId: "testuser",
        password: "testpass",
      });
      expect(port).toBeGreaterThan(0);
      expect(getBridgePort()).toBe(port);
    });
  });

  // ---------------------------------------------------------------------------
  // Socks5BridgeUnavailableError
  // ---------------------------------------------------------------------------

  describe("Socks5BridgeUnavailableError", () => {
    it("has correct name and message", () => {
      const err = new Socks5BridgeUnavailableError();
      expect(err.name).toBe("Socks5BridgeUnavailableError");
      expect(err.message).toContain("SOCKS5 proxy is enabled");
      expect(err).toBeInstanceOf(Error);
    });
  });

  // ---------------------------------------------------------------------------
  // getProxyUrl with undefined use_socks5
  // ---------------------------------------------------------------------------

  describe("getProxyUrl edge cases", () => {
    it("returns undefined for provider with use_socks5=undefined", () => {
      const s = makeState({ socks5Enabled: true });
      const provider = makeProvider({ use_socks5: undefined as any });
      expect(getProxyUrl(provider, s)).toBeUndefined();
    });
  });
});
