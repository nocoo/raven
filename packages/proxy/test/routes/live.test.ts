import { describe, expect, test, mock } from "bun:test";
import { Hono } from "hono";

import { createLiveRoute } from "../../src/routes/live.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDb(healthy = true) {
  return {
    query: mock(() => ({
      get: healthy
        ? mock(() => ({ probe: 1 }))
        : mock(() => {
            throw new Error("connection lost");
          }),
    })),
  } as any;
}

function buildApp(db: any) {
  const app = new Hono();
  app.route("/", createLiveRoute(db));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
//
// Note: previous revisions stubbed node:fs via mock.module() to control
// getVersion() output, but mock.module is global across the bun test run and
// leaked into the strategy fixture loader (readFileSync(JSON)). The real
// package.json works fine for these assertions, so we read it natively.
// ---------------------------------------------------------------------------

describe("GET /live", () => {
  test("returns 200 with status ok when DB is healthy", async () => {
    const db = makeMockDb(true);
    const app = buildApp(db);

    const res = await app.request("/live");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.component).toBe("proxy");
    expect(typeof body.version).toBe("string");
    expect(body.database.connected).toBe(true);
    expect(typeof body.timestamp).toBe("string");
    expect(typeof body.uptime).toBe("number");
  });

  test("returns 503 with status error when DB query fails", async () => {
    const db = makeMockDb(false);
    const app = buildApp(db);

    const res = await app.request("/live");
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.database.connected).toBe(false);
    expect(body.database.error).toBeDefined();
  });

  test("sets Cache-Control: no-store header", async () => {
    const db = makeMockDb(true);
    const app = buildApp(db);

    const res = await app.request("/live");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("handles non-Error throw from DB", async () => {
    const db = {
      query: mock(() => ({
        get: mock(() => {
          throw "string error";
        }),
      })),
    } as any;
    const app = buildApp(db);

    const res = await app.request("/live");
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.database.error).toBe("string error");
  });
});
