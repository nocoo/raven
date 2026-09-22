import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getSetting, setSetting, deleteSetting } from "../db/settings";
import { cacheVersions, cacheOptimizations, cacheServerTools, cacheIPWhitelist, cacheCorsSettings } from "../lib/utils";
import { state } from "../lib/state";
import { parseIPRanges, serializeIPRanges } from "../lib/ip-whitelist";

// ---------------------------------------------------------------------------
// Key definitions
// ---------------------------------------------------------------------------

/** Version setting keys (semver values). */
const VERSION_KEYS = ["vscode_version", "copilot_chat_version"] as const;

/** Optimization setting keys (boolean "true"/"false" values). */
const OPTIMIZATION_KEYS = [
  "opt_sanitize_orphaned_tool_results",
  "opt_reorder_tool_results",
  "tool_call_debug",
] as const;

/** Server tool setting keys. */
const SERVER_TOOL_KEYS = [
  "st_web_search_enabled",
  "st_web_search_api_key",
] as const;

/** Server tool boolean keys (for validation). */
const SERVER_TOOL_BOOLEAN_KEYS = ["st_web_search_enabled"] as const;

/** IP whitelist setting keys. */
const IP_WHITELIST_KEYS = ["ip_whitelist_enabled", "ip_whitelist_ranges", "ip_whitelist_trust_proxy"] as const;

/** IP whitelist boolean keys (for validation). */
const IP_WHITELIST_BOOLEAN_KEYS = ["ip_whitelist_enabled", "ip_whitelist_trust_proxy"] as const;

/** CORS setting keys. */
const CORS_KEYS = ["cors_enabled", "cors_allowed_origins"] as const;

/** CORS boolean keys (for validation). */
const CORS_BOOLEAN_KEYS = ["cors_enabled"] as const;

type VersionKey = (typeof VERSION_KEYS)[number];
type OptimizationKey = (typeof OPTIMIZATION_KEYS)[number];
type ServerToolKey = (typeof SERVER_TOOL_KEYS)[number];
type IPWhitelistKey = (typeof IP_WHITELIST_KEYS)[number];
type CorsKey = (typeof CORS_KEYS)[number];

/** All known setting keys accepted by the API. */
const KNOWN_KEYS = [...VERSION_KEYS, ...OPTIMIZATION_KEYS, ...SERVER_TOOL_KEYS, ...IP_WHITELIST_KEYS, ...CORS_KEYS] as const;
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

function isServerToolKey(key: string): key is ServerToolKey {
  return (SERVER_TOOL_KEYS as readonly string[]).includes(key);
}

function isServerToolBooleanKey(key: string): key is ServerToolKey {
  return (SERVER_TOOL_BOOLEAN_KEYS as readonly string[]).includes(key);
}

function isIPWhitelistKey(key: string): key is IPWhitelistKey {
  return (IP_WHITELIST_KEYS as readonly string[]).includes(key);
}

function isIPWhitelistBooleanKey(key: string): key is IPWhitelistKey {
  return (IP_WHITELIST_BOOLEAN_KEYS as readonly string[]).includes(key);
}

function isCorsKey(key: string): key is CorsKey {
  return (CORS_KEYS as readonly string[]).includes(key);
}

function isCorsBooleanKey(key: string): key is CorsKey {
  return (CORS_BOOLEAN_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a version string looks like a semver (major.minor.patch).
 * Allows optional pre-release suffix (e.g. "1.117.0-insider").
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

export interface ServerToolInfo {
  enabled: boolean;
  has_api_key: boolean;
}

export interface IPWhitelistInfo {
  enabled: boolean;
  trust_proxy: boolean;
  ranges: string[];
}

export interface CorsInfo {
  enabled: boolean;
  allowed_origins: string[];
}

export interface SettingsSnapshot {
  vscode_version: SettingInfo;
  copilot_chat_version: SettingInfo;
  optimizations: Record<string, OptimizationInfo>;
  debug: Record<string, OptimizationInfo>;
  server_tools: Record<string, ServerToolInfo>;
  ip_whitelist: IPWhitelistInfo;
  cors: CorsInfo;
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
      tool_call_debug: {
        enabled: state.optToolCallDebug,
        key: "tool_call_debug",
      },
    },
    debug: {
      tool_call_debug: {
        enabled: state.optToolCallDebug,
        key: "tool_call_debug",
      },
    },
    server_tools: {
      web_search: {
        enabled: state.stWebSearchEnabled,
        has_api_key: state.stWebSearchApiKey !== null,
      },
    },
    ip_whitelist: {
      enabled: state.ipWhitelistEnabled,
      trust_proxy: state.ipWhitelistTrustProxy,
      ranges: state.ipWhitelistRanges.map((r) => r.original),
    },
    cors: {
      enabled: state.corsEnabled,
      allowed_origins: state.corsAllowedOrigins,
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
              message: `invalid version format: "${trimmed}". Expected semver (e.g. 1.117.0)`,
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
    } else if (isServerToolBooleanKey(key)) {
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
    } else if (isIPWhitelistBooleanKey(key)) {
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
    } else if (isCorsBooleanKey(key)) {
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
    } else if (key === "cors_allowed_origins") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return c.json(
          {
            error: {
              type: "validation_error",
              message: "cors_allowed_origins must be a valid JSON array of strings",
            },
          },
          400,
        );
      }
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
        return c.json(
          {
            error: {
              type: "validation_error",
              message: "cors_allowed_origins must be a JSON array of strings",
            },
          },
          400,
        );
      }
      const invalid: string[] = [];
      const normalized: string[] = [];
      for (const v of parsed as string[]) {
        try {
          const url = new URL(v);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            invalid.push(v);
          } else {
            normalized.push(url.origin);
          }
        } catch {
          invalid.push(v);
        }
      }
      if (invalid.length > 0) {
        return c.json(
          {
            error: {
              type: "validation_error",
              message: `invalid origin(s): ${invalid.join(", ")}. Each value must be a valid http:// or https:// URL`,
            },
          },
          400,
        );
      }
      const deduped = [...new Set(normalized)];
      setSetting(db, key, JSON.stringify(deduped));
      cacheCorsSettings(db);
      return c.json(getSettingsSnapshot(db));
    } else if (key === "ip_whitelist_ranges") {
      // Validate JSON array of IP ranges
      const { ranges, errors } = parseIPRanges(trimmed);
      if (errors.length > 0) {
        return c.json(
          {
            error: {
              type: "validation_error",
              message: `invalid IP ranges: ${errors.join("; ")}`,
            },
          },
          400,
        );
      }
      // Re-serialize to ensure consistent format
      const normalized = serializeIPRanges(ranges);
      setSetting(db, key, normalized);
      cacheIPWhitelist(db);
      return c.json(getSettingsSnapshot(db));
    }

    // Persist to DB and refresh caches
    setSetting(db, key, trimmed);
    if (isVersionKey(key)) {
      await cacheVersions(db);
    } else if (isServerToolKey(key)) {
      cacheServerTools(db);
    } else if (isIPWhitelistKey(key)) {
      cacheIPWhitelist(db);
    } else if (isCorsKey(key)) {
      cacheCorsSettings(db);
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
    } else if (isServerToolKey(key)) {
      cacheServerTools(db);
    } else if (isIPWhitelistKey(key)) {
      cacheIPWhitelist(db);
    } else if (isCorsKey(key)) {
      cacheCorsSettings(db);
    } else {
      cacheOptimizations(db);
    }

    return c.json(getSettingsSnapshot(db));
  });

  return route;
}
