"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Sidebar,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarIconItem,
  SidebarItem,
  SidebarNav,
  SidebarUser,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nocoo/basalt";
import {
  Boxes,
  Cable,
  CircleUser,
  Cpu,
  Globe,
  LayoutDashboard,
  List,
  LogOut,
  KeyRound,
  PanelLeft,
  Settings,
  Shield,
  Wrench,
  Route,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { usePathname, useRouter } from "next/navigation";
import type { ElementType } from "react";
import { useAuthConfig } from "@/hooks/use-auth-config";
import { APP_VERSION } from "@/lib/version";
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
  defaultOpen?: boolean;
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Monitor",
    defaultOpen: true,
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/models", label: "Models", icon: Boxes },
      { href: "/keys", label: "API Keys", icon: KeyRound },
      { href: "/requests", label: "Requests", icon: List },
    ],
  },
  {
    label: "Copilot",
    defaultOpen: true,
    items: [
      { href: "/copilot/models", label: "Models", icon: Cpu },
      { href: "/copilot/account", label: "Account", icon: CircleUser },
    ],
  },
  {
    label: "Routing",
    defaultOpen: true,
    items: [
      { href: "/routing/upstreams", label: "Upstreams", icon: Globe },
      { href: "/routing/rules", label: "Routing Rules", icon: Route },
    ],
  },
  {
    label: "Tools",
    defaultOpen: true,
    items: [
      { href: "/settings/server-tools", label: "Server Tools", icon: Wrench },
    ],
  },
  {
    label: "Settings",
    defaultOpen: true,
    items: [
      { href: "/settings", label: "General", icon: Settings },
      { href: "/settings/proxy", label: "Proxy", icon: Shield },
      { href: "/connect", label: "Connect", icon: Cable },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

function navActive(pathname: string, href: string): boolean {
  return href === "/" || href === "/dashboard" || href === "/settings"
    ? pathname === href
    : pathname.startsWith(href);
}

function RavenMark() {
  return (
    <span className="flex w-[calc(var(--basalt-size-rail)-2*var(--basalt-space-nav-inset))] shrink-0 justify-center">
      {/* biome-ignore lint/performance/noImgElement: static local 24px logo, next/image adds no benefit */}
      <img src="/logo-24.png" alt="Raven" width={24} height={24} className="size-basalt-5 shrink-0" />
    </span>
  );
}

interface AppSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
}

export function AppSidebar({ collapsed, onToggle, onNavigate }: AppSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
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
      <AvatarFallback>
        {userInitial}
      </AvatarFallback>
    </Avatar>
  );

  const signOutButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label="Sign out"
          onClick={() => signOut({ callbackUrl: "/login" })}
        >
          <LogOut className="h-4 w-4" aria-hidden="true" strokeWidth={1.5} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">Sign out</TooltipContent>
    </Tooltip>
  );

  return (
    <Sidebar collapsed={collapsed}>
      {collapsed ? (
        <>
          <SidebarHeader>
            <RavenMark />
          </SidebarHeader>
          <Button
            variant="ghost"
            size="icon"
            className="mb-basalt-space-sm self-center"
            onClick={onToggle}
            aria-label="Expand sidebar"
          >
            <PanelLeft aria-hidden="true" />
          </Button>
          <SidebarNav>
            {ALL_NAV_ITEMS.map((item) => (
              <Tooltip key={item.href} delayDuration={0}>
                <TooltipTrigger asChild>
                  <SidebarIconItem
                    active={navActive(pathname, item.href)}
                    aria-label={item.label}
                    onClick={() => go(item.href)}
                  >
                    <item.icon className="h-4 w-4" strokeWidth={1.5} />
                  </SidebarIconItem>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {item.label}
                </TooltipContent>
              </Tooltip>
            ))}
          </SidebarNav>
          <SidebarFooter>
            {showAsAuth ? (
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-basalt-9 rounded-basalt-full"
                    aria-label="Sign out"
                    onClick={() => signOut({ callbackUrl: "/login" })}
                  >
                    {avatar}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {userName} · Sign out
                </TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <span className="inline-flex">{avatar}</span>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {userName} · Local mode
                </TooltipContent>
              </Tooltip>
            )}
          </SidebarFooter>
        </>
      ) : (
        <>
          <SidebarHeader>
            <div className="flex w-full items-center justify-between">
              <div className="flex min-w-0 items-center gap-basalt-row-gap">
                <RavenMark />
                <span className="truncate text-lg font-semibold text-basalt-foreground md:text-xl">
                  raven
                </span>
                <span className="shrink-0 rounded-basalt-sm bg-basalt-secondary px-basalt-space-md py-basalt-space-xs font-mono text-basalt-xs leading-none text-basalt-muted-foreground">
                  v{APP_VERSION}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={onToggle}
                aria-label="Collapse sidebar"
              >
                <PanelLeft aria-hidden="true" />
              </Button>
            </div>
          </SidebarHeader>
          <SidebarNav>
            {NAV_GROUPS.map((group) => (
              <SidebarGroup
                key={group.label}
                label={group.label}
                defaultOpen={group.defaultOpen ?? true}
              >
                {group.items.map((item) => (
                  <SidebarItem
                    key={item.href}
                    active={navActive(pathname, item.href)}
                    onClick={() => go(item.href)}
                  >
                    <item.icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                    <span className="flex-1 truncate text-left">{item.label}</span>
                  </SidebarItem>
                ))}
              </SidebarGroup>
            ))}
          </SidebarNav>
          <SidebarFooter>
            <SidebarUser
              name={userName}
              email={userEmail}
              avatar={avatar}
              {...(showAsAuth ? { action: signOutButton } : {})}
            />
          </SidebarFooter>
        </>
      )}
    </Sidebar>
  );
}

export { NAV_GROUPS, ALL_NAV_ITEMS };
export type { NavItem, NavGroup };
export { AppSidebar as Sidebar };
