import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { isPublicIP, normalizeIP } from "../lib/ip-access";

const locationSchema = z.object({ country: z.string().optional(), countryCode: z.string().optional(), province: z.string().optional(), city: z.string().optional(), isp: z.string().optional(), asn: z.number().nullable().optional(), asOrg: z.string().optional() }).nullable();
const responseSchema = z.object({ ip: z.string(), location: locationSchema });
const TTL = 86400000;

export function createIPLookupRoute(db: Database, apiKey: string | undefined = process.env.RAVEN_IP_LOOKUP_API_KEY): Hono {
  db.exec("CREATE TABLE IF NOT EXISTS ip_locations (ip TEXT PRIMARY KEY, location TEXT NOT NULL, fetched_at INTEGER NOT NULL)");
  const route = new Hono();
  route.get("/ip-lookup", async c => {
    const ip = normalizeIP(c.req.query("ip") ?? null);
    if (!ip || !isPublicIP(ip)) return c.json({ error: { message: "Only public IPv4 or IPv6 addresses can be located" } }, 400);
    const cached = db.query("SELECT location, fetched_at FROM ip_locations WHERE ip = ? AND fetched_at > ?").get(ip, Date.now() - TTL) as { location: string; fetched_at: number } | null;
    if (cached) return c.json({ ip, location: JSON.parse(cached.location), fetched_at: cached.fetched_at, cached: true });
    if (!apiKey) return c.json({ error: { message: "Set RAVEN_IP_LOOKUP_API_KEY on the proxy to enable Echo lookup" } }, 503);
    try {
      const response = await fetch(`https://echo.nocoo.cloud/api/ip?ip=${encodeURIComponent(ip)}`, {
        headers: { "X-Api-Key": apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(5000), redirect: "error",
      });
      if (!response.ok) throw new Error("Echo request failed");
      const result = responseSchema.parse(await response.json());
      if (normalizeIP(result.ip) !== ip) throw new Error("Echo returned a different IP; verify the lookup credential");
      const now = Date.now();
      db.query("DELETE FROM ip_locations WHERE fetched_at <= ?").run(now - TTL);
      db.query("INSERT INTO ip_locations (ip, location, fetched_at) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET location = excluded.location, fetched_at = excluded.fetched_at").run(ip, JSON.stringify(result.location), now);
      return c.json({ ip, location: result.location, fetched_at: now, cached: false });
    } catch {
      return c.json({ error: { message: "Echo lookup failed or returned an unexpected address" } }, 502);
    }
  });
  return route;
}
