import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { queryRequests, type QueryParams } from "../db/requests.ts";
import { safeParseInt } from "../util/params.ts";

/**
 * Create the /requests query route with filtering, sorting, pagination.
 */
export function createRequestsRoute(db: Database): Hono {
  const route = new Hono();

  route.get("/requests", (c) => {
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

    const model = c.req.query("model");
    if (model) params.model = model;

    const status = c.req.query("status");
    if (status) params.status = status;

    const format = c.req.query("format");
    if (format) params.format = format;

    const sort = c.req.query("sort");
    if (sort === "timestamp" || sort === "latency_ms" || sort === "total_tokens") {
      params.sort = sort;
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
