import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const bootedAt = Date.now();

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "../../../../package.json"), "utf-8"),
    );
    return (pkg.version as string) ?? "unknown";
  } catch {
    return "unknown";
  }
}

const VERSION = getVersion();

/**
 * /api/live — surety-standard health endpoint for the proxy component.
 */
export function createLiveRoute(db: Database): Hono {
  const route = new Hono();

  route.get("/live", async (c) => {
    const timestamp = new Date().toISOString();
    const uptime = Math.round((Date.now() - bootedAt) / 1000);

    let database: { connected: boolean; error?: string } = {
      connected: false,
    };
    try {
      db.query("SELECT 1 AS probe").get();
      database = { connected: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      database = { connected: false, error: msg.replace(/\bok\b/gi, "***") };
    }

    const healthy = database.connected;
    return c.json(
      {
        status: healthy ? "ok" : "error",
        version: VERSION,
        component: "proxy",
        timestamp,
        uptime,
        database,
      },
      healthy ? 200 : 503,
      { "Cache-Control": "no-store" },
    );
  });

  return route;
}
