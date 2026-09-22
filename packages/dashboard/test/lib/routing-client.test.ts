import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorDetail, errorMessage, jsonRequest, routingRequest } from "@/lib/routing-client";

afterEach(() => vi.restoreAllMocks());

describe("routing transport feedback", () => {
  it("sends one deliberate request with the exact wire body", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "saved" }));
    const init = jsonRequest("PATCH", { rule_id: "rule:weekly" });
    expect(await routingRequest("/api/keys/fixture", init)).toEqual({ id: "saved" });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/keys/fixture", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: '{"rule_id":"rule:weekly"}' });
  });
  it("shows references for delete conflicts without leaking unstructured objects", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { message: "Cannot delete an in-use rule.", type: "conflict", references: [{ id: "key-1", name: "Work laptop" }, { id: "key-2" }, "environment", null] } }, { status: 409 }));
    await expect(routingRequest("/api/routing-rules/fixture", { method: "DELETE" })).rejects.toThrow("Referenced by: Work laptop, key-2, environment, Referenced configuration.");
  });
  it("never retries an error or a failed generation test", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { message: "Quota exhausted", references: [] } }, { status: 429 }));
    await expect(routingRequest("/api/upstreams/fixture/test", jsonRequest("POST", { model: "raw" }))).rejects.toThrow("Quota exhausted");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("handles malformed error pages and successful empty replies", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("not-json", { status: 502 })).mockResolvedValueOnce(new Response(""));
    await expect(routingRequest("/api/test")).rejects.toThrow("502");
    expect(await routingRequest("/api/test")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("extracts only recognized message shapes", () => {
    for (const value of [null, false, 42, "bad", {}, { error: null }, { error: { message: 4 } }]) expect(apiErrorDetail(value)).toBeUndefined();
    expect(apiErrorDetail({ error: "old BFF failure" })).toEqual({ message: "old BFF failure" });
    expect(apiErrorDetail({ error: { message: "failure", type: "conflict" } })).toEqual({ message: "failure", type: "conflict" });
    expect(errorMessage(new Error("failed"))).toBe("failed");
    expect(errorMessage({ private: "do not echo" })).toBe("The request could not be completed.");
  });
});
