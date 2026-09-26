import { afterEach, expect, it, vi } from "vitest";
import { managementConfig } from "@/lib/management-config";
afterEach(() => vi.unstubAllEnvs());
it("requires the internal credential and a literal loopback destination", () => {
  vi.stubEnv("RAVEN_INTERNAL_KEY", "fixture-internal");
  for (const url of ["http://127.0.0.1:7024", "http://[::1]:7024", "http://localhost:7024"]) {
    vi.stubEnv("RAVEN_PROXY_URL", url); expect(managementConfig().url).toMatch(/7024$/);
  }
  for (const url of ["http://remote:7024", "http://192.0.2.1", "https://example.com", "http://user:pass@127.0.0.1", "http://127.0.0.1/api", "http://127.0.0.1?x=1", "ftp://127.0.0.1", "bad"]) {
    vi.stubEnv("RAVEN_PROXY_URL", url); expect(() => managementConfig()).toThrow();
  }
  vi.stubEnv("RAVEN_PROXY_URL", "http://127.0.0.1:7024"); vi.stubEnv("RAVEN_INTERNAL_KEY", ""); vi.stubEnv("RAVEN_API_KEY", "fixture-api");
  expect(() => managementConfig()).toThrow(/INTERNAL/);
});
