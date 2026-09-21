"use client";

import { useState, useCallback } from "react";
import { RequestTable } from "@/components/requests/request-table";
import { RequestDetailDrawer } from "@/components/requests/request-detail-drawer";
import { ColumnConfig, getDefaultVisibleColumns } from "@/components/requests/column-config";
import type { ExtendedRequestRecord, SummaryStats } from "@/lib/types";
import { useSearchParams } from "next/navigation";
import { searchParamsToFilters } from "@/lib/analytics-filters";
import { MonitorSummary } from "@/components/analytics/panels/monitor-panels";

interface RequestsContentProps {
  data: ExtendedRequestRecord[];
  hasMore: boolean;
  nextCursor?: string | undefined;
  total?: number | undefined;
  summary: SummaryStats | null;
}

export function RequestsContent({
  data,
  hasMore,
  nextCursor,
  total,
  summary,
}: RequestsContentProps) {
  const filters = searchParamsToFilters(useSearchParams());
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
      {/* Bulk analytics stats */}
      {summary && <MonitorSummary summary={summary} percentiles={null} filters={filters} />}

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
        filters={filters}
      />
    </>
  );
}
