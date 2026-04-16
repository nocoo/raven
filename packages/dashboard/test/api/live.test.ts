import { describe, it, expect, vi } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, readFileSync: vi.fn() };
});

import { readFileSync } from "fs";

const mockReadFileSync = vi.mocked(readFileSync);

describe("GET /api/live", () => {
  it("returns status ok with version from root package.json", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: "1.2.3" }));

    const { GET } = await import(
      "@/app/api/live/route"
    );
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      version: "1.2.3",
      component: "raven",
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it('returns "unknown" when package.json is unreadable', async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    // Re-import to pick up the new mock behavior
    vi.resetModules();
    vi.doMock("fs", () => ({ readFileSync: mockReadFileSync }));
    const { GET } = await import("@/app/api/live/route");

    const res = await GET();
    const body = await res.json();

    expect(body.version).toBe("unknown");
  });
});
