// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IPPolicyDialog, IPLookup } from "@/components/analytics/panels/ip-management";
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
afterEach(() => vi.restoreAllMocks());
it("loads a key policy on demand, validates and saves without changing the key", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ enabled: false, ranges: [] }));
  render(<IPPolicyDialog keyId="key-1" name="Editor" />);
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "IP access" }));
  const ranges = await screen.findByLabelText("Allowed IPs and networks");
  await userEvent.click(screen.getByRole("switch"));
  await userEvent.click(screen.getByRole("button", { name: "Save policy" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Add at least one IP");
  await userEvent.type(ranges, "2001:db8::/32");
  fetcher.mockResolvedValueOnce(Response.json({ enabled: true, ranges: ["2001:db8::/32"] }));
  await userEvent.click(screen.getByRole("button", { name: "Save policy" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fetcher.mock.calls[1]?.[0]).toBe("/api/keys/key-1/ip-policy");
  expect(JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string)).toEqual({ enabled: true, ranges: ["2001:db8::/32"] });
});
it("keeps query failures visible and never fetches geography on mount", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ error: { message: "Echo unavailable" } }, { status: 502 }));
  render(<IPLookup ip="1.1.1.1" />); expect(fetcher).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Look up location" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Echo unavailable");
});
