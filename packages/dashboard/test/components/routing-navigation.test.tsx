// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { TooltipProvider } from "@nocoo/basalt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidebar, NAV_GROUPS } from "@/components/layout/sidebar";

const router = vi.hoisted(() => ({ push: vi.fn() }));
const identity = vi.hoisted(() => ({ authenticated: false }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/routing/rules" }));
vi.mock("next-auth/react", () => ({ useSession: () => identity.authenticated ? { data: { user: { name: "Fixture user", email: "fixture@example.test" } }, status: "authenticated" } : { data: null, status: "unauthenticated" }, signOut: vi.fn() }));
vi.mock("@/hooks/use-auth-config", () => ({ useAuthConfig: () => ({ authEnabled: identity.authenticated, isLoading: false, hasError: false }) }));
beforeEach(() => { router.push.mockClear(); identity.authenticated = false; });

describe("routing navigation", () => {
  it.each([false, true])("centers the collapsed avatar with authenticated=%s", authenticated => {
    identity.authenticated = authenticated;
    render(<TooltipProvider><AppSidebar collapsed onToggle={vi.fn()} /></TooltipProvider>);
    const avatar = screen.getByText(authenticated ? "F" : "L", { exact: true });
    expect(avatar.closest('[data-slot="sidebar-footer"]')).toHaveClass("items-center");
    expect(screen.queryByRole("button", { name: "Sign out" }) !== null).toBe(authenticated);
  });

  it.each([false, true])("opens the new destinations with the sidebar collapsed=%s", async collapsed => {
    const navigate = vi.fn();
    render(<TooltipProvider><AppSidebar collapsed={collapsed} onToggle={vi.fn()} onNavigate={navigate} /></TooltipProvider>);
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
    expect(NAV_GROUPS.find(group => group.label === "Routing")?.items.map(item => item.href)).toEqual(["/routing/upstreams", "/routing/rules"]);
    expect(NAV_GROUPS.flatMap(group => group.items).some(item => item.href === "/settings/upstreams")).toBe(false);
  });
});
