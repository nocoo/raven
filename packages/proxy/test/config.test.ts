import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { getConfigDir, getDataDir } from "../src/lib/app-dirs";

describe("loadConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear all raven-related env vars
    delete process.env.RAVEN_PORT;
    delete process.env.RAVEN_API_KEY;
    delete process.env.RAVEN_TOKEN_PATH;
    delete process.env.RAVEN_DB_PATH;
    delete process.env.RAVEN_LOG_LEVEL;
    delete process.env.RAVEN_CONFIG_DIR;
    delete process.env.RAVEN_DATA_DIR;
  });

  test("returns default values when env vars are not set", () => {
    const config = loadConfig();

    expect(config.port).toBe(7024);
    expect(config.apiKey).toBe("");
    expect(config.logLevel).toBe("info");

    // Paths should be platform-aware and absolute
    const expectedConfigDir = getConfigDir();
    const expectedDataDir = getDataDir();

    expect(config.tokenPath).toMatch(/github_token$/);
    expect(config.tokenPath).toContain(expectedConfigDir);
    expect(config.dbPath).toMatch(/raven\.db$/);
    expect(config.dbPath).toContain(expectedDataDir);
  });

  test("reads values from env vars", () => {
    process.env.RAVEN_PORT = "9999";
    process.env.RAVEN_API_KEY = "sk-test-key";
    process.env.RAVEN_TOKEN_PATH = "/tmp/token";
    process.env.RAVEN_DB_PATH = "data/raven-test.db";
    process.env.RAVEN_LOG_LEVEL = "debug";

    const config = loadConfig();

    expect(config.port).toBe(9999);
    expect(config.apiKey).toBe("sk-test-key");
    expect(config.tokenPath).toBe("/tmp/token");
    expect(config.dbPath).toBe("data/raven-test.db");
    expect(config.logLevel).toBe("debug");
  });

  test("RAVEN_CONFIG_DIR overrides default token path", () => {
    process.env.RAVEN_CONFIG_DIR = "/custom/raven/config";

    const config = loadConfig();
    expect(config.tokenPath).toBe("/custom/raven/config/github_token");
  });

  test("RAVEN_DATA_DIR overrides default db path", () => {
    process.env.RAVEN_DATA_DIR = "/custom/raven/data";

    const config = loadConfig();
    expect(config.dbPath).toBe("/custom/raven/data/raven.db");
  });

  test("RAVEN_TOKEN_PATH takes precedence over RAVEN_CONFIG_DIR", () => {
    process.env.RAVEN_CONFIG_DIR = "/custom/config";
    process.env.RAVEN_TOKEN_PATH = "/explicit/token";

    const config = loadConfig();
    expect(config.tokenPath).toBe("/explicit/token");
  });

  test("RAVEN_DB_PATH takes precedence over RAVEN_DATA_DIR", () => {
    process.env.RAVEN_DATA_DIR = "/custom/data";
    process.env.RAVEN_DB_PATH = "/explicit/db";

    const config = loadConfig();
    expect(config.dbPath).toBe("/explicit/db");
  });

  afterEach(() => {
    process.env = originalEnv;
  });
});
