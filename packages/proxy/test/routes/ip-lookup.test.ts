import { afterEach, expect, it, vi } from "vitest";
import { Database } from "bun:sqlite";
import { createIPLookupRoute } from "../../src/routes/ip-lookup";
afterEach(() => { vi.restoreAllMocks(); });
it("uses Echo only on demand, checks returned IP and caches for 24 hours", async () => {
  const db = new Database(":memory:"); const route = createIPLookupRoute(db, "fixture-echo");
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ip: "1.1.1.1", location: { country: "Australia", countryCode: "AU", asn: 13335, asOrg: "Cloudflare" } }));
  expect(fetcher).not.toHaveBeenCalled();
  const response = await route.request("/ip-lookup?ip=1.1.1.1"); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ip: "1.1.1.1", location: { country: "Australia", asn: 13335 }, cached: false });
  expect(await (await route.request("/ip-lookup?ip=::ffff:101:101")).json()).toMatchObject({ cached: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
  db.exec("UPDATE ip_locations SET fetched_at = 0");
  fetcher.mockResolvedValueOnce(Response.json({ ip: "8.8.8.8", location: {} }));
  expect((await route.request("/ip-lookup?ip=1.1.1.1")).status).toBe(502);
  for (const ip of ["", "bad", "127.0.0.1", "::1", "10.0.0.1"]) expect((await route.request(`/ip-lookup?ip=${ip}`)).status).toBe(400);
  expect((await createIPLookupRoute(db, "").request("/ip-lookup?ip=8.8.8.8")).status).toBe(503);
  db.close();
});
it("handles IPv6, empty location, timeout, malformed responses and upstream errors", async () => {
  const db = new Database(":memory:"); const route = createIPLookupRoute(db, "fixture-echo");
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ip: "2606:4700:0:0:0:0:0:1111", location: null }));
  expect((await route.request("/ip-lookup?ip=2606:4700::1111")).status).toBe(200);
  for (const response of [new Response("bad"), Response.json({}), Response.json({ ip: "1.1.1.1", location: { asn: "bad" } }), new Response("", { status: 429 })]) {
    fetcher.mockResolvedValueOnce(response); expect((await route.request("/ip-lookup?ip=1.1.1.1")).status).toBe(502);
  }
  fetcher.mockRejectedValueOnce(new Error("timeout")); expect((await route.request("/ip-lookup?ip=1.1.1.1")).status).toBe(502);
  db.close();
});
