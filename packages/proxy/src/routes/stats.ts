import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  queryOverview,
  queryTimeseries,
  queryModels,
  queryRecent,
} from "../db/requests.ts";
import { safeParseInt } from "../util/params.ts";

/**
 * Create stats API routes under /stats/*
 */
export function createStatsRoute(db: Database): Hono {
  const route = new Hono();

  route.get("/stats/overview", (c) => {
    const result = queryOverview(db);
    return c.json(result);
  });

  route.get("/stats/timeseries", (c) => {
    const interval = c.req.query("interval") ?? "hour";
    const range = c.req.query("range") ?? "24h";
    const result = queryTimeseries(db, interval, range);
    return c.json(result);
  });

  route.get("/stats/models", (c) => {
    const result = queryModels(db);
    return c.json(result);
  });

  route.get("/stats/recent", (c) => {
    const limitStr = c.req.query("limit");
    if (limitStr) {
      const v = safeParseInt(limitStr);
      if (v === null) return c.json({ error: "limit must be a number" }, 400);
      const result = queryRecent(db, v);
      return c.json(result);
    }
    const result = queryRecent(db);
    return c.json(result);
  });

  return route;
}
