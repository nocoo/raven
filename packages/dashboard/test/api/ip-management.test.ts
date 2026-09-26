import { expect, it, vi } from "vitest";
const response = vi.hoisted(() => vi.fn(async () => Response.json({ ok: true })));
vi.mock("@/lib/management-proxy", () => ({ managementResponse: response }));
it("forwards global/key policy reads and writes and on-demand location lookup", async () => {
  const global = await import("@/app/api/ip-policy/route");
  const key = await import("@/app/api/keys/[id]/ip-policy/route");
  const lookup = await import("@/app/api/ip-lookup/route");
  const request = new Request("http://raven.test/api/ip-policy", { method: "PUT", body: "{}" });
  await global.GET(); expect(response).toHaveBeenLastCalledWith("/api/ip-policy");
  await global.PUT(request); expect(response).toHaveBeenLastCalledWith("/api/ip-policy", "PUT", request);
  const context = { params: Promise.resolve({ id: "a/b" }) };
  await key.GET(request, context); expect(response).toHaveBeenLastCalledWith("/api/keys/a%2Fb/ip-policy");
  await key.PUT(request, context); expect(response).toHaveBeenLastCalledWith("/api/keys/a%2Fb/ip-policy", "PUT", request);
  await lookup.GET(new Request("http://raven.test/api/ip-lookup?ip=::1")); expect(response).toHaveBeenLastCalledWith("/api/ip-lookup?ip=%3A%3A1");
});
