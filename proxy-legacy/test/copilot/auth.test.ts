import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("GitHub Device Flow Auth", () => {
  let tempDir: string;
  let tokenPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "raven-test-"));
    tokenPath = join(tempDir, "github_token");
  });

  afterEach(() => {
    if (existsSync(tokenPath)) {
      unlinkSync(tokenPath);
    }
  });

  describe("requestDeviceCode", () => {
    test("sends correct POST request to GitHub", async () => {
      const { requestDeviceCode } = await import("../../src/copilot/auth.ts");

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              device_code: "device-123",
              user_code: "ABCD-1234",
              verification_uri: "https://github.com/login/device",
              interval: 5,
              expires_in: 900,
            }),
            { status: 200 },
          ),
        ),
      );

      const result = await requestDeviceCode(mockFetch as unknown as typeof fetch);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const call = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(call[0]).toBe("https://github.com/login/device/code");
      expect(call[1]?.method).toBe("POST");

      expect(result.device_code).toBe("device-123");
      expect(result.user_code).toBe("ABCD-1234");
      expect(result.verification_uri).toBe("https://github.com/login/device");
      expect(result.interval).toBe(5);
    });

    test("throws on non-200 response", async () => {
      const { requestDeviceCode } = await import("../../src/copilot/auth.ts");

      const mockFetch = mock(() =>
        Promise.resolve(new Response("error", { status: 500 })),
      );

      expect(
        requestDeviceCode(mockFetch as unknown as typeof fetch),
      ).rejects.toThrow();
    });
  });

  describe("pollAccessToken", () => {
    test("returns token on successful poll", async () => {
      const { pollAccessToken } = await import("../../src/copilot/auth.ts");

      let callCount = 0;
      const mockFetch = mock(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: "authorization_pending" }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: "gho_test123", token_type: "bearer" }),
            { status: 200 },
          ),
        );
      });

      const result = await pollAccessToken(
        "device-123",
        0.01, // 10ms interval for fast test
        mockFetch as unknown as typeof fetch,
      );

      expect(result).toBe("gho_test123");
      expect(callCount).toBe(3);
    });

    test("throws on access_denied error", async () => {
      const { pollAccessToken } = await import("../../src/copilot/auth.ts");

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: "access_denied" }),
            { status: 200 },
          ),
        ),
      );

      expect(
        pollAccessToken("device-123", 0.01, mockFetch as unknown as typeof fetch),
      ).rejects.toThrow("access_denied");
    });

    test("throws on expired_token error", async () => {
      const { pollAccessToken } = await import("../../src/copilot/auth.ts");

      const mockFetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: "expired_token" }),
            { status: 200 },
          ),
        ),
      );

      expect(
        pollAccessToken("device-123", 0.01, mockFetch as unknown as typeof fetch),
      ).rejects.toThrow("expired_token");
    });
  });

  describe("token persistence", () => {
    test("saveToken writes file with 0600 permissions", async () => {
      const { saveToken } = await import("../../src/copilot/auth.ts");

      saveToken(tokenPath, "gho_test_token");

      expect(existsSync(tokenPath)).toBe(true);
      const content = readFileSync(tokenPath, "utf-8");
      expect(content).toBe("gho_test_token");

      const stats = statSync(tokenPath);
      const mode = (stats.mode & 0o777).toString(8);
      expect(mode).toBe("600");
    });

    test("loadToken reads existing token", async () => {
      const { saveToken, loadToken } = await import("../../src/copilot/auth.ts");

      saveToken(tokenPath, "gho_saved_token");
      const result = loadToken(tokenPath);
      expect(result).toBe("gho_saved_token");
    });

    test("loadToken returns null for missing file", async () => {
      const { loadToken } = await import("../../src/copilot/auth.ts");

      const result = loadToken(join(tempDir, "nonexistent"));
      expect(result).toBeNull();
    });

    test("loadToken deletes corrupted file and returns null", async () => {
      const { loadToken } = await import("../../src/copilot/auth.ts");

      // Write empty content (corrupted)
      writeFileSync(tokenPath, "");
      const result = loadToken(tokenPath);
      expect(result).toBeNull();
      expect(existsSync(tokenPath)).toBe(false);
    });

    test("loadToken deletes file with only whitespace and returns null", async () => {
      const { loadToken } = await import("../../src/copilot/auth.ts");

      writeFileSync(tokenPath, "   \n  ");
      const result = loadToken(tokenPath);
      expect(result).toBeNull();
      expect(existsSync(tokenPath)).toBe(false);
    });
  });
});
