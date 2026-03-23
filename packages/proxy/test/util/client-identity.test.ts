import { describe, expect, test } from "bun:test";
import {
  parseUserAgent,
  deriveClientIdentity,
} from "../../src/util/client-identity";

// ===========================================================================
// parseUserAgent
// ===========================================================================

describe("parseUserAgent", () => {
  test("parses Claude Code UA", () => {
    const result = parseUserAgent("claude-code/1.2.3");
    expect(result).toEqual({ name: "Claude Code", version: "1.2.3" });
  });

  test("parses Cursor UA", () => {
    const result = parseUserAgent("cursor/0.5.0 other-stuff");
    expect(result).toEqual({ name: "Cursor", version: "0.5.0" });
  });

  test("parses Continue UA", () => {
    const result = parseUserAgent("continue/2.1.0");
    expect(result).toEqual({ name: "Continue", version: "2.1.0" });
  });

  test("parses Windsurf UA", () => {
    const result = parseUserAgent("windsurf/1.0.0");
    expect(result).toEqual({ name: "Windsurf", version: "1.0.0" });
  });

  test("parses Aider UA", () => {
    const result = parseUserAgent("aider/0.42.0");
    expect(result).toEqual({ name: "Aider", version: "0.42.0" });
  });

  test("parses Cline UA", () => {
    const result = parseUserAgent("cline/3.0.1");
    expect(result).toEqual({ name: "Cline", version: "3.0.1" });
  });

  test("parses Anthropic Python SDK UA", () => {
    const result = parseUserAgent("anthropic-python/0.30.0");
    expect(result).toEqual({ name: "Anthropic Python SDK", version: "0.30.0" });
  });

  test("parses Anthropic TS SDK UA", () => {
    const result = parseUserAgent("anthropic-typescript/0.25.0");
    expect(result).toEqual({ name: "Anthropic TS SDK", version: "0.25.0" });
  });

  test("parses OpenAI Python SDK UA", () => {
    const result = parseUserAgent("openai-python/1.50.0");
    expect(result).toEqual({ name: "OpenAI Python SDK", version: "1.50.0" });
  });

  test("parses OpenAI Node SDK UA", () => {
    const result = parseUserAgent("openai-node/4.70.0");
    expect(result).toEqual({ name: "OpenAI Node SDK", version: "4.70.0" });
  });

  test("returns Unknown for undefined UA", () => {
    const result = parseUserAgent(null);
    expect(result).toEqual({ name: "Unknown", version: null });
  });

  test("returns Unknown for empty string UA", () => {
    const result = parseUserAgent("");
    expect(result).toEqual({ name: "Unknown", version: null });
  });

  test("returns first token for unknown UA", () => {
    const result = parseUserAgent("my-custom-client/2.0 extra-info");
    expect(result).toEqual({ name: "my-custom-client/2.0", version: null });
  });

  test("handles UA with no slash", () => {
    const result = parseUserAgent("SomeClient");
    expect(result).toEqual({ name: "SomeClient", version: null });
  });

  test("handles UA with version and extra tokens", () => {
    const result = parseUserAgent("claude-code/1.0.0-beta.1 node/20.0");
    expect(result).toEqual({ name: "Claude Code", version: "1.0.0-beta.1" });
  });
});

// ===========================================================================
// deriveClientIdentity
// ===========================================================================

describe("deriveClientIdentity", () => {
  test("anthropicUserId takes highest priority", () => {
    const result = deriveClientIdentity(
      "uuid-123-abc",
      "claude-code/1.0",
      "dev",
      null,
    );
    expect(result.sessionId).toBe("uuid-123-abc");
    expect(result.clientName).toBe("Claude Code");
    expect(result.clientVersion).toBe("1.0");
  });

  test("anthropicUserId overrides even when openaiUser is present", () => {
    const result = deriveClientIdentity(
      "uuid-123",
      "claude-code/1.0",
      "dev",
      "user-42",
    );
    expect(result.sessionId).toBe("uuid-123");
  });

  test("openaiUser used as heuristic with clientName and accountName", () => {
    const result = deriveClientIdentity(
      null,
      "cursor/0.5",
      "dev",
      "user-42",
    );
    expect(result.sessionId).toBe("user-42::Cursor::dev");
    expect(result.clientName).toBe("Cursor");
    expect(result.clientVersion).toBe("0.5");
  });

  test("openaiUser heuristic includes accountName to prevent cross-key merge", () => {
    const r1 = deriveClientIdentity(
      null,
      "cursor/0.5",
      "key-A",
      "shared-user",
    );
    const r2 = deriveClientIdentity(
      null,
      "cursor/0.5",
      "key-B",
      "shared-user",
    );
    expect(r1.sessionId).not.toBe(r2.sessionId);
    expect(r1.sessionId).toBe("shared-user::Cursor::key-A");
    expect(r2.sessionId).toBe("shared-user::Cursor::key-B");
  });

  test("fallback to clientName::accountName when no user IDs", () => {
    const result = deriveClientIdentity(
      null,
      "claude-code/1.0",
      "dev",
      null,
    );
    expect(result.sessionId).toBe("Claude Code::dev");
    expect(result.clientName).toBe("Claude Code");
    expect(result.clientVersion).toBe("1.0");
  });

  test("fallback with different accountNames produces different sessions", () => {
    const r1 = deriveClientIdentity(null, "cursor/0.5", "key-A", null);
    const r2 = deriveClientIdentity(null, "cursor/0.5", "key-B", null);
    expect(r1.sessionId).not.toBe(r2.sessionId);
  });

  test("all undefined produces Unknown::accountName", () => {
    const result = deriveClientIdentity(null, null, "dev", null);
    expect(result.sessionId).toBe("Unknown::dev");
    expect(result.clientName).toBe("Unknown");
    expect(result.clientVersion).toBeNull();
  });

  test("empty string anthropicUserId is not treated as present", () => {
    // Empty string is falsy, should fall through to fallback
    const result = deriveClientIdentity("", "claude-code/1.0", "dev", null);
    expect(result.sessionId).toBe("Claude Code::dev");
  });

  test("empty string openaiUser is not treated as present", () => {
    const result = deriveClientIdentity(null, "cursor/0.5", "dev", "");
    expect(result.sessionId).toBe("Cursor::dev");
  });
});
