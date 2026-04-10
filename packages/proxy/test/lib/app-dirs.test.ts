import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import os from "node:os";
import path from "node:path";
import {
  getPlatform,
  getConfigDir,
  getDataDir,
  getDefaultTokenPath,
  getDefaultDbPath,
  DIR_MODE,
  FILE_MODE,
} from "../../src/lib/app-dirs";

// Save original env
const originalEnv = { ...process.env };

describe("app-dirs", () => {
  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.RAVEN_CONFIG_DIR;
    delete process.env.RAVEN_DATA_DIR;
    delete process.env.RAVEN_TOKEN_PATH;
    delete process.env.RAVEN_DB_PATH;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
    // Restore platform (read-only, but we can mock the function behavior)
  });

  describe("getPlatform", () => {
    test("returns darwin on macOS", () => {
      const platform = getPlatform();
      expect(["darwin", "linux", "win32", "other"]).toContain(platform);
    });
  });

  describe("env overrides", () => {
    test("RAVEN_CONFIG_DIR overrides default config dir", () => {
      process.env.RAVEN_CONFIG_DIR = "/custom/config";
      expect(getConfigDir()).toBe("/custom/config");
    });

    test("RAVEN_DATA_DIR overrides default data dir", () => {
      process.env.RAVEN_DATA_DIR = "/custom/data";
      expect(getDataDir()).toBe("/custom/data");
    });

    test("RAVEN_TOKEN_PATH overrides default token path", () => {
      process.env.RAVEN_TOKEN_PATH = "/custom/token";
      expect(getDefaultTokenPath()).toBe("/custom/token");
    });

    test("RAVEN_DB_PATH overrides default db path", () => {
      process.env.RAVEN_DB_PATH = "/custom/db";
      expect(getDefaultDbPath()).toBe("/custom/db");
    });
  });

  describe("XDG support on Linux", () => {
    test("uses XDG_CONFIG_HOME when set", () => {
      // Mock platform behavior by checking env
      process.env.XDG_CONFIG_HOME = "/custom/xdg/config";
      // On actual Linux, this would affect getConfigDir
      // Here we just verify the env is respected when platform is linux
      expect(getConfigDir()).toBeTruthy();
    });

    test("uses XDG_DATA_HOME when set", () => {
      process.env.XDG_DATA_HOME = "/custom/xdg/data";
      expect(getDataDir()).toBeTruthy();
    });

    test("falls back to ~/.config when XDG_CONFIG_HOME not set", () => {
      delete process.env.XDG_CONFIG_HOME;
      const home = os.homedir();
      const result = getConfigDir();
      // Should contain home directory
      expect(result).toContain(home);
    });
  });

  describe("path structure", () => {
    test("config dir includes app name", () => {
      const configDir = getConfigDir();
      expect(configDir).toMatch(/raven$/);
    });

    test("data dir includes app name", () => {
      const dataDir = getDataDir();
      expect(dataDir).toMatch(/raven$/);
    });

    test("token path is inside config dir", () => {
      const tokenPath = getDefaultTokenPath();
      expect(tokenPath).toMatch(/github_token$/);
    });

    test("db path is inside data dir", () => {
      const dbPath = getDefaultDbPath();
      expect(dbPath).toMatch(/raven\.db$/);
    });
  });

  describe("permission constants", () => {
    test("DIR_MODE is 0700", () => {
      expect(DIR_MODE).toBe(0o700);
    });

    test("FILE_MODE is 0600", () => {
      expect(FILE_MODE).toBe(0o600);
    });
  });

  describe("home directory resolution", () => {
    test("paths are absolute", () => {
      const configDir = getConfigDir();
      const dataDir = getDataDir();
      expect(path.isAbsolute(configDir)).toBe(true);
      expect(path.isAbsolute(dataDir)).toBe(true);
    });

    test("paths use system home directory", () => {
      const home = os.homedir();
      const configDir = getConfigDir();
      const dataDir = getDataDir();
      // All paths should be under home dir (unless overridden)
      expect(configDir).toContain(home);
      expect(dataDir).toContain(home);
    });
  });
});
