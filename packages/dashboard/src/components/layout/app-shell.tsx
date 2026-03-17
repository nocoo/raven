import { Github } from "lucide-react";
import { SidebarShell, MobileMenuButton } from "./sidebar-shell";
import { ThemeToggle } from "./theme-toggle";
import { Breadcrumbs } from "./breadcrumbs";
import { SetupWizard } from "@/components/setup-wizard";

interface AppShellProps {
  children: React.ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
}

export function AppShell({ children, breadcrumbs = [] }: AppShellProps) {
  return (
    <SidebarShell>
      <SetupWizard />
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center justify-between px-4 md:px-6">
        <div className="flex items-center gap-3">
          <MobileMenuButton />
          <Breadcrumbs items={[{ label: "Home", href: "/" }, ...breadcrumbs]} />
        </div>
        <div className="flex items-center gap-1">
          <a
            href="https://github.com/nocoo/raven"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub repository"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Github className="h-[18px] w-[18px]" aria-hidden="true" strokeWidth={1.5} />
          </a>
          <ThemeToggle />
        </div>
      </header>

      {/* Floating island content area */}
      <div className="flex-1 min-h-0 px-2 pb-2 md:px-3 md:pb-3">
        <div className="h-full rounded-island bg-card p-3 md:p-5 overflow-y-auto">
          {children}
        </div>
      </div>
    </SidebarShell>
  );
}
