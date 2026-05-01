"use client";

import { useState, useCallback } from "react";
import { Activity, Clock, AlertTriangle, Zap } from "lucide-react";
import { FilterBar } from "@/components/analytics/filter-bar";
import { RequestTable } from "@/components/requests/request-table";
import { RequestDetailDrawer } from "@/components/requests/request-detail-drawer";
import { ColumnConfig, getDefaultVisibleColumns } from "@/components/requests/column-config";
import { StatCard } from "@/components/stats/stat-card";
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
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4">
          <StatCard
            icon={Activity}
            label="Requests"
            value={formatCompact(summary.total_requests)}
          />
          <StatCard
            icon={AlertTriangle}
            label="Error Rate"
            value={formatPercent(summary.error_rate)}
            accent={
              summary.error_rate > 0.1
                ? "danger"
                : summary.error_rate > 0.05
                  ? "warning"
                  : "default"
            }
          />
          <StatCard
            icon={Clock}
            label="Avg Latency"
            value={formatLatency(summary.avg_latency_ms)}
          />
          <StatCard
            icon={Zap}
            label="Total Tokens"
            value={formatCompact(summary.total_tokens)}
          />
        </div>
      )}

      {/* Table toolbar: count badge + column config */}
      <div className="flex items-center justify-between">
        <p className="text-meta">
          Showing {data.length}
          {total != null && ` of ${total.toLocaleString()}`} matching requests
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
