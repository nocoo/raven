"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RequestRecord } from "@/lib/types";

interface RequestTableProps {
  data: RequestRecord[];
  hasMore: boolean;
  nextCursor?: string | undefined;
  total?: number | undefined;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatTokens(input: number | null, output: number | null): string {
  const i = input ?? 0;
  const o = output ?? 0;
  return `${i.toLocaleString()} / ${o.toLocaleString()}`;
}

type SortColumn = "timestamp" | "latency_ms" | "total_tokens";

export function RequestTable({ data, hasMore, nextCursor, total }: RequestTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const currentSort = (searchParams.get("sort") ?? "timestamp") as SortColumn;
  const currentOrder = searchParams.get("order") ?? "desc";

  const toggleSort = useCallback(
    (column: SortColumn) => {
      const params = new URLSearchParams(searchParams.toString());
      if (currentSort === column) {
        params.set("order", currentOrder === "desc" ? "asc" : "desc");
      } else {
        params.set("sort", column);
        params.set("order", "desc");
      }
      params.delete("cursor");
      params.delete("offset");
      params.delete("prevCursors");
      router.push(`/?${params.toString()}`);
    },
    [router, searchParams, currentSort, currentOrder],
  );

  const goNextPage = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (currentSort === "timestamp" && nextCursor) {
      // Push current cursor onto history stack for backward navigation
      const currentCursor = params.get("cursor") ?? "";
      const prevCursors = params.get("prevCursors") ?? "";
      const newPrev = prevCursors ? `${prevCursors},${currentCursor}` : currentCursor;
      params.set("prevCursors", newPrev);
      params.set("cursor", nextCursor);
    } else {
      const currentOffset = parseInt(params.get("offset") ?? "0", 10);
      const limit = parseInt(params.get("limit") ?? "50", 10);
      params.set("offset", String(currentOffset + limit));
    }
    router.push(`/?${params.toString()}`);
  }, [router, searchParams, currentSort, nextCursor]);

  const goPrevPage = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (currentSort === "timestamp") {
      // Pop cursor from history stack
      const prevCursors = params.get("prevCursors") ?? "";
      const stack = prevCursors.split(",").filter(Boolean);
      const prevCursor = stack.pop();
      if (stack.length > 0) {
        params.set("prevCursors", stack.join(","));
      } else {
        params.delete("prevCursors");
      }
      if (prevCursor) {
        params.set("cursor", prevCursor);
      } else {
        params.delete("cursor");
      }
    } else {
      const currentOffset = parseInt(params.get("offset") ?? "0", 10);
      const limit = parseInt(params.get("limit") ?? "50", 10);
      const newOffset = Math.max(0, currentOffset - limit);
      if (newOffset === 0) {
        params.delete("offset");
      } else {
        params.set("offset", String(newOffset));
      }
      params.delete("cursor");
    }
    router.push(`/?${params.toString()}`);
  }, [router, searchParams, currentSort]);

  const canGoPrev = currentSort === "timestamp"
    ? searchParams.has("cursor")
    : parseInt(searchParams.get("offset") ?? "0", 10) > 0;

  function SortButton({ column, children }: { column: SortColumn; children: React.ReactNode }) {
    const isActive = currentSort === column;
    return (
      <button
        onClick={() => toggleSort(column)}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
      >
        {children}
        <ArrowUpDown className={`h-3 w-3 ${isActive ? "text-foreground" : "text-muted-foreground"}`} />
      </button>
    );
  }

  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <SortButton column="timestamp">Time</SortButton>
            </TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Format</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>
              <SortButton column="latency_ms">Latency</SortButton>
            </TableHead>
            <TableHead>
              <SortButton column="total_tokens">Tokens (in/out)</SortButton>
            </TableHead>
            <TableHead>Stream</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                No requests found
              </TableCell>
            </TableRow>
          ) : (
            data.map((req) => (
              <TableRow key={req.id}>
                <TableCell className="text-muted-foreground text-xs">
                  {formatTimestamp(req.timestamp)}
                </TableCell>
                <TableCell className="font-mono text-xs">{req.model}</TableCell>
                <TableCell>
                  <Badge variant="secondary" className="text-[10px]">
                    {req.client_format}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={req.status === "success" ? "success" : "destructive"} className="text-[10px]">
                    {req.status}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {formatLatency(req.latency_ms)}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {formatTokens(req.input_tokens, req.output_tokens)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {req.stream ? "yes" : "no"}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4">
        <p className="text-sm text-muted-foreground">
          {total !== undefined ? `${total.toLocaleString()} total` : `${data.length} shown`}
        </p>
        <div className="flex items-center gap-2">
          {canGoPrev && (
            <Button variant="outline" size="sm" onClick={goPrevPage}>
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
          )}
          {hasMore && (
            <Button variant="outline" size="sm" onClick={goNextPage}>
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
