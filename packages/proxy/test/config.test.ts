import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("returns default values when env vars are not set", () => {
    const original = { ...process.env };
    delete process.env.RAVEN_PORT;
    delete process.env.RAVEN_API_KEY;
    delete process.env.RAVEN_TOKEN_PATH;
    delete process.env.RAVEN_LOG_LEVEL;

    const config = loadConfig();

    expect(config.port).toBe(7033);
    expect(config.apiKey).toBe("");
    expect(config.tokenPath).toBe("data/github_token");
    expect(config.logLevel).toBe("info");

    Object.assign(process.env, original);
  });

  test("reads values from env vars", () => {
    const original = { ...process.env };
    process.env.RAVEN_PORT = "9999";
    process.env.RAVEN_API_KEY = "sk-test-key";
    process.env.RAVEN_TOKEN_PATH = "/tmp/token";
    process.env.RAVEN_LOG_LEVEL = "debug";

    const config = loadConfig();

    expect(config.port).toBe(9999);
    expect(config.apiKey).toBe("sk-test-key");
    expect(config.tokenPath).toBe("/tmp/token");
    expect(config.logLevel).toBe("debug");

    Object.assign(process.env, original);
  });
});
