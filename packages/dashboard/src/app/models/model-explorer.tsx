"use client";



import { formatCompact, formatLatency, formatPercent, cacheHitRate } from "@/lib/chart-config";
import type { BreakdownEntry } from "@/lib/types";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { Badge, Button, LayerCard } from "@nocoo/basalt";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nocoo/basalt/components/table";

interface ModelExplorerProps {
  data: BreakdownEntry[];
  currentSort: string;
  currentOrder: string;
}

const COLUMNS = [
  { key: "key", label: "Model", sortable: false },
  { key: "count", label: "Requests", sortable: true },
  { key: "total_tokens", label: "Total Tokens", sortable: true },
  { key: "input_tokens", label: "Input", sortable: true },
  { key: "output_tokens", label: "Output", sortable: true },
  // Derived value (read/(read+input)); not sortable — breakdown SQL has no
  // cache_hit column, and passing it as a sort would silently fall back to count.
  { key: "cache_hit", label: "Cache Hit", sortable: false },
  { key: "avg_latency_ms", label: "Avg Latency", sortable: true },
  { key: "p95_latency_ms", label: "P95 Latency", sortable: true },
  { key: "avg_ttft_ms", label: "Avg TTFT", sortable: true },
  { key: "error_rate", label: "Error Rate", sortable: true },
  { key: "last_seen", label: "Last Seen", sortable: true },
] as const;

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
    case "input_tokens":
      return formatCompact(entry.input_tokens);
    case "output_tokens":
      return formatCompact(entry.output_tokens);
    case "cache_hit": {
      const rate = cacheHitRate(entry.cache_read_tokens, entry.cache_write_tokens, entry.observed_input_tokens);
      return rate != null ? formatPercent(rate) : "—";
    }
    case "avg_latency_ms":
      return formatLatency(entry.avg_latency_ms);
    case "p95_latency_ms":
      return formatLatency(entry.p95_latency_ms);
    case "avg_ttft_ms":
      return entry.avg_ttft_ms != null ? formatLatency(entry.avg_ttft_ms) : "—";
    case "error_rate":
      return formatPercent(entry.error_rate);
    case "last_seen":
      return formatRelativeTime(entry.last_seen);
    default:
      return "";
  }
}

export function ModelExplorer({ data, currentSort, currentOrder }: ModelExplorerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const toggleSort = useCallback(
    (col: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (currentSort === col) {
        params.set("morder", currentOrder === "desc" ? "asc" : "desc");
      } else {
        params.set("msort", col);
        params.set("morder", "desc");
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [currentSort, currentOrder, searchParams, router, pathname],
  );

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
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((entry) => (
              <TableRow
                key={entry.key}
                className="border-b border-basalt-border/50 hover:bg-basalt-background/50 transition-colors"
              >
                {COLUMNS.map((col) => (
                  <TableCell
                    key={col.key}
                    className="px-3 py-2.5 whitespace-nowrap tabular-nums"
                  >
                    {col.key === "key" ? (
                      <span className="font-medium text-basalt-foreground">{entry.key || "(unknown)"}</span>
                    ) : col.key === "error_rate" ? (
                      <Badge
                        variant={entry.error_rate > 0.1 ? "destructive" : entry.error_rate > 0.05 ? "warning" : "secondary"}
                        className="text-[10px] px-1.5"
                      >
                        {formatCellValue(entry, col.key)}
                      </Badge>
                    ) : (
                      <span className="text-basalt-muted-foreground">{formatCellValue(entry, col.key)}</span>
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow>
                <TableCell colSpan={COLUMNS.length} className="px-3 py-8 text-center text-basalt-muted-foreground">
                  No model data found for the selected time range
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </LayerCard>
  );
}
