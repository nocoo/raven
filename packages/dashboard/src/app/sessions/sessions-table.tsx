"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCompact, formatPercent } from "@/lib/chart-config";
import type { BreakdownEntry } from "@/lib/types";

interface SessionsTableProps {
  data: BreakdownEntry[];
  currentSort: string;
  currentOrder: string;
}

const COLUMNS = [
  { key: "key", label: "Session ID", sortable: false },
  { key: "client_name", label: "Client", sortable: false },
  { key: "account_name", label: "Account", sortable: false },
  { key: "count", label: "Requests", sortable: true },
  { key: "duration", label: "Duration", sortable: false },
  { key: "total_tokens", label: "Tokens", sortable: true },
  { key: "error_rate", label: "Error Rate", sortable: true },
  { key: "last_seen", label: "Last Active", sortable: true },
] as const;

function formatRelativeTime(epoch: number): string {
  const diff = Date.now() - epoch;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatDuration(firstSeen: number, lastSeen: number): string {
  const duration = lastSeen - firstSeen;
  if (duration < 60000) return `${Math.round(duration / 1000)}s`;
  if (duration < 3600000) return `${Math.floor(duration / 60000)}m`;
  if (duration < 86400000) return `${Math.floor(duration / 3600000)}h ${Math.floor((duration % 3600000) / 60000)}m`;
  return `${Math.floor(duration / 86400000)}d`;
}

function truncateSessionId(id: string): string {
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

export function SessionsTable({ data, currentSort, currentOrder }: SessionsTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const toggleSort = useCallback(
    (col: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (currentSort === col) {
        params.set("sorder", currentOrder === "desc" ? "asc" : "desc");
      } else {
        params.set("ssort", col);
        params.set("sorder", "desc");
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [currentSort, currentOrder, searchParams, router, pathname],
  );

  return (
    <div className="bg-secondary rounded-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground whitespace-nowrap"
                >
                  {col.sortable ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="gap-1 -ml-1.5"
                      onClick={() => toggleSort(col.key)}
                    >
                      {col.label}
                      {currentSort === col.key ? (
                        currentOrder === "desc" ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ArrowUp className="size-3" />
                        )
                      ) : (
                        <ArrowUpDown className="size-3 opacity-40" />
                      )}
                    </Button>
                  ) : (
                    col.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((entry) => (
              <tr
                key={entry.key}
                className="border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer"
                onClick={() => {
                  const params = new URLSearchParams(searchParams.toString());
                  params.set("session", entry.key);
                  router.push(`/requests?${params.toString()}`);
                }}
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="font-mono text-xs font-medium text-foreground">
                    {truncateSessionId(entry.key || "(unknown)")}
                  </span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                  {entry.client_name || "—"}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                  {entry.account_name || "—"}
                </td>
                <td className="px-3 py-2 whitespace-nowrap tabular-nums text-xs text-muted-foreground">
                  {formatCompact(entry.count)}
                </td>
                <td className="px-3 py-2 whitespace-nowrap tabular-nums text-xs text-muted-foreground">
                  {formatDuration(entry.first_seen, entry.last_seen)}
                </td>
                <td className="px-3 py-2 whitespace-nowrap tabular-nums text-xs text-muted-foreground">
                  {formatCompact(entry.total_tokens)}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <Badge
                    variant={entry.error_rate > 0.1 ? "destructive" : entry.error_rate > 0.05 ? "warning" : "secondary"}
                    className="text-[10px] px-1.5"
                  >
                    {formatPercent(entry.error_rate)}
                  </Badge>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                  {formatRelativeTime(entry.last_seen)}
                </td>
              </tr>
            ))}
            {data.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-muted-foreground">
                  No session data found for the selected time range
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
