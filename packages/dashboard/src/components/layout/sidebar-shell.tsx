"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Sidebar } from "./sidebar";
import { SidebarProvider, useSidebar } from "./sidebar-context";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";

function SidebarShellInner({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
  const { mobileOpen, setMobileOpen } = useSidebar();
  const pathname = usePathname();

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, setMobileOpen]);

  // Prevent body scroll when mobile sidebar is open
  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
    <div className="flex h-screen w-full bg-background">
      {/* Desktop sidebar */}
      {!isMobile && <Sidebar />}

      {isMobile && (
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-[260px] p-0 sm:max-w-[260px]" showCloseButton={false}>
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
              <SheetDescription>Browse Raven dashboard pages</SheetDescription>
            </SheetHeader>
            <Sidebar mobile />
          </SheetContent>
        </Sheet>
      )}

      <main className="flex flex-1 flex-col h-full min-w-0">
        {children}
      </main>
    </div>
  );
}

export function SidebarShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <SidebarShellInner>
        {children}
      </SidebarShellInner>
    </SidebarProvider>
  );
}

/**
 * Mobile hamburger button — must be inside SidebarProvider context.
 */
export function MobileMenuButton() {
  const { setMobileOpen } = useSidebar();

  return (
    <button
      onClick={() => setMobileOpen(true)}
      aria-label="Open navigation menu"
      className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors md:hidden"
    >
      <Menu className="h-5 w-5" aria-hidden="true" strokeWidth={1.5} />
    </button>
  );
}
