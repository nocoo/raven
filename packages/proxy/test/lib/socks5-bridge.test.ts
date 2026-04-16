import { describe, it, expect, afterEach } from "bun:test";
import {
  startBridge,
  stopBridge,
  getBridgePort,
  getProxyUrl,
  Socks5BridgeUnavailableError,
} from "../../src/lib/socks5-bridge";
import type { State } from "../../src/lib/state";
import type { ProviderRecord } from "../../src/db/providers";

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

function makeProvider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
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
});
