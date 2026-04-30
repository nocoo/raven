import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { queryRequests, type QueryParams } from "../db/requests.ts";
import { parseAnalyticsFilters, buildWhereClause } from "../db/analytics-filters.ts";
import { safeParseInt } from "../util/params.ts";

/**
 * Create the /requests query route with filtering, sorting, pagination.
 * Supports all analytics filter params via shared parser.
 */
export function createRequestsRoute(db: Database): Hono {
  const route = new Hono();

  route.get("/requests", (c) => {
    // Parse analytics filters (time range, model, status, strategy, etc.)
    const filters = parseAnalyticsFilters(c);
    const filterClause = buildWhereClause(filters);

    // Strip "WHERE " prefix to get raw conditions for extraWhere
    const extraWhere = filterClause.where
      ? filterClause.where.replace(/^WHERE\s+/i, "")
      : undefined;

    const params: QueryParams = {
      model: null,
      status: null,
      format: null,
      sort: null,
      order: null,
      cursor: null,
      offset: null,
      limit: null,
    };

    // Add analytics filter conditions
    if (extraWhere) params.extraWhere = extraWhere;
    if (filterClause.bindings.length > 0) params.extraBindings = filterClause.bindings;

    // Legacy model/status/format params (still supported for backward compat)
    // Note: if analytics filter also specifies model/status, the extraWhere
    // handles it — these are only used if NOT already in analytics filters.
    if (!filters.model) {
      const model = c.req.query("model");
      if (model) params.model = model;
    }

    if (!filters.status) {
      const status = c.req.query("status");
      if (status) params.status = status;
    }

    const format = c.req.query("format");
    if (format) params.format = format;

    const sort = c.req.query("sort");
    const validSorts = ["timestamp", "latency_ms", "total_tokens", "ttft_ms", "processing_ms", "input_tokens", "output_tokens"] as const;
    if (sort && (validSorts as readonly string[]).includes(sort)) {
      params.sort = sort as typeof validSorts[number];
    }

    const order = c.req.query("order");
    if (order === "asc" || order === "desc") {
      params.order = order;
    }

    const cursor = c.req.query("cursor");
    if (cursor) params.cursor = cursor;

    const offsetStr = c.req.query("offset");
    if (offsetStr) {
      const v = safeParseInt(offsetStr);
      if (v === null) return c.json({ error: "offset must be a number" }, 400);
      params.offset = v;
    }

    const limitStr = c.req.query("limit");
    if (limitStr) {
      const v = safeParseInt(limitStr);
      if (v === null) return c.json({ error: "limit must be a number" }, 400);
      params.limit = v;
    }

    const result = queryRequests(db, params);
    return c.json(result);
  });

  return route;
}
