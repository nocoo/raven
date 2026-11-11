// @vitest-environment jsdom
import { SidebarProvider } from "@nocoo/basalt";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { TooltipProvider } from "@nocoo/basalt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NAV_GROUPS, Sidebar } from "@/components/layout/sidebar";

const router = vi.hoisted(() => ({ push: vi.fn() }));
const identity = vi.hoisted(() => ({ authenticated: false }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/routing/rules" }));
vi.mock("next-auth/react", () => ({
  useSession: () => identity.authenticated
    ? { data: { user: { name: "Fixture user", email: "fixture@example.test" } }, status: "authenticated" }
  : { data: null, status: "unauthenticated" },
  signOut: vi.fn(),
}));
vi.mock("@/hooks/use-auth-config", () => ({
  useAuthConfig: () => ({ authEnabled: identity.authenticated, isLoading: false, hasError: false }),
}));

function shell(collapsed: boolean, extra?: { onNavigate?: () => void }) {
  return (
    <TooltipProvider>
      <SidebarProvider collapsed={collapsed} defaultWidth={260}>
        <Sidebar
          ariaLabel="Main navigation"
          {...(extra?.onNavigate ? { onNavigate: extra.onNavigate } : {})}
        />
      </SidebarProvider>
    </TooltipProvider>
  );
}

beforeEach(() => {
  router.push.mockClear();
  identity.authenticated = false;
});

describe("routing navigation", () => {
  it.each([false, true])("uses SidebarBrand with a 24px mark when collapsed=%s", (collapsed) => {
    render(shell(collapsed));
    const mark = document.querySelector('img[src="/logo-24.png"]');
    expect(mark).not.toBeNull();
    expect(mark).toHaveAttribute("src", "/logo-24.png");
    expect(mark).toHaveAttribute("width", "24");
    expect(mark).toHaveAttribute("height", "24");
    expect(screen.getByText("raven")).toBeInTheDocument();
    if (collapsed) {
      expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
      expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    } else {
      expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    }
    expect(screen.getByText(/^v\d/)).toBeInTheDocument();
  });

  it.each([false, true])("uses package-owned collapsed regions with authenticated=%s", (authenticated) => {
    identity.authenticated = authenticated;
    render(shell(true));
    const avatar = screen.getByText(authenticated ? "F" : "L", { exact: true });
    expect(avatar.closest('[data-slot="sidebar-footer"]')).toBeTruthy();
    expect(avatar.closest('[data-basalt-sidebar]')).toHaveAttribute("data-collapsed");
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("shows sign out in the expanded footer when authenticated", () => {
    identity.authenticated = true;
    render(shell(false));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  it.each([false, true])("keeps native navigation spacing with collapsed=%s", (collapsed) => {
    render(shell(collapsed));
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(nav).toHaveClass("basalt-sidebar-nav", "gap-basalt-nav-gap");
    expect(screen.getByRole("button", { name: "Upstreams" })).toHaveClass(
      "min-h-[calc(var(--basalt-line-row)+2*var(--basalt-space-lg))]",
    );
  });

  it("uses basalt defaults for the collapsed expand control", () => {
    render(shell(true));
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand).not.toHaveClass("self-center", "mb-basalt-space-sm", "w-7", "h-7");
  });

  it.each([false, true])("opens the new destinations with the sidebar collapsed=%s", async (collapsed) => {
    const navigate = vi.fn();
    render(shell(collapsed, { onNavigate: navigate }));
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Upstreams" }));
    expect(router.push).toHaveBeenLastCalledWith("/routing/upstreams");
    await user.click(screen.getByRole("button", { name: "Routing Rules" }));
    expect(router.push).toHaveBeenLastCalledWith("/routing/rules");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(router.push).toHaveBeenLastCalledWith("/connect");
    expect(navigate).toHaveBeenCalledTimes(3);
  });

  it("groups upstreams and rules under Routing and removes the old settings destination", () => {
    expect(NAV_GROUPS.find((group) => group.label === "Routing")?.items.map((item) => item.href)).toEqual([
      "/routing/upstreams",
      "/routing/rules",
    ]);
    expect(NAV_GROUPS.flatMap((group) => group.items).some((item) => item.href === "/settings/upstreams")).toBe(
      false,
    );
  });
});
