"use client";



import { formatCompact, formatLatency, formatPercent } from "@/lib/chart-config";
import { cn } from "@/lib/utils";
import type { BreakdownEntry } from "@/lib/types";
import { useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpDown, ArrowUp, ArrowDown, Route, Globe, Shuffle, } from "lucide-react";
import { Badge, Button, LayerCard, Tabs, TabsContent, TabsList, TabsTrigger } from "@nocoo/basalt";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nocoo/basalt/components/table";

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
    "bg-basalt-chart-1",
    "bg-basalt-chart-2",
    "bg-basalt-chart-3",
    "bg-basalt-chart-4",
    "bg-basalt-chart-5",
    "bg-basalt-chart-6",
    "bg-basalt-chart-7",
    "bg-basalt-chart-8",
  ];

  return (
    <div className="space-y-2">
      {/* Stacked bar */}
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-basalt-background">
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
              <span className="text-basalt-muted-foreground truncate max-w-[120px]">{entry.key || "(unknown)"}</span>
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
    <LayerCard padding="none" className="overflow-hidden">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-basalt-border">
              {COLUMNS.map((col) => (
                <TableHead
                  key={col.key}
                  className="px-3 py-2.5 text-left text-card-label font-medium whitespace-nowrap"
                >
                  {col.sortable ? (
                    <Button
                      variant="ghost"
                      size="sm"
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
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((entry) => (
              <TableRow
                key={entry.key}
                className="border-b border-basalt-border/50 hover:bg-basalt-background/50 transition-colors cursor-pointer"
                onClick={() => onRowClick(entry)}
              >
                {COLUMNS.map((col) => (
                  <TableCell key={col.key} className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                    {col.key === "key" ? (
                      <span className="font-medium text-basalt-foreground">
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
                      <span className="text-basalt-muted-foreground">
                        {formatCellValue(entry, col.key)}
                      </span>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow>
                <TableCell colSpan={COLUMNS.length} className="px-3 py-8 text-center text-basalt-muted-foreground">
                  No data found for the selected time range
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </LayerCard>
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
    <Tabs
      value={activeTab}
      onValueChange={(value) => {
        setActiveTab(value as TabId);
        setSortCol("count");
        setSortOrder("desc");
      }}
      className="space-y-4"
    >
      <TabsList>
        {TABS.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id} className="gap-1.5">
            <tab.icon className="size-3.5" />
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={activeTab} className="space-y-4">
        <DistributionBar data={rawData} />
        <RankingTable
          data={sortedData}
          sortCol={sortCol}
          sortOrder={sortOrder}
          onSort={handleSort}
          onRowClick={handleRowClick}
        />
      </TabsContent>
    </Tabs>
  );
}
