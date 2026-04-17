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

// Save original env and platform
const originalEnv = { ...process.env };
const originalPlatform = process.platform;

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
    // Restore env and platform
    process.env = { ...originalEnv };
    (process as any).platform = originalPlatform;
  });

  describe("getPlatform", () => {
    test("returns current platform", () => {
      const platform = getPlatform();
      expect(["darwin", "linux", "win32", "other"]).toContain(platform);
    });

    test("returns other for unknown platforms", () => {
      (process as any).platform = "freebsd";
      expect(getPlatform()).toBe("other");
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
    beforeEach(() => {
      (process as any).platform = "linux";
    });

    test("uses XDG_CONFIG_HOME when set", () => {
      process.env.XDG_CONFIG_HOME = "/custom/xdg/config";
      expect(getConfigDir()).toBe("/custom/xdg/config/raven");
    });

    test("uses XDG_DATA_HOME when set", () => {
      process.env.XDG_DATA_HOME = "/custom/xdg/data";
      expect(getDataDir()).toBe("/custom/xdg/data/raven");
    });

    test("falls back to ~/.config when XDG_CONFIG_HOME not set", () => {
      delete process.env.XDG_CONFIG_HOME;
      const home = os.homedir();
      expect(getConfigDir()).toBe(path.join(home, ".config", "raven"));
    });

    test("falls back to ~/.local/share when XDG_DATA_HOME not set", () => {
      delete process.env.XDG_DATA_HOME;
      const home = os.homedir();
      expect(getDataDir()).toBe(path.join(home, ".local", "share", "raven"));
    });
  });

  describe("win32 platform", () => {
    beforeEach(() => {
      (process as any).platform = "win32";
    });

    test("getConfigDir uses APPDATA when set", () => {
      process.env.APPDATA = "/mock/appdata";
      expect(getConfigDir()).toBe(path.join("/mock/appdata", "raven"));
    });

    test("getConfigDir falls back to homedir/AppData/Roaming without APPDATA", () => {
      delete process.env.APPDATA;
      const home = os.homedir();
      expect(getConfigDir()).toBe(path.join(home, "AppData", "Roaming", "raven"));
    });

    test("getDataDir uses LOCALAPPDATA when set", () => {
      process.env.LOCALAPPDATA = "/mock/localappdata";
      expect(getDataDir()).toBe(path.join("/mock/localappdata", "raven"));
    });

    test("getDataDir falls back to homedir/AppData/Local without LOCALAPPDATA", () => {
      delete process.env.LOCALAPPDATA;
      const home = os.homedir();
      expect(getDataDir()).toBe(path.join(home, "AppData", "Local", "raven"));
    });
  });

  describe("other/unknown platform fallback", () => {
    beforeEach(() => {
      (process as any).platform = "freebsd";
    });

    test("getConfigDir falls back to ~/.config (linux-style)", () => {
      const home = os.homedir();
      expect(getConfigDir()).toBe(path.join(home, ".config", "raven"));
    });

    test("getDataDir falls back to ~/.local/share (linux-style)", () => {
      const home = os.homedir();
      expect(getDataDir()).toBe(path.join(home, ".local", "share", "raven"));
    });
  });

  describe("darwin platform", () => {
    beforeEach(() => {
      (process as any).platform = "darwin";
    });

    test("getConfigDir uses Library/Application Support", () => {
      const home = os.homedir();
      expect(getConfigDir()).toBe(path.join(home, "Library", "Application Support", "raven"));
    });

    test("getDataDir uses Library/Application Support", () => {
      const home = os.homedir();
      expect(getDataDir()).toBe(path.join(home, "Library", "Application Support", "raven"));
    });
  });

  describe("path structure", () => {
    test("config dir includes app name", () => {
      expect(getConfigDir()).toMatch(/raven$/);
    });

    test("data dir includes app name", () => {
      expect(getDataDir()).toMatch(/raven$/);
    });

    test("token path ends with github_token", () => {
      expect(getDefaultTokenPath()).toMatch(/github_token$/);
    });

    test("db path ends with raven.db", () => {
      expect(getDefaultDbPath()).toMatch(/raven\.db$/);
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
      expect(path.isAbsolute(getConfigDir())).toBe(true);
      expect(path.isAbsolute(getDataDir())).toBe(true);
    });

    test("paths use system home directory", () => {
      const home = os.homedir();
      expect(getConfigDir()).toContain(home);
      expect(getDataDir()).toContain(home);
    });
  });
});
