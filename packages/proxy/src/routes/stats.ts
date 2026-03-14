import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  queryOverview,
  queryTimeseries,
  queryModels,
  queryRecent,
} from "../db/requests.ts";

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
    const limit = limitStr ? parseInt(limitStr, 10) : 50;
    const result = queryRecent(db, limit);
    return c.json(result);
  });

  return route;
}
