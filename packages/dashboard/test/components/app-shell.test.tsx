// @vitest-environment jsdom
import { ThemeProvider, TooltipProvider } from "@nocoo/basalt";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RulesContent } from "@/app/routing/rules/rules-content";
import { AppShell } from "@/components/layout/app-shell";
import { LogDockProvider } from "@/components/logs/log-dock-context";
import { fixtureRules, fixtureUpstreams } from "../helpers/routing-fixtures";
import "../helpers/routing-interactions";

const viewport = vi.hoisted(() => ({ mobile: true, pathname: "/routing/rules" }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => viewport.mobile }));
vi.mock("next/navigation", () => ({ usePathname: () => viewport.pathname, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null, status: "unauthenticated" }), signOut: vi.fn() }));
vi.mock("@/hooks/use-auth-config", () => ({ useAuthConfig: () => ({ authEnabled: false, isLoading: false, hasError: false }) }));
vi.mock("@/components/logs/logs-dock", () => ({ LogsDock: () => null }));
vi.mock("@/components/setup-wizard", () => ({ SetupWizard: () => null }));
afterEach(() => vi.restoreAllMocks());
beforeEach(() => { viewport.mobile = true; viewport.pathname = "/routing/rules"; });

const workbench = () => <ThemeProvider defaultTheme="dark" persist={false} applyToDocument={false}><TooltipProvider><LogDockProvider>
  <AppShell><RulesContent rules={[fixtureRules[1]!]} upstreams={fixtureUpstreams} /></AppShell>
</LogDockProvider></TooltipProvider></ThemeProvider>;

describe("responsive routing shell", () => {
  it("keeps the mobile page title and actions without competing breadcrumbs, preserving drafts across resize", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
    const { rerender } = render(workbench());
    await userEvent.setup({ delay: null }).click(screen.getByRole("tab", { name: /^Schedule/ }));
    const header = within(screen.getByRole("main").querySelector("header")!);
    expect(header.getByRole("heading", { name: "Routing Rules" })).toBeVisible();
    expect(header.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(header.getByRole("button", { name: "Open navigation" })).toBeVisible();
    expect(header.queryByRole("button", { name: /logs/i })).toBeNull();
    expect(header.getByRole("button", { name: "Toggle theme (now dark)" })).toBeVisible();
    expect(header.getByRole("link", { name: "GitHub repository" })).toBeVisible();
    expect(header.getByRole("link", { name: "Raven on hexly.ai (opens in a new tab)" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Local schedule visualization" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Rule name" }), { target: { value: "Mobile draft" } });

    viewport.mobile = false;
    rerender(workbench());
    const trail = within(header.getByRole("navigation", { name: "Breadcrumb" }));
    expect(trail.queryByText("Home")).toBeNull();
    expect(trail.getByText("Routing")).toBeVisible();
    expect(header.getByRole("heading", { name: "Routing Rules" })).toBeVisible();
    expect(header.queryByRole("button", { name: "Open navigation" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Rule name" })).toHaveValue("Mobile draft");
    expect(screen.getByText("Unsaved changes")).toBeVisible();

    viewport.mobile = true;
    rerender(workbench());
    expect(header.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(screen.getByRole("region", { name: "Local schedule visualization" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Rule name" })).toHaveValue("Mobile draft");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("site-wide navigation and page frame", () => {
  it.each([
    ["/", "Monitor", "Overview"],
    ["/models", "Monitor", "Models"],
    ["/keys", "Monitor", "API Keys"],
    ["/requests", "Monitor", "Requests"],
    ["/copilot/models", "Copilot", "Models"],
    ["/copilot/account", "Copilot", "Account"],
    ["/routing/upstreams", "Routing", "Upstreams"],
    ["/routing/rules", "Routing", "Routing Rules"],
    ["/settings/server-tools", "Tools", "Server Tools"],
    ["/settings", "Settings", "General"],
    ["/settings/proxy", "Settings", "Proxy"],
    ["/connect", "Settings", "Connect"],
  ])("aligns %s with its sidebar group and the shared full-width frame", (pathname, group, title) => {
    viewport.pathname = pathname!;
    viewport.mobile = false;
    const { container } = render(<ThemeProvider persist={false} applyToDocument={false}><TooltipProvider><LogDockProvider><AppShell><p>Page content</p></AppShell></LogDockProvider></TooltipProvider></ThemeProvider>);
    const header = within(screen.getByRole("main").querySelector("header")!);
    expect(header.getByRole("heading", { name: title })).toBeVisible();
    expect(header.queryByRole("button", { name: /logs/i })).toBeNull();
    const trail = within(header.getByRole("navigation", { name: "Breadcrumb" }));
    expect(trail.getByText(group!)).toBeVisible();
    expect(trail.queryByRole("link")).toBeNull();
    const frame = container.querySelector(".dashboard-page");
    expect(frame).toHaveClass("w-full", "@container/page");
    expect(frame?.className).not.toMatch(/max-w-/);
  });
});
