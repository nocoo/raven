import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getSetting, setSetting, deleteSetting } from "../db/settings";
import { cacheVersions, cacheOptimizations } from "../lib/utils";
import { state } from "../lib/state";

// ---------------------------------------------------------------------------
// Key definitions
// ---------------------------------------------------------------------------

/** Version setting keys (semver values). */
const VERSION_KEYS = ["vscode_version", "copilot_chat_version"] as const;

/** Optimization setting keys (boolean "true"/"false" values). */
const OPTIMIZATION_KEYS = [
  "opt_sanitize_orphaned_tool_results",
  "opt_reorder_tool_results",
  "opt_filter_whitespace_chunks",
  "tool_call_debug",
] as const;

type VersionKey = (typeof VERSION_KEYS)[number];
type OptimizationKey = (typeof OPTIMIZATION_KEYS)[number];

/** All known setting keys accepted by the API. */
const KNOWN_KEYS = [...VERSION_KEYS, ...OPTIMIZATION_KEYS] as const;
type SettingKey = (typeof KNOWN_KEYS)[number];

function isKnownKey(key: string): key is SettingKey {
  return (KNOWN_KEYS as readonly string[]).includes(key);
}

function isVersionKey(key: string): key is VersionKey {
  return (VERSION_KEYS as readonly string[]).includes(key);
}

function isOptimizationKey(key: string): key is OptimizationKey {
  return (OPTIMIZATION_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a version string looks like a semver (major.minor.patch).
 * Allows optional pre-release suffix (e.g. "1.104.3-insider").
 */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

function isValidVersion(value: string): boolean {
  return SEMVER_RE.test(value);
}

function isValidBoolean(value: string): boolean {
  return value === "true" || value === "false";
}

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

export interface SettingInfo {
  effective: string;
  source: string;
  override: string | null;
}

export interface OptimizationInfo {
  enabled: boolean;
  key: string;
}

export interface SettingsSnapshot {
  vscode_version: SettingInfo;
  copilot_chat_version: SettingInfo;
  optimizations: Record<string, OptimizationInfo>;
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

function getSettingsSnapshot(db: Database): SettingsSnapshot {
  return {
    vscode_version: {
      effective: state.vsCodeVersion ?? "unknown",
      source: state.vsCodeVersionSource ?? "fallback",
      override: getSetting(db, "vscode_version"),
    },
    copilot_chat_version: {
      effective: state.copilotChatVersion ?? "unknown",
      source: state.copilotChatVersionSource ?? "fallback",
      override: getSetting(db, "copilot_chat_version"),
    },
    optimizations: {
      sanitize_orphaned_tool_results: {
        enabled: state.optSanitizeOrphanedToolResults,
        key: "opt_sanitize_orphaned_tool_results",
      },
      reorder_tool_results: {
        enabled: state.optReorderToolResults,
        key: "opt_reorder_tool_results",
      },
      filter_whitespace_chunks: {
        enabled: state.optFilterWhitespaceChunks,
        key: "opt_filter_whitespace_chunks",
      },
      tool_call_debug: {
        enabled: state.optToolCallDebug,
        key: "tool_call_debug",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * Create CRUD routes for settings (version overrides + optimization flags).
 * Mounted at /api in app.ts, so paths become /api/settings, etc.
 */
export function createSettingsRoute(db: Database): Hono {
  const route = new Hono();

  // Get all settings with effective values and sources
  route.get("/settings", (c) => {
    return c.json(getSettingsSnapshot(db));
  });

  // Set a setting override
  route.put("/settings", async (c) => {
    const body = await c.req.json<{ key?: string; value?: string }>();
    const { key, value } = body;

    if (!key || typeof key !== "string") {
      return c.json(
        { error: { type: "validation_error", message: "key is required" } },
        400,
      );
    }
    if (!isKnownKey(key)) {
      return c.json(
        {
          error: {
            type: "validation_error",
            message: `unknown key: ${key}. Must be one of: ${KNOWN_KEYS.join(", ")}`,
          },
        },
        400,
      );
    }
    if (!value || typeof value !== "string") {
      return c.json(
        { error: { type: "validation_error", message: "value is required" } },
        400,
      );
    }

    const trimmed = value.trim();

    // Validate based on key type
    if (isVersionKey(key)) {
      if (!isValidVersion(trimmed)) {
        return c.json(
          {
            error: {
              type: "validation_error",
              message: `invalid version format: "${trimmed}". Expected semver (e.g. 1.104.3)`,
            },
          },
          400,
        );
      }
    } else if (isOptimizationKey(key)) {
      if (!isValidBoolean(trimmed)) {
        return c.json(
          {
            error: {
              type: "validation_error",
              message: `invalid boolean value: "${trimmed}". Expected "true" or "false"`,
            },
          },
          400,
        );
      }
    }

    // Persist to DB and refresh caches
    setSetting(db, key, trimmed);
    if (isVersionKey(key)) {
      await cacheVersions(db);
    } else {
      cacheOptimizations(db);
    }

    return c.json(getSettingsSnapshot(db));
  });

  // Delete a setting override (revert to auto-detected / default)
  route.delete("/settings/:key", async (c) => {
    const key = c.req.param("key");

    if (!isKnownKey(key)) {
      return c.json(
        {
          error: {
            type: "validation_error",
            message: `unknown key: ${key}. Must be one of: ${KNOWN_KEYS.join(", ")}`,
          },
        },
        400,
      );
    }

    deleteSetting(db, key);
    if (isVersionKey(key)) {
      await cacheVersions(db);
    } else {
      cacheOptimizations(db);
    }

    return c.json(getSettingsSnapshot(db));
  });

  return route;
}
