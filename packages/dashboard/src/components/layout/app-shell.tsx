"use client";

import { ContentIsland, SidebarDrawer } from "@nocoo/basalt";
import { AppHeader, AppHeaderMenuButton } from "@nocoo/basalt/components/app-header";
import {
  AppMain,
  AppSkipLink,
  AppShell as Shell,
} from "@nocoo/basalt/components/app-shell";
import { useEffect, useId, useRef } from "react";
import { useAppPathname } from "@/lib/app-navigation";
import { LogsDock } from "@/components/logs/logs-dock";
import { SetupWizard } from "@/components/setup-wizard";
import { useIsMobile } from "@/hooks/use-mobile";
import { HeaderActions } from "./header-actions";
import { MobileNavProvider, useMobileNav } from "./mobile-nav-context";
import { NAV_GROUPS, PersistedSidebarProvider, Sidebar } from "./sidebar";

interface AppShellProps {
  children: React.ReactNode;
}

function AppShellInner({ children }: AppShellProps) {
  const isMobile = useIsMobile();
  const { mobileOpen, setMobileOpen } = useMobileNav();
  const pathname = useAppPathname();
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawerId = useId();
  const group = NAV_GROUPS.find((g) => g.items.some((item) => item.href === pathname));
  const item = group?.items.find((i) => i.href === pathname);
  const allBreadcrumbs = [
    { label: "Home", href: "/" },
    ...(group ? [{ label: group.label }] : []),
  ];
  const breadcrumbs = isMobile ? allBreadcrumbs.slice(-1) : allBreadcrumbs;

  useEffect(() => {
    void pathname;
    setMobileOpen(false);
  }, [pathname, setMobileOpen]);

  if (pathname === "/login") return children;

  return (
    <Shell className="relative">
      <AppSkipLink href="#main-content">Skip to main content</AppSkipLink>

      {!isMobile && (
        <PersistedSidebarProvider>
          <Sidebar ariaLabel="Main navigation" />
        </PersistedSidebarProvider>
      )}

      {isMobile && (
        <SidebarDrawer
          id={drawerId}
          open={mobileOpen}
          onOpenChange={setMobileOpen}
          returnFocusRef={menuButton}
          title="Navigation"
          description="Browse Raven dashboard pages"
        >
          <Sidebar
            ariaLabel="Navigation menu"
            variant="mobile"
            onNavigate={() => setMobileOpen(false)}
            onDismiss={() => setMobileOpen(false)}
          />
        </SidebarDrawer>
      )}

      <AppMain>
        <AppHeader
          density={isMobile ? "compact" : "comfortable"}
          leading={
            isMobile ? (
              <AppHeaderMenuButton
                ref={menuButton}
                label="Open navigation"
                aria-expanded={mobileOpen}
                aria-haspopup="dialog"
                aria-controls={drawerId}
                onClick={() => setMobileOpen(true)}
              />
            ) : undefined
          }
          breadcrumbs={breadcrumbs}
          breadcrumbsLabel="Breadcrumb"
          title={item?.label ?? "Raven"}
          actions={<HeaderActions />}
        />
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col px-2 pb-2 md:px-3 md:pb-3">
            <ContentIsland className="relative">
              <SetupWizard />
              <div id="main-content" className="dashboard-page @container/page min-w-0 w-full">
                {children}
              </div>
            </ContentIsland>
          </div>
          <LogsDock />
        </div>
      </AppMain>
    </Shell>
  );
}

export function AppShell({ children }: AppShellProps) {
  return (
    <MobileNavProvider>
      <AppShellInner>{children}</AppShellInner>
    </MobileNavProvider>
  );
}
