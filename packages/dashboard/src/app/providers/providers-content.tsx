"use client";

import { useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Route,
  Globe,
  Shuffle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCompact, formatLatency, formatPercent } from "@/lib/chart-config";
import { cn } from "@/lib/utils";
import type { BreakdownEntry } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabId = "strategy" | "upstream" | "routing";

interface ProvidersContentProps {
  strategies: BreakdownEntry[];
  upstreams: BreakdownEntry[];
  routingPaths: BreakdownEntry[];
}

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "strategy", label: "Strategies", icon: Route },
  { id: "upstream", label: "Upstreams", icon: Globe },
  { id: "routing", label: "Routing Paths", icon: Shuffle },
];

// ---------------------------------------------------------------------------
// Ranking table columns
// ---------------------------------------------------------------------------

const COLUMNS = [
  { key: "key", label: "Name", sortable: false },
  { key: "count", label: "Requests", sortable: true },
  { key: "total_tokens", label: "Tokens", sortable: true },
  { key: "avg_latency_ms", label: "Avg Latency", sortable: true },
  { key: "p95_latency_ms", label: "P95 Latency", sortable: true },
  { key: "error_rate", label: "Error Rate", sortable: true },
  { key: "last_seen", label: "Last Seen", sortable: true },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(epoch: number): string {
  const diff = Date.now() - epoch;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatCellValue(entry: BreakdownEntry, key: string): string {
  switch (key) {
    case "key":
      return entry.key || "(unknown)";
    case "count":
      return formatCompact(entry.count);
    case "total_tokens":
      return formatCompact(entry.total_tokens);
    case "avg_latency_ms":
      return formatLatency(entry.avg_latency_ms);
    case "p95_latency_ms":
      return formatLatency(entry.p95_latency_ms);
    case "error_rate":
      return formatPercent(entry.error_rate);
    case "last_seen":
      return formatRelativeTime(entry.last_seen);
    default:
      return "";
  }
}

/** Tab-specific filter key for drill-through to /requests */
function filterKeyForTab(tab: TabId): string {
  switch (tab) {
    case "strategy":
      return "strategy";
    case "upstream":
      return "upstream";
    case "routing":
      return "routing_path";
  }
}

// ---------------------------------------------------------------------------
// Distribution bar — top-level breakdown visualization
// ---------------------------------------------------------------------------

function DistributionBar({ data }: { data: BreakdownEntry[] }) {
  if (data.length === 0) return null;
  const total = data.reduce((sum, d) => sum + d.count, 0);
  if (total === 0) return null;

  const BAR_COLORS = [
    "bg-blue-500",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-purple-500",
    "bg-rose-500",
    "bg-cyan-500",
    "bg-orange-500",
    "bg-indigo-500",
  ];

  return (
    <div className="space-y-2">
      {/* Stacked bar */}
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted/50">
        {data.map((entry, i) => {
          const pct = (entry.count / total) * 100;
          if (pct < 0.5) return null;
          return (
            <div
              key={entry.key}
              className={cn(BAR_COLORS[i % BAR_COLORS.length], "transition-all")}
              style={{ width: `${pct}%` }}
              title={`${entry.key}: ${formatCompact(entry.count)} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {data.slice(0, 8).map((entry, i) => {
          const pct = total > 0 ? (entry.count / total) * 100 : 0;
          return (
            <div key={entry.key} className="flex items-center gap-1.5 text-xs">
              <span className={cn("size-2 rounded-full shrink-0", BAR_COLORS[i % BAR_COLORS.length])} />
              <span className="text-muted-foreground truncate max-w-[120px]">{entry.key || "(unknown)"}</span>
              <span className="tabular-nums font-medium">{pct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ranking table
// ---------------------------------------------------------------------------

function RankingTable({
  data,
  sortCol,
  sortOrder,
  onSort,
  onRowClick,
}: {
  data: BreakdownEntry[];
  sortCol: string;
  sortOrder: string;
  onSort: (col: string) => void;
  onRowClick: (entry: BreakdownEntry) => void;
}) {
  return (
    <div className="bg-secondary rounded-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-2.5 text-left text-card-label font-medium whitespace-nowrap"
                >
                  {col.sortable ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="gap-1 -ml-1.5"
                      onClick={() => onSort(col.key)}
                    >
                      {col.label}
                      {sortCol === col.key ? (
                        sortOrder === "desc" ? (
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
                onClick={() => onRowClick(entry)}
              >
                {COLUMNS.map((col) => (
                  <td key={col.key} className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                    {col.key === "key" ? (
                      <span className="font-medium text-foreground">
                        {entry.key || "(unknown)"}
                      </span>
                    ) : col.key === "error_rate" ? (
                      <Badge
                        variant={
                          entry.error_rate > 0.1
                            ? "destructive"
                            : entry.error_rate > 0.05
                              ? "warning"
                              : "secondary"
                        }
                        className="text-[10px] px-1.5"
                      >
                        {formatCellValue(entry, col.key)}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">
                        {formatCellValue(entry, col.key)}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {data.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-muted-foreground">
                  No data found for the selected time range
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main content
// ---------------------------------------------------------------------------

export function ProvidersContent({ strategies, upstreams, routingPaths }: ProvidersContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabId>("strategy");

  // Client-side sort state (separate from URL for in-memory sort)
  const [sortCol, setSortCol] = useState("count");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const handleSort = useCallback((col: string) => {
    if (sortCol === col) {
      setSortOrder((prev) => (prev === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      setSortOrder("desc");
    }
  }, [sortCol]);

  const handleRowClick = useCallback(
    (entry: BreakdownEntry) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(filterKeyForTab(activeTab), entry.key);
      router.push(`/requests?${params.toString()}`);
    },
    [searchParams, router, activeTab],
  );

  // Select data based on tab and sort client-side
  const rawData = activeTab === "strategy" ? strategies
    : activeTab === "upstream" ? upstreams
    : routingPaths;

  const sortedData = [...rawData].sort((a, b) => {
    let aVal: number;
    let bVal: number;
    switch (sortCol) {
      case "count":
        aVal = a.count; bVal = b.count; break;
      case "total_tokens":
        aVal = a.total_tokens; bVal = b.total_tokens; break;
      case "avg_latency_ms":
        aVal = a.avg_latency_ms; bVal = b.avg_latency_ms; break;
      case "p95_latency_ms":
        aVal = a.p95_latency_ms; bVal = b.p95_latency_ms; break;
      case "error_rate":
        aVal = a.error_rate; bVal = b.error_rate; break;
      case "last_seen":
        aVal = a.last_seen; bVal = b.last_seen; break;
      default:
        return 0;
    }
    return sortOrder === "desc" ? bVal - aVal : aVal - bVal;
  });

  return (
    <div className="space-y-4">
      {/* Tab selector */}
      <div className="flex gap-1 rounded-lg bg-muted/50 p-1 w-fit">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setActiveTab(tab.id);
              setSortCol("count");
              setSortOrder("desc");
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              activeTab === tab.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <tab.icon className="size-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Distribution visualization */}
      <DistributionBar data={rawData} />

      {/* Ranking table */}
      <RankingTable
        data={sortedData}
        sortCol={sortCol}
        sortOrder={sortOrder}
        onSort={handleSort}
        onRowClick={handleRowClick}
      />
    </div>
  );
}
