"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import {
  LayoutDashboard,
  Boxes,
  Cable,
  Cpu,
  CircleUser,
  PanelLeft,
  LogOut,
  ChevronUp,
  Terminal,
  Settings,
} from "lucide-react";
import { cn, getAvatarColor } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useSidebar } from "./sidebar-context";

const isAuthEnabled = !!process.env.NEXT_PUBLIC_AUTH_ENABLED;

// ── Types ──

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
}

interface NavGroup {
  label: string;
  items: NavItem[];
  defaultOpen?: boolean;
}

// ── Navigation config ──

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Monitor",
    defaultOpen: true,
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/logs", label: "Logs", icon: Terminal },
      { href: "/models", label: "Models", icon: Boxes },
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
    label: "Settings",
    defaultOpen: true,
    items: [
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/connect", label: "Connect", icon: Cable },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

// ── Sub-components ──

function NavGroupSection({
  group,
  pathname,
  onNavigate,
}: {
  group: NavGroup;
  pathname: string;
  onNavigate: () => void;
}) {
  const [open, setOpen] = useState(group.defaultOpen ?? true);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="px-3 mt-2">
        <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
            {group.label}
          </span>
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            <ChevronUp
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground/50 transition-transform duration-150",
                !open && "rotate-180",
              )}
              strokeWidth={1.5}
            />
          </span>
        </CollapsibleTrigger>
      </div>
      <div
        className="grid overflow-hidden"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          transition: "grid-template-rows 150ms ease-out",
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-0.5 px-3">
            {group.items.map((item) => {
              const isActive =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-normal transition-colors",
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                  <span className="flex-1 text-left">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </Collapsible>
  );
}

// ── Main component ──

interface SidebarProps {
  mobile?: boolean;
}

export function Sidebar({ mobile = false }: SidebarProps) {
  const pathname = usePathname();
  const { collapsed, toggle, setMobileOpen } = useSidebar();
  const { data: session } = useSession();

  const userName = isAuthEnabled ? (session?.user?.name ?? "User") : "Local";
  const userEmail = isAuthEnabled ? (session?.user?.email ?? "") : "Local mode";
  const userImage = isAuthEnabled ? session?.user?.image : undefined;
  const userInitial = userName[0] ?? "?";

  const handleNavigate = () => setMobileOpen(false);

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        aria-label={mobile ? "Main navigation drawer" : "Main navigation"}
        className={cn(
          "sticky top-0 flex h-screen shrink-0 flex-col bg-background transition-all duration-150 ease-in-out overflow-hidden",
          collapsed ? "w-[68px]" : "w-[260px]",
        )}
      >
        {collapsed ? (
          /* ── Collapsed (icon-only) view ── */
          <div className="flex h-screen w-[68px] flex-col items-center">
            {/* Logo */}
            <div className="flex h-14 w-full items-center justify-start pl-5 pr-3">
              <img
                src="/logo-24.png"
                alt="Raven"
                width={24}
                height={24}
                className="shrink-0"
              />
            </div>

            {/* Expand toggle */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={toggle}
                  aria-label="Expand sidebar"
                  className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors mb-2"
                >
                  <PanelLeft className="h-4 w-4" aria-hidden="true" strokeWidth={1.5} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                Expand sidebar
              </TooltipContent>
            </Tooltip>

            {/* Navigation — flat icon list */}
            <nav className="flex-1 flex flex-col items-center gap-1 overflow-y-auto pt-1">
              {ALL_NAV_ITEMS.map((item) => {
                const isActive =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);

                return (
                  <Tooltip key={item.href}>
                    <TooltipTrigger asChild>
                      <Link
                        href={item.href}
                        onClick={handleNavigate}
                        className={cn(
                          "relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
                          isActive
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                      >
                        <item.icon className="h-4 w-4" strokeWidth={1.5} />
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      {item.label}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </nav>

            {/* User avatar + sign out */}
            <div className="py-3 flex justify-center w-full">
              {isAuthEnabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => signOut({ callbackUrl: "/login" })}
                      aria-label="Sign out"
                      className="cursor-pointer"
                    >
                      <Avatar className="h-9 w-9">
                        {userImage && <AvatarImage src={userImage} alt={userName} />}
                        <AvatarFallback className={cn("text-xs text-white", getAvatarColor(userName))}>
                          {userInitial}
                        </AvatarFallback>
                      </Avatar>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {userName} · Sign out
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <Avatar className="h-9 w-9">
                        <AvatarFallback className={cn("text-xs text-white", getAvatarColor(userName))}>
                          {userInitial}
                        </AvatarFallback>
                      </Avatar>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {userName} · Local mode
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        ) : (
          /* ── Expanded view ── */
          <div className="flex h-screen w-[260px] flex-col">
            {/* Header: logo + collapse toggle */}
            <div className="px-3 h-14 flex items-center">
              <div className="flex w-full items-center justify-between px-3">
                <div className="flex items-center gap-3">
                  <img
                    src="/logo-24.png"
                    alt="Raven"
                    width={24}
                    height={24}
                    className="shrink-0"
                  />
                  <span className="text-lg font-bold tracking-tighter">raven</span>
                </div>
                <button
                  onClick={toggle}
                  aria-label="Collapse sidebar"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
                >
                  <PanelLeft className="h-4 w-4" aria-hidden="true" strokeWidth={1.5} />
                </button>
              </div>
            </div>

            {/* Navigation — grouped with collapsible sections */}
            <nav className="flex-1 overflow-y-auto">
              {NAV_GROUPS.map((group) => (
                <NavGroupSection
                  key={group.label}
                  group={group}
                  pathname={pathname}
                  onNavigate={handleNavigate}
                />
              ))}
            </nav>

            {/* User info + sign out */}
            <div className="px-4 py-3">
              <div className="flex items-center gap-3">
                <Avatar className="h-9 w-9 shrink-0">
                  {userImage && <AvatarImage src={userImage} alt={userName} />}
                  <AvatarFallback className={cn("text-xs text-white", getAvatarColor(userName))}>
                    {userInitial}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{userName}</p>
                  <p className="text-xs text-muted-foreground truncate">{userEmail}</p>
                </div>
                {isAuthEnabled && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => signOut({ callbackUrl: "/login" })}
                        aria-label="Sign out"
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
                      >
                        <LogOut className="h-4 w-4" aria-hidden="true" strokeWidth={1.5} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Sign out</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
        )}
      </aside>
    </TooltipProvider>
  );
}

export { NAV_GROUPS, ALL_NAV_ITEMS };
export type { NavItem, NavGroup };
