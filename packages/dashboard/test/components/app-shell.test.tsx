// @vitest-environment jsdom
import { ThemeProvider, TooltipProvider } from "@nocoo/basalt";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RulesContent } from "@/app/routing/rules/rules-content";
import { AppShell } from "@/components/layout/app-shell";
import { LogDockProvider } from "@/components/logs/log-dock-context";
import { fixtureRules, fixtureUpstreams } from "../helpers/routing-fixtures";
import "../helpers/routing-interactions";

const viewport = vi.hoisted(() => ({ mobile: true }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => viewport.mobile }));
vi.mock("next/navigation", () => ({ usePathname: () => "/routing/rules", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null, status: "unauthenticated" }), signOut: vi.fn() }));
vi.mock("@/hooks/use-auth-config", () => ({ useAuthConfig: () => ({ authEnabled: false, isLoading: false, hasError: false }) }));
vi.mock("@/components/logs/logs-dock", () => ({ LogsDock: () => null }));
vi.mock("@/components/setup-wizard", () => ({ SetupWizard: () => null }));
afterEach(() => vi.restoreAllMocks());

const workbench = () => <ThemeProvider defaultTheme="dark" persist={false} applyToDocument={false}><TooltipProvider><LogDockProvider>
  <AppShell><RulesContent rules={[fixtureRules[1]!]} upstreams={fixtureUpstreams} /></AppShell>
</LogDockProvider></TooltipProvider></ThemeProvider>;

describe("responsive routing shell", () => {
  it("keeps the mobile page title and actions without competing breadcrumbs, preserving drafts across resize", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
    const { rerender } = render(workbench());
    const header = within(screen.getByRole("main").querySelector("header")!);
    expect(header.getByRole("heading", { name: "Routing Rules" })).toBeVisible();
    expect(header.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(header.getByRole("button", { name: "Open navigation" })).toBeVisible();
    expect(header.getByRole("button", { name: "Toggle live logs" })).toBeVisible();
    expect(header.getByRole("button", { name: "Toggle theme (now dark)" })).toBeVisible();
    expect(header.getByRole("link", { name: "GitHub repository" })).toBeVisible();
    expect(header.getByRole("link", { name: "Raven on hexly.ai (opens in a new tab)" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Local schedule visualization" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Rule name" }), { target: { value: "Mobile draft" } });

    viewport.mobile = false;
    rerender(workbench());
    const trail = within(header.getByRole("navigation", { name: "Breadcrumb" }));
    expect(trail.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
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
