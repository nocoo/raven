"use client";

import {
  ContentIsland,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SidebarProvider,
} from "@nocoo/basalt";
import { AppHeader, AppHeaderMenuButton } from "@nocoo/basalt/components/app-header";
import {
  AppMain,
  AppSkipLink,
  AppShell as Shell,
} from "@nocoo/basalt/components/app-shell";
import { useEffect, useRef } from "react";
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
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            id="mobile-navigation-sheet"
            side="left"
            className="w-[260px] max-w-[260px] border-0 bg-basalt-background p-0 sm:max-w-[260px] sm:p-0"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              menuButton.current?.focus();
            }}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
              <SheetDescription>Browse Raven dashboard pages</SheetDescription>
            </SheetHeader>
            <SidebarProvider collapsed={false} defaultWidth={260}>
              <Sidebar
                ariaLabel="Navigation menu"
                variant="mobile"
                onNavigate={() => setMobileOpen(false)}
                onDismiss={() => setMobileOpen(false)}
              />
            </SidebarProvider>
          </SheetContent>
        </Sheet>
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
                aria-controls={mobileOpen ? "mobile-navigation-sheet" : undefined}
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
