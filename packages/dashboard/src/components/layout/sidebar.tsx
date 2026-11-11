"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Sidebar as BasaltSidebar,
  SidebarBrand,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarIconItem,
  SidebarItem,
  SidebarNav,
  SidebarProvider,
  SidebarToggle,
  SidebarUser,
} from "@nocoo/basalt";
import { useSidebar } from "@nocoo/basalt/components/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nocoo/basalt/components/tooltip";
import {
  Boxes,
  Cable,
  CircleUser,
  Cpu,
  Globe,
  LayoutDashboard,
  List,
  KeyRound,
  Route,
  Settings,
  Shield,
  Wrench,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { type ReactNode, useCallback, useState, type ElementType } from "react";
import { useAuthConfig } from "@/hooks/use-auth-config";
import { APP_VERSION } from "@/lib/version";
import { useAppPathname } from "@/lib/app-navigation";
import { searchParamsToFilters } from "@/lib/analytics-filters";
import { monitorHref } from "@/lib/monitor";

interface NavItem {
  href: string;
  label: string;
  icon: ElementType;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Monitor",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/models", label: "Models", icon: Boxes },
      { href: "/keys", label: "API Keys", icon: KeyRound },
      { href: "/requests", label: "Requests", icon: List },
    ],
  },
  {
    label: "Copilot",
    items: [
      { href: "/copilot/models", label: "Models", icon: Cpu },
      { href: "/copilot/account", label: "Account", icon: CircleUser },
    ],
  },
  {
    label: "Routing",
    items: [
      { href: "/routing/upstreams", label: "Upstreams", icon: Globe },
      { href: "/routing/rules", label: "Routing Rules", icon: Route },
    ],
  },
  {
    label: "Tools",
    items: [
      { href: "/settings/server-tools", label: "Server Tools", icon: Wrench },
    ],
  },
  {
    label: "Settings",
    items: [
      { href: "/settings", label: "General", icon: Settings },
      { href: "/settings/proxy", label: "Proxy", icon: Shield },
      { href: "/connect", label: "Connect", icon: Cable },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

const SIDEBAR_COLLAPSED_KEY = "raven:sidebar-collapsed";
type SidebarCollapsedPreference = "false" | "true";

function navActive(pathname: string, href: string): boolean {
  return href === "/" || href === "/dashboard" || href === "/settings"
    ? pathname === href
    : pathname.startsWith(href);
}

function usePersistedSidebarCollapsed(
  key: string,
  defaultValue: SidebarCollapsedPreference,
): [SidebarCollapsedPreference, (value: SidebarCollapsedPreference) => void] {
  const [stored, setStored] = useState<SidebarCollapsedPreference>(() => {
    if (typeof window === "undefined") return defaultValue;
    const value = localStorage.getItem(key);
    return value === "true" || value === "false" ? value : defaultValue;
  });

  const setValue = useCallback(
    (next: SidebarCollapsedPreference) => {
      setStored(next);
      localStorage.setItem(key, next);
    },
    [key],
  );

  return [stored, setValue];
}

export function PersistedSidebarProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = usePersistedSidebarCollapsed(SIDEBAR_COLLAPSED_KEY, "false");
  const collapsed = stored === "true";
  const onCollapsedChange = useCallback(
    (next: boolean) => {
      setStored(next ? "true" : "false");
    },
    [setStored],
  );

  return (
    <SidebarProvider collapsed={collapsed} onCollapsedChange={onCollapsedChange} defaultWidth={260}>
      {children}
    </SidebarProvider>
  );
}

interface SidebarProps {
  ariaLabel: string;
  variant?: "desktop" | "mobile";
  onNavigate?: () => void;
  onDismiss?: () => void;
}

function RavenSidebarBody({
  variant,
  onNavigate,
  onDismiss,
}: {
  variant?: SidebarProps["variant"];
  onNavigate?: () => void;
  onDismiss?: () => void;
}) {
  const pathname = useAppPathname();
  const router = useRouter();
  const { collapsed, peek, peeking } = useSidebar();
  const railCollapsed = collapsed && !(peek && peeking);
  const { data: session, status: sessionStatus } = useSession();
  const { authEnabled, isLoading: authLoading, hasError } = useAuthConfig();

  const sessionLoading = sessionStatus === "loading";
  const hasSession = !!session?.user;

  let showAsAuth: boolean;
  if (authLoading) {
    showAsAuth = sessionLoading || hasSession;
  } else if (hasError) {
    showAsAuth = sessionLoading || hasSession;
  } else {
    showAsAuth = authEnabled;
  }

  const userName = showAsAuth ? (session?.user?.name ?? "User") : "Local";
  const userEmail = showAsAuth ? (session?.user?.email ?? "") : "Local mode";
  const userImage = showAsAuth ? session?.user?.image : undefined;
  const userInitial = userName[0] ?? "?";

  const go = (href: string) => {
    const monitorRoutes = ["/", "/models", "/keys", "/requests"];
    router.push(monitorRoutes.includes(href) && monitorRoutes.includes(pathname)
      ? monitorHref(href, searchParamsToFilters(new URLSearchParams(window.location.search)))
      : href);
    onNavigate?.();
  };

  const avatar = (
    <Avatar>
      {userImage ? <AvatarImage src={userImage} alt={userName} /> : null}
      <AvatarFallback>{userInitial}</AvatarFallback>
    </Avatar>
  );

  return (
    <>
      <SidebarHeader>
        <SidebarBrand
          logo={<Image src="/logo-24.png" alt="" width={24} height={24} unoptimized />}
          name="raven"
          version={`v${APP_VERSION}`}
          action={
            variant === "mobile" ? (
              <SidebarToggle
                mode="dismiss"
                dismissLabel="Close navigation"
                {...(onDismiss ? { onDismiss } : {})}
              />
            ) : (
              <SidebarToggle expandLabel="Expand sidebar" collapseLabel="Collapse sidebar" />
            )
          }
        />
      </SidebarHeader>
      <SidebarNav aria-label={variant === "mobile" ? "Navigation menu" : "Main navigation"}>
        {railCollapsed
          ? ALL_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = navActive(pathname, item.href);
              return (
                <Tooltip key={item.href} delayDuration={0}>
                  <TooltipTrigger asChild>
                    <SidebarIconItem
                      active={active}
                      aria-label={item.label}
                      onClick={() => go(item.href)}
                    >
                      <Icon className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
                    </SidebarIconItem>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {item.label}
                  </TooltipContent>
                </Tooltip>
              );
            })
          : NAV_GROUPS.map((group) => (
              <SidebarGroup key={group.label} label={group.label}>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = navActive(pathname, item.href);
                  return (
                    <SidebarItem
                      key={item.href}
                      active={active}
                      onClick={() => go(item.href)}
                    >
                      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                      <span className="flex-1 truncate text-left">{item.label}</span>
                    </SidebarItem>
                  );
                })}
              </SidebarGroup>
            ))}
      </SidebarNav>
      <SidebarFooter>
        <SidebarUser
          name={userName}
          email={userEmail || undefined}
          avatar={avatar}
          tooltip={userName}
          {...(showAsAuth
            ? { onSignOut: () => signOut({ callbackUrl: "/login" }), signOutLabel: "Sign out" }
            : {})}
        />
      </SidebarFooter>
    </>
  );
}

export function Sidebar({ ariaLabel, variant = "desktop", onNavigate, onDismiss }: SidebarProps) {
  return (
    <BasaltSidebar aria-label={ariaLabel} resizable={false}>
      <RavenSidebarBody
        variant={variant}
        {...(onNavigate ? { onNavigate } : {})}
        {...(onDismiss ? { onDismiss } : {})}
      />
    </BasaltSidebar>
  );
}

export { NAV_GROUPS, ALL_NAV_ITEMS };
export type { NavItem, NavGroup };
