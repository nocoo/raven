import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getSetting, setSetting, deleteSetting } from "../db/settings";
import { cacheVersions } from "../lib/utils";
import { state } from "../lib/state";

/** Known setting keys that can be overridden via the API. */
const KNOWN_KEYS = ["vscode_version", "copilot_chat_version"] as const;
type SettingKey = (typeof KNOWN_KEYS)[number];

function isKnownKey(key: string): key is SettingKey {
  return (KNOWN_KEYS as readonly string[]).includes(key);
}

/**
 * Validate that a version string looks like a semver (major.minor.patch).
 * Allows optional pre-release suffix (e.g. "1.104.3-insider").
 */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

function isValidVersion(value: string): boolean {
  return SEMVER_RE.test(value);
}

export interface SettingInfo {
  effective: string;
  source: string;
  override: string | null;
}

/**
 * Build the current effective settings snapshot.
 */
function getSettingsSnapshot(db: Database): Record<SettingKey, SettingInfo> {
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
  };
}

/**
 * Create CRUD routes for version settings.
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

    // Persist to DB and re-resolve all versions from DB/local/fallback
    setSetting(db, key, trimmed);
    await cacheVersions(db);

    return c.json(getSettingsSnapshot(db));
  });

  // Delete a setting override (revert to auto-detected)
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
    await cacheVersions(db);

    return c.json(getSettingsSnapshot(db));
  });

  return route;
}
