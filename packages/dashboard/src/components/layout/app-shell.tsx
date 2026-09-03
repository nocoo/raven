"use client";

import {
  Button,
  ContentIsland,
  Sheet,
  SheetContent,
  SheetTitle,
  ThemeToggle,
} from "@nocoo/basalt";
import { AppHeader } from "@nocoo/basalt/components/app-header";
import {
  AppMain,
  AppSkipLink,
  AppShell as Shell,
} from "@nocoo/basalt/components/app-shell";
import { useTheme } from "@nocoo/basalt/providers/theme";
import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Github } from "@/components/icons/github";
import { SetupWizard } from "@/components/setup-wizard";
import { useIsMobile } from "@/hooks/use-mobile";
import { AppSidebar } from "./sidebar";

interface AppShellProps {
  children: React.ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
}

function headerTrail(breadcrumbs: { label: string; href?: string }[]) {
  if (breadcrumbs.length === 0) {
    return { crumbs: [] as { href?: string; label: string }[], title: "Overview" };
  }
  return {
    crumbs: [{ href: "/", label: "Home" }, ...breadcrumbs.slice(0, -1)],
    title: breadcrumbs[breadcrumbs.length - 1]?.label ?? "Overview",
  };
}

export function AppShell({ children, breadcrumbs = [] }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const isMobile = useIsMobile();
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const { theme } = useTheme();
  const { crumbs, title } = headerTrail(breadcrumbs);

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

  return (
    <Shell>
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
          breadcrumbs={crumbs}
          title={title}
          actions={
            <>
              <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                <a
                  href="https://github.com/nocoo/raven"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="GitHub repository"
                >
                  <Github className="h-[18px] w-[18px]" aria-hidden="true" strokeWidth={1.5} />
                </a>
              </Button>
              <ThemeToggle aria-label={`Toggle theme (now ${theme})`} />
            </>
          }
        />
        <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 md:px-3 md:pb-3">
          <ContentIsland>
            <SetupWizard />
            {children}
          </ContentIsland>
        </div>
      </AppMain>
    </Shell>
  );
}
