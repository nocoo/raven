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
  MessageSquare,
  PanelLeft,
  Route,
  Settings,
  Shield,
  Users,
  Wrench,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { usePathname, useRouter } from "next/navigation";
import type { ElementType } from "react";
import { useAuthConfig } from "@/hooks/use-auth-config";
import { cn, getAvatarColor } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";

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
      { href: "/requests", label: "Requests", icon: List },
      { href: "/models", label: "Models", icon: Boxes },
      { href: "/clients", label: "Clients", icon: Users },
      { href: "/sessions", label: "Sessions", icon: MessageSquare },
      { href: "/providers", label: "Providers", icon: Route },
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
    label: "Tools",
    defaultOpen: true,
    items: [
      { href: "/settings/server-tools", label: "Server Tools", icon: Wrench },
      { href: "/settings/upstreams", label: "Upstreams", icon: Globe },
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

function RavenMark({ className }: { className?: string }) {
  return (
    // biome-ignore lint/performance/noImgElement: static local 24px logo, next/image adds no benefit
    <img src="/logo-24.png" alt="Raven" width={24} height={24} className={className} />
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
    router.push(href);
    onNavigate?.();
  };

  const avatar = (
    <Avatar className="h-9 w-9 shrink-0">
      {userImage ? <AvatarImage src={userImage} alt={userName} /> : null}
      <AvatarFallback className={cn("text-xs text-white", getAvatarColor(userName))}>
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
          className="h-8 w-8 shrink-0"
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
          <SidebarHeader className="justify-center px-0">
            <RavenMark className="h-5 w-5" />
          </SidebarHeader>
          <Button
            variant="ghost"
            size="icon"
            className="mb-1 self-center"
            onClick={onToggle}
            aria-label="Expand sidebar"
          >
            <PanelLeft aria-hidden="true" />
          </Button>
          <SidebarNav className="w-full items-center gap-1 pt-1">
            {ALL_NAV_ITEMS.map((item) => (
              <Tooltip key={item.href} delayDuration={0}>
                <TooltipTrigger asChild>
                  <SidebarIconItem
                    active={navActive(pathname, item.href)}
                    aria-label={item.label}
                    className="self-center"
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
          <SidebarFooter className="flex w-full justify-center px-0">
            {showAsAuth ? (
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="cursor-pointer"
                    aria-label="Sign out"
                    onClick={() => signOut({ callbackUrl: "/login" })}
                  >
                    {avatar}
                  </button>
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
              <div className="flex min-w-0 items-center gap-3">
                <RavenMark className="h-5 w-5 shrink-0" />
                <span className="truncate text-lg font-semibold text-basalt-foreground md:text-xl">
                  raven
                </span>
                <span className="shrink-0 rounded-md bg-basalt-secondary px-1.5 py-0.5 text-[10px] leading-none font-medium text-basalt-muted-foreground">
                  v{APP_VERSION}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={onToggle}
                aria-label="Collapse sidebar"
              >
                <PanelLeft aria-hidden="true" />
              </Button>
            </div>
          </SidebarHeader>
          <SidebarNav className="pt-1">
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
