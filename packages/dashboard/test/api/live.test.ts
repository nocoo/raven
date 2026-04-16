import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/version", () => ({ APP_VERSION: "1.2.3" }));

const mockSafeFetch = vi.fn();
vi.mock("@/lib/proxy", () => ({ safeFetch: mockSafeFetch }));

describe("GET /api/live", () => {
  beforeEach(() => {
    vi.resetModules();
    mockSafeFetch.mockReset();
  });

  it("returns status ok when proxy reports healthy", async () => {
    mockSafeFetch.mockResolvedValue({
      ok: true,
      data: { status: "ok", database: { connected: true } },
    });

    const { GET } = await import("@/app/api/live/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      version: "1.2.3",
      component: "dashboard",
      database: { connected: true },
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns status error when proxy fetch fails", async () => {
    mockSafeFetch.mockRejectedValue(new Error("connection refused"));

    const { GET } = await import("@/app/api/live/route");
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe("error");
    expect(body.database.connected).toBe(false);
    expect(body.database.error).toBe("connection refused");
  });
});
