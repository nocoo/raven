// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CorsContent } from "@/app/settings/cors-content";
import { IPWhitelistContent } from "@/app/settings/ip-whitelist-content";
import { ServerToolsContent } from "@/app/settings/server-tools-content";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => vi.restoreAllMocks());

const cases = [
  {
    name: "IP whitelist", toggle: "Restrict client IPs", disclosure: "Allowed IPs", placeholder: "e.g., 192.168.1.0/24", entry: "192.0.2.1",
    render: (enabled = false, entries: string[] = []) => <IPWhitelistContent data={{ enabled, ranges: entries, trust_proxy: false }} />,
  },
  {
    name: "CORS", toggle: "Restrict browser origins", disclosure: "Allowed origins", placeholder: "e.g., http://localhost:3000", entry: "https://fixture.invalid",
    render: (enabled = false, entries: string[] = []) => <CorsContent data={{ enabled, allowed_origins: entries }} />,
  },
];

describe.each(cases)("$name disclosure", fixture => {
  it("allows configuring restrictions before enabling them without a network write", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(fixture.render());
    expect(screen.getByRole("switch", { name: fixture.toggle })).not.toBeChecked();
    expect(screen.queryByPlaceholderText(fixture.placeholder)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: `${fixture.disclosure} · 0` }));
    expect(screen.getByPlaceholderText(fixture.placeholder)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: `${fixture.disclosure} · 0` }));
    expect(screen.queryByPlaceholderText(fixture.placeholder)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exposes saved entries even while restrictions are disabled", () => {
    render(fixture.render(false, [fixture.entry]));
    expect(screen.getByText(fixture.entry)).toBeVisible();
    expect(screen.getByRole("button", { name: `${fixture.disclosure} · 1` })).toHaveAttribute("aria-expanded", "true");
  });

  it("reveals configuration after enabling succeeds", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({}));
    render(fixture.render());
    await userEvent.click(screen.getByRole("switch", { name: fixture.toggle }));
    await waitFor(() => expect(screen.getByPlaceholderText(fixture.placeholder)).toBeVisible());
    expect(screen.getByRole("switch", { name: fixture.toggle })).toBeChecked();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed enable visible without hiding it inside the collapsed details", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ error: "Fixture save failed" }, { status: 500 }));
    render(fixture.render());
    await userEvent.click(screen.getByRole("switch", { name: fixture.toggle }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Fixture save failed");
    expect(screen.getByRole("switch", { name: fixture.toggle })).not.toBeChecked();
    expect(screen.queryByPlaceholderText(fixture.placeholder)).toBeNull();
  });
});

describe("server tool configuration disclosure", () => {
  it("lets users configure a key before enabling search without an automatic request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
    render(<ServerToolsContent data={{ web_search: { enabled: false, has_api_key: false } }} />);
    expect(screen.queryByLabelText("Tavily API key")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "API key · Not configured" }));
    expect(screen.getByLabelText("Tavily API key")).toBeVisible();
    expect(screen.getByRole("switch", { name: "Web Search" })).not.toBeChecked();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reveals key configuration after enabling search and keeps the warning visible when collapsed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({}));
    render(<ServerToolsContent data={{ web_search: { enabled: false, has_api_key: false } }} />);
    await userEvent.click(screen.getByRole("switch", { name: "Web Search" }));
    expect(await screen.findByLabelText("Tavily API key")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "API key · Not configured" }));
    expect(screen.getByText("API key required for search functionality")).toBeVisible();
    expect(screen.queryByLabelText("Tavily API key")).toBeNull();
  });
});
