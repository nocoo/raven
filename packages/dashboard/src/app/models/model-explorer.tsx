"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCompact, formatLatency, formatPercent } from "@/lib/chart-config";
import type { BreakdownEntry } from "@/lib/types";

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
                className="border-b border-border/50 hover:bg-muted/30 transition-colors"
              >
                {COLUMNS.map((col) => (
                  <td
                    key={col.key}
                    className="px-3 py-2 whitespace-nowrap tabular-nums"
                  >
                    {col.key === "key" ? (
                      <span className="font-medium text-foreground">{entry.key || "(unknown)"}</span>
                    ) : col.key === "error_rate" ? (
                      <Badge
                        variant={entry.error_rate > 0.1 ? "destructive" : entry.error_rate > 0.05 ? "warning" : "secondary"}
                        className="text-[10px] px-1.5"
                      >
                        {formatCellValue(entry, col.key)}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">{formatCellValue(entry, col.key)}</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {data.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-muted-foreground">
                  No model data found for the selected time range
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
