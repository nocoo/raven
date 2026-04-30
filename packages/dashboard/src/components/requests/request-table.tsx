"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
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
import { formatLatency } from "@/lib/chart-config";
import type { ExtendedRequestRecord } from "@/lib/types";

interface RequestTableProps {
  data: ExtendedRequestRecord[];
  hasMore: boolean;
  nextCursor?: string | undefined;
  total?: number | undefined;
  visibleColumns?: Set<string>;
  onRowClick?: (req: ExtendedRequestRecord) => void;
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

function formatTokens(input: number | null, output: number | null): string {
  const i = input ?? 0;
  const o = output ?? 0;
  return `${i.toLocaleString()} / ${o.toLocaleString()}`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

type SortColumn = "timestamp" | "latency_ms" | "total_tokens" | "ttft_ms" | "processing_ms";

const DEFAULT_VISIBLE = new Set([
  "timestamp", "model", "status", "latency_ms", "ttft_ms", "tokens", "stream", "path",
]);

export function RequestTable({
  data,
  hasMore,
  nextCursor,
  total,
  visibleColumns = DEFAULT_VISIBLE,
  onRowClick,
}: RequestTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentSort = (searchParams.get("sort") ?? "timestamp") as SortColumn;
  const currentOrder = searchParams.get("order") ?? "desc";

  const pushUrl = useCallback(
    (params: URLSearchParams) => {
      const qs = params.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname],
  );

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
      pushUrl(params);
    },
    [searchParams, currentSort, currentOrder, pushUrl],
  );

