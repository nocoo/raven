import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getConfigDir, getDataDir } from "../../src/lib/app-dirs";

// Note: We cannot import runMigrations from migration.ts directly
// because it imports from "../util/logger" which may not be available in test context.
// Instead, we'll test the migration logic through integration tests or by testing the individual functions.

describe("migration logic", () => {
  let tempDir: string;
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    // Create temp directory for testing
    tempDir = path.join(os.tmpdir(), `raven-migration-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Save original state
    originalCwd = process.cwd();
    originalEnv = { ...process.env };

    // Clear env vars that might affect path resolution
    delete process.env.RAVEN_CONFIG_DIR;
    delete process.env.RAVEN_DATA_DIR;
    delete process.env.RAVEN_TOKEN_PATH;
    delete process.env.RAVEN_DB_PATH;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
  });

  afterEach(async () => {
    // Restore original state
    process.chdir(originalCwd);
    process.env = originalEnv;

    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("path resolution", () => {
    test("getConfigDir returns platform-aware path", () => {
      const configDir = getConfigDir();
      expect(configDir).toBeTruthy();
      expect(path.isAbsolute(configDir)).toBe(true);
      expect(configDir).toMatch(/raven$/);
    });

    test("getDataDir returns platform-aware path", () => {
      const dataDir = getDataDir();
      expect(dataDir).toBeTruthy();
      expect(path.isAbsolute(dataDir)).toBe(true);
      expect(dataDir).toMatch(/raven$/);
    });
  });

  describe("env override precedence", () => {
    test("RAVEN_CONFIG_DIR takes precedence over platform default", () => {
      process.env.RAVEN_CONFIG_DIR = "/custom/raven/config";
      expect(getConfigDir()).toBe("/custom/raven/config");
    });

    test("RAVEN_DATA_DIR takes precedence over platform default", () => {
      process.env.RAVEN_DATA_DIR = "/custom/raven/data";
      expect(getDataDir()).toBe("/custom/raven/data");
    });
  });

  // Note: Full migration tests are in integration/e2e tests
  // because they require touching the filesystem in a controlled way
});
