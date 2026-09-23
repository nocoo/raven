"use client";

import {
  Button,
  ContentIsland,
  Sheet,
  SheetContent,
  SheetTitle,
} from "@nocoo/basalt";
import { AppHeader } from "@nocoo/basalt/components/app-header";
import {
  AppMain,
  AppSkipLink,
  AppShell as Shell,
} from "@nocoo/basalt/components/app-shell";
import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogsDock } from "@/components/logs/logs-dock";
import { SetupWizard } from "@/components/setup-wizard";
import { useIsMobile } from "@/hooks/use-mobile";
import { HeaderActions } from "./header-actions";
import { NAV_GROUPS, AppSidebar } from "./sidebar";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const isMobile = useIsMobile();
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const group = NAV_GROUPS.find(group => group.items.some(item => item.href === pathname));
  const item = group?.items.find(item => item.href === pathname);
  const crumbs = group ? [{ label: group.label }] : [];

  // Close mobile sidebar on route change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger; setMobileOpen is stable
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  if (pathname === "/login") return children;

  return (
    <Shell className="relative">
      <AppSkipLink>Skip to main content</AppSkipLink>
      {!isMobile ? (
        <AppSidebar collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} />
      ) : (
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="left"
            className="w-[260px] max-w-[260px] border-0 bg-basalt-background p-0"
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <AppSidebar
              collapsed={false}
              onToggle={() => setMobileOpen(false)}
              onNavigate={() => setMobileOpen(false)}
            />
          </SheetContent>
        </Sheet>
      )}
      <AppMain>
        <AppHeader
          leading={
            isMobile ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setMobileOpen(true)}
                aria-label="Open navigation"
              >
                <Menu aria-hidden="true" />
              </Button>
            ) : null
          }
          breadcrumbs={isMobile ? [] : crumbs}
          title={item?.label ?? "Raven"}
          actions={<HeaderActions />}
        />
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col px-2 pb-2 md:px-3 md:pb-3">
            <ContentIsland className="relative">
              <SetupWizard />
              <div className="dashboard-page @container/page min-w-0 w-full">
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