  const goNextPage = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (currentSort === "timestamp" && nextCursor) {
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
    pushUrl(params);
  }, [searchParams, currentSort, nextCursor, pushUrl]);

  const goPrevPage = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (currentSort === "timestamp") {
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
    pushUrl(params);
  }, [searchParams, currentSort, pushUrl]);

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

  function getAriaSort(column: SortColumn): "ascending" | "descending" | "none" {
    if (currentSort !== column) return "none";
    return currentOrder === "asc" ? "ascending" : "descending";
  }

  const isVisible = (key: string) => visibleColumns.has(key);

  return (
    <div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {isVisible("timestamp") && (
                <TableHead aria-sort={getAriaSort("timestamp")}>
                  <SortButton column="timestamp">Time</SortButton>
                </TableHead>
              )}
              {isVisible("model") && <TableHead>Model</TableHead>}
              {isVisible("path") && <TableHead>Path</TableHead>}
              {isVisible("client_format") && <TableHead>Format</TableHead>}
              {isVisible("status") && <TableHead>Status</TableHead>}
              {isVisible("latency_ms") && (
                <TableHead aria-sort={getAriaSort("latency_ms")}>
                  <SortButton column="latency_ms">Latency</SortButton>
                </TableHead>
              )}
              {isVisible("ttft_ms") && (
                <TableHead aria-sort={getAriaSort("ttft_ms")}>
                  <SortButton column="ttft_ms">TTFT</SortButton>
                </TableHead>
              )}
              {isVisible("processing_ms") && (
                <TableHead aria-sort={getAriaSort("processing_ms")}>
                  <SortButton column="processing_ms">Processing</SortButton>
                </TableHead>
              )}
              {isVisible("tokens") && (
                <TableHead aria-sort={getAriaSort("total_tokens")}>
                  <SortButton column="total_tokens">Tokens (in/out)</SortButton>
                </TableHead>
              )}
              {isVisible("stream") && <TableHead>Stream</TableHead>}
              {isVisible("strategy") && <TableHead>Strategy</TableHead>}
              {isVisible("upstream") && <TableHead>Upstream</TableHead>}
              {isVisible("account_name") && <TableHead>Account</TableHead>}
              {isVisible("client_name") && <TableHead>Client</TableHead>}
              {isVisible("session_id") && <TableHead>Session</TableHead>}
              {isVisible("status_code") && <TableHead>Code</TableHead>}
              {isVisible("stop_reason") && <TableHead>Stop Reason</TableHead>}
              {isVisible("tool_call_count") && <TableHead>Tools</TableHead>}
              {isVisible("routing_path") && <TableHead>Routing</TableHead>}
              {isVisible("translated_model") && <TableHead>Translated</TableHead>}
              {isVisible("error_message") && <TableHead>Error</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={visibleColumns.size}
                  className="text-center text-muted-foreground py-8"
                >
                  No requests found
                </TableCell>
              </TableRow>
            ) : (
              data.map((req) => (
                <TableRow
                  key={req.id}
                  className={onRowClick ? "cursor-pointer" : ""}
                  onClick={() => onRowClick?.(req)}
                >
                  {isVisible("timestamp") && (
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {formatTimestamp(req.timestamp)}
                    </TableCell>
                  )}
                  {isVisible("model") && (
                    <TableCell className="font-mono text-xs max-w-[160px] truncate">
                      {req.model}
                    </TableCell>
                  )}
                  {isVisible("path") && (
                    <TableCell className="font-mono text-xs text-muted-foreground max-w-[120px] truncate">
                      {truncate(req.path, 24)}
                    </TableCell>
                  )}
                  {isVisible("client_format") && (
                    <TableCell>
                      <Badge variant="secondary" className="text-[10px]">
                        {req.client_format}
                      </Badge>
                    </TableCell>
                  )}
                  {isVisible("status") && (
                    <TableCell>
                      <Badge
                        variant={req.status === "success" ? "success" : "destructive"}
                        className="text-[10px]"
                      >
                        {req.status}
                      </Badge>
                    </TableCell>
                  )}
                  {isVisible("latency_ms") && (
                    <TableCell className="font-mono text-xs">
                      {formatLatency(req.latency_ms)}
                    </TableCell>
                  )}
                  {isVisible("ttft_ms") && (
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {req.ttft_ms != null ? formatLatency(req.ttft_ms) : "—"}
                    </TableCell>
                  )}
                  {isVisible("processing_ms") && (
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {req.processing_ms != null ? formatLatency(req.processing_ms) : "—"}
                    </TableCell>
                  )}
                  {isVisible("tokens") && (
                    <TableCell className="font-mono text-xs">
                      {formatTokens(req.input_tokens, req.output_tokens)}
                    </TableCell>
                  )}
                  {isVisible("stream") && (
                    <TableCell className="text-xs text-muted-foreground">
                      {req.stream ? "yes" : "no"}
                    </TableCell>
                  )}
                  {isVisible("strategy") && (
                    <TableCell className="text-xs">{req.strategy || "—"}</TableCell>
                  )}
                  {isVisible("upstream") && (
                    <TableCell className="text-xs">{req.upstream || "—"}</TableCell>
                  )}
                  {isVisible("account_name") && (
                    <TableCell className="text-xs">{req.account_name || "—"}</TableCell>
                  )}
                  {isVisible("client_name") && (
                    <TableCell className="text-xs">{req.client_name || "—"}</TableCell>
                  )}
                  {isVisible("session_id") && (
                    <TableCell className="font-mono text-xs max-w-[100px] truncate">
                      {req.session_id ? truncate(req.session_id, 12) : "—"}
                    </TableCell>
                  )}
                  {isVisible("status_code") && (
                    <TableCell className="font-mono text-xs">{req.status_code}</TableCell>
                  )}
                  {isVisible("stop_reason") && (
                    <TableCell className="text-xs">{req.stop_reason || "—"}</TableCell>
                  )}
                  {isVisible("tool_call_count") && (
                    <TableCell className="font-mono text-xs">
                      {req.tool_call_count > 0 ? req.tool_call_count : "—"}
                    </TableCell>
                  )}
                  {isVisible("routing_path") && (
                    <TableCell className="text-xs">{req.routing_path || "—"}</TableCell>
                  )}
                  {isVisible("translated_model") && (
                    <TableCell className="font-mono text-xs max-w-[120px] truncate">
                      {req.translated_model || "—"}
                    </TableCell>
                  )}
                  {isVisible("error_message") && (
                    <TableCell className="text-xs text-destructive max-w-[150px] truncate">
                      {req.error_message || "—"}
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4">
        <p className="text-sm text-muted-foreground">
          {total != null ? `${total.toLocaleString()} total` : `${data.length} shown`}
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
