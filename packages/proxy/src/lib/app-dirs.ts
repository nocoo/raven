/**
 * Platform-aware application directory resolution.
 *
 * Default paths follow XDG Base Directory Specification on Linux
 * and standard Application Support directory on macOS.
 *
 * All paths can be overridden via environment variables:
 * - RAVEN_CONFIG_DIR: for secrets (github_token)
 * - RAVEN_DATA_DIR: for databases (raven.db)
 *
 * Legacy env vars still work for backward compatibility:
 * - RAVEN_TOKEN_PATH: full path to github_token file
 * - RAVEN_DB_PATH: full path to raven.db file
 */

import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export type Platform = "darwin" | "linux" | "win32" | "other";

export function getPlatform(): Platform {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "other";
}

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

const APP_NAME = "raven";

/**
 * Get the configuration directory for secrets.
 *
 * - macOS: ~/Library/Application Support/raven
 * - Linux: ~/.config/raven (or $XDG_CONFIG_HOME/raven)
 * - Windows: %APPDATA%/raven
 *
 * Can be overridden with RAVEN_CONFIG_DIR env var.
 */
export function getConfigDir(): string {
  // Env override takes precedence
  if (process.env.RAVEN_CONFIG_DIR) {
    return process.env.RAVEN_CONFIG_DIR;
  }

  const platform = getPlatform();
  const home = os.homedir();

  switch (platform) {
    case "darwin": {
      return path.join(home, "Library", "Application Support", APP_NAME);
    }
    case "linux": {
      // XDG Base Directory Specification
      const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
      return path.join(xdgConfig, APP_NAME);
    }
    case "win32": {
      const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      return path.join(appData, APP_NAME);
    }
    default: {
      // Fallback to Linux-style
      return path.join(home, ".config", APP_NAME);
    }
  }
}

/**
 * Get the data directory for databases and persistent state.
 *
 * - macOS: ~/Library/Application Support/raven (same as config)
 * - Linux: ~/.local/share/raven (or $XDG_DATA_HOME/raven)
 * - Windows: %LOCALAPPDATA%/raven
 *
 * Can be overridden with RAVEN_DATA_DIR env var.
 */
export function getDataDir(): string {
  // Env override takes precedence
  if (process.env.RAVEN_DATA_DIR) {
    return process.env.RAVEN_DATA_DIR;
  }

  const platform = getPlatform();
  const home = os.homedir();

  switch (platform) {
    case "darwin": {
      // macOS uses same directory for config and data
      return path.join(home, "Library", "Application Support", APP_NAME);
    }
    case "linux": {
      // XDG Base Directory Specification
      const xdgData = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
      return path.join(xdgData, APP_NAME);
    }
    case "win32": {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      return path.join(localAppData, APP_NAME);
    }
    default: {
      // Fallback to Linux-style
      return path.join(home, ".local", "share", APP_NAME);
    }
  }
}

/**
 * Get the default token file path.
 * Respects RAVEN_TOKEN_PATH for backward compatibility.
 */
export function getDefaultTokenPath(): string {
  if (process.env.RAVEN_TOKEN_PATH) {
    return process.env.RAVEN_TOKEN_PATH;
  }
  return path.join(getConfigDir(), "github_token");
}

/**
 * Get the default database file path.
 * Respects RAVEN_DB_PATH for backward compatibility.
 */
export function getDefaultDbPath(): string {
  if (process.env.RAVEN_DB_PATH) {
    return process.env.RAVEN_DB_PATH;
  }
  return path.join(getDataDir(), "raven.db");
}

// ---------------------------------------------------------------------------
// Permission constants
// ---------------------------------------------------------------------------

/** Directory permissions: owner rwx only (0700) */
export const DIR_MODE = 0o700;

/** Secret file permissions: owner rw only (0600) */
export const FILE_MODE = 0o600;
