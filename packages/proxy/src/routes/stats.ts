import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  queryOverview,
  queryTimeseries,
  queryModels,
  queryRecent,
  querySummary,
  queryBreakdown,
} from "../db/requests.ts";
import { parseAnalyticsFilters, buildWhereClause } from "../db/analytics-filters.ts";
import { safeParseInt } from "../util/params.ts";

/**
 * Create stats API routes under /stats/*
 */
export function createStatsRoute(db: Database): Hono {
  const route = new Hono();

  // Legacy endpoint — kept for backward compatibility
  route.get("/stats/overview", (c) => {
    const result = queryOverview(db);
    return c.json(result);
  });

  // Enhanced summary with full filter support
  route.get("/stats/summary", (c) => {
    const filters = parseAnalyticsFilters(c);
    const { where, bindings } = buildWhereClause(filters);
    const result = querySummary(db, where, bindings as (string | number | null)[]);
    return c.json(result);
  });

  route.get("/stats/timeseries", (c) => {
    const interval = c.req.query("interval") ?? "hour";
    const range = c.req.query("range") ?? "24h";
    const filters = parseAnalyticsFilters(c);
    const { where, bindings } = buildWhereClause(filters);
    const result = queryTimeseries(db, interval, range, where, bindings as (string | number | null)[]);
    return c.json(result);
  });

  route.get("/stats/models", (c) => {
    const result = queryModels(db);
    return c.json(result);
  });

  // Universal breakdown/ranking endpoint
  route.get("/stats/breakdown", (c) => {
    const by = c.req.query("by");
    if (!by) return c.json({ error: "missing 'by' parameter" }, 400);

    const filters = parseAnalyticsFilters(c);
    const { where, bindings } = buildWhereClause(filters);

    const sort = c.req.query("sort") ?? "count";
    const order = (c.req.query("order") === "asc" ? "asc" : "desc") as "asc" | "desc";
    const limitStr = c.req.query("limit");
    const limit = limitStr ? safeParseInt(limitStr) ?? 20 : 20;

    const result = queryBreakdown(db, {
      by,
      whereClause: where || undefined,
      bindings: where ? bindings as (string | number | null)[] : undefined,
      sort,
      order,
      limit,
    });
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
