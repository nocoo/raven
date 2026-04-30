"use client";

import { useState, useCallback } from "react";
import { Activity, Clock, AlertTriangle, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { FilterBar } from "@/components/analytics/filter-bar";
import { RequestTable } from "@/components/requests/request-table";
import { RequestDetailDrawer } from "@/components/requests/request-detail-drawer";
import { ColumnConfig, getDefaultVisibleColumns } from "@/components/requests/column-config";
import { formatCompact, formatLatency, formatPercent } from "@/lib/chart-config";
import type { ExtendedRequestRecord, SummaryStats } from "@/lib/types";

interface RequestsContentProps {
  data: ExtendedRequestRecord[];
  hasMore: boolean;
  nextCursor?: string | undefined;
  total?: number | undefined;
  models: string[];
  summary: SummaryStats | null;
}

export function RequestsContent({
  data,
  hasMore,
  nextCursor,
  total,
  models,
  summary,
}: RequestsContentProps) {
  const [visibleColumns, setVisibleColumns] = useState(getDefaultVisibleColumns);
  const [selectedRequest, setSelectedRequest] = useState<ExtendedRequestRecord | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const toggleColumn = useCallback((key: string) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleRowClick = useCallback((req: ExtendedRequestRecord) => {
    setSelectedRequest(req);
    setDrawerOpen(true);
  }, []);

  return (
    <>
      {/* Filter bar */}
      <FilterBar models={models} />

      {/* Bulk analytics stats */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="flex items-center gap-2 rounded-lg border bg-secondary/50 px-3 py-2">
            <Activity className="size-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Requests</p>
              <p className="text-sm font-semibold tabular-nums">
                {formatCompact(summary.total_requests)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border bg-secondary/50 px-3 py-2">
            <AlertTriangle className="size-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Error Rate</p>
              <p className="text-sm font-semibold tabular-nums">
                <Badge
                  variant={summary.error_rate > 0.1 ? "destructive" : summary.error_rate > 0.05 ? "warning" : "secondary"}
                  className="text-[10px]"
                >
                  {formatPercent(summary.error_rate)}
                </Badge>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border bg-secondary/50 px-3 py-2">
            <Clock className="size-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Avg Latency</p>
              <p className="text-sm font-semibold tabular-nums">
                {formatLatency(summary.avg_latency_ms)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg border bg-secondary/50 px-3 py-2">
            <Zap className="size-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Total Tokens</p>
              <p className="text-sm font-semibold tabular-nums">
                {formatCompact(summary.total_tokens)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Table toolbar: count badge + column config */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Showing {data.length}
          {total !== undefined && ` of ${total.toLocaleString()}`} matching requests
        </p>
        <ColumnConfig visibleColumns={visibleColumns} onToggle={toggleColumn} />
      </div>

      {/* Request table */}
      <RequestTable
        data={data}
        hasMore={hasMore}
        nextCursor={nextCursor}
        total={total}
        visibleColumns={visibleColumns}
        onRowClick={handleRowClick}
      />

      {/* Detail drawer */}
      <RequestDetailDrawer
        request={selectedRequest}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
    </>
  );
}
