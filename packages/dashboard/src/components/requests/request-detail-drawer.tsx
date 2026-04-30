"use client";

import { Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import type { ExtendedRequestRecord } from "@/lib/types";
import { formatLatency } from "@/lib/chart-config";

interface RequestDetailDrawerProps {
  request: ExtendedRequestRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  });
}

function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {
      /* silently fail if clipboard permission denied */
    });
  }
}

function DetailRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex justify-between items-start gap-4 py-1.5 border-b border-border/30 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className={`text-xs text-right ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

export function RequestDetailDrawer({ request, open, onOpenChange }: RequestDetailDrawerProps) {
  if (!request) return null;

  const totalLatency = request.latency_ms;
  const safeLatency = Math.max(totalLatency, 1); // guard division by zero
  const ttft = request.ttft_ms;
  const processing = request.processing_ms;

  // Clamp TTFT + processing to not exceed 100%
  const ttftPct = ttft != null && ttft > 0 ? Math.min((ttft / safeLatency) * 100, 100) : 0;
  const procPct = processing != null && processing > 0 ? Math.min((processing / safeLatency) * 100, 100 - ttftPct) : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Badge variant={request.status === "success" ? "success" : "destructive"}>
              {request.status}
            </Badge>
            <span className="font-mono text-sm truncate">{request.model}</span>
          </SheetTitle>
          <SheetDescription>
            {formatTimestamp(request.timestamp)}
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-4 space-y-4">
          {/* Request ID */}
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground truncate flex-1">
              {request.id}
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => copyToClipboard(request.id)}
              aria-label="Copy request ID"
            >
              <Copy className="size-3" />
            </Button>
          </div>

          {/* Timing Breakdown */}
          <section>
            <h4 className="text-xs font-medium text-foreground mb-2">Timing</h4>
            <div className="space-y-1">
              {/* Visual waterfall bar */}
              <div className="h-6 flex rounded overflow-hidden bg-muted text-[10px]">
                {ttft != null && ttftPct > 0 && (
                  <div
                    className="bg-chart-2 flex items-center justify-center text-white"
                    style={{ width: `${ttftPct}%` }}
                    title={`TTFT: ${formatLatency(ttft)}`}
                  >
                    {ttftPct > 15 && "TTFT"}
                  </div>
                )}
                {processing != null && procPct > 0 && (
                  <div
                    className="bg-chart-3 flex items-center justify-center text-white"
                    style={{ width: `${procPct}%` }}
                    title={`Processing: ${formatLatency(processing)}`}
                  >
                    {procPct > 15 && "Proc"}
                  </div>
                )}
                <div
                  className="bg-chart-1 flex items-center justify-center text-white flex-1"
                  title={`Total: ${formatLatency(totalLatency)}`}
                >
                  {formatLatency(totalLatency)}
                </div>
              </div>
              <DetailRow label="Total Latency" value={formatLatency(totalLatency)} mono />
              {ttft != null && <DetailRow label="TTFT" value={formatLatency(ttft)} mono />}
              {processing != null && <DetailRow label="Processing" value={formatLatency(processing)} mono />}
            </div>
          </section>

          {/* Request Details */}
          <section>
            <h4 className="text-xs font-medium text-foreground mb-2">Request</h4>
            <DetailRow label="Path" value={request.path} mono />
            <DetailRow label="Model" value={request.model} mono />
            <DetailRow label="Resolved Model" value={request.resolved_model} mono />
            <DetailRow label="Translated Model" value={request.translated_model || null} mono />
            <DetailRow label="Format" value={request.client_format} />
            <DetailRow label="Stream" value={request.stream ? "Yes" : "No"} />
            <DetailRow label="Status Code" value={request.status_code} mono />
            <DetailRow label="Upstream Status" value={request.upstream_status} mono />
          </section>

          {/* Tokens */}
          <section>
            <h4 className="text-xs font-medium text-foreground mb-2">Tokens</h4>
            <DetailRow
              label="Input"
              value={request.input_tokens != null ? request.input_tokens.toLocaleString() : "—"}
              mono
            />
            <DetailRow
              label="Output"
              value={request.output_tokens != null ? request.output_tokens.toLocaleString() : "—"}
              mono
            />
            <DetailRow
              label="Total"
              value={
                request.input_tokens != null && request.output_tokens != null
                  ? (request.input_tokens + request.output_tokens).toLocaleString()
                  : "—"
              }
              mono
            />
          </section>

          {/* Routing */}
          <section>
            <h4 className="text-xs font-medium text-foreground mb-2">Routing</h4>
            <DetailRow label="Strategy" value={request.strategy || null} />
            <DetailRow label="Upstream" value={request.upstream || null} />
            <DetailRow label="Upstream Format" value={request.upstream_format || null} />
            <DetailRow label="Routing Path" value={request.routing_path || null} />
            <DetailRow label="Copilot Model" value={request.copilot_model || null} mono />
          </section>

          {/* Client Context */}
          <section>
            <h4 className="text-xs font-medium text-foreground mb-2">Client</h4>
            <DetailRow label="Account" value={request.account_name || null} />
            <DetailRow label="Client" value={request.client_name || null} />
            <DetailRow label="Version" value={request.client_version} />
            <DetailRow label="Session" value={request.session_id || null} mono />
          </section>

          {/* Response Metadata */}
          <section>
            <h4 className="text-xs font-medium text-foreground mb-2">Response</h4>
            <DetailRow label="Stop Reason" value={request.stop_reason || null} />
            <DetailRow
              label="Tool Calls"
              value={request.tool_call_count > 0 ? request.tool_call_count : null}
              mono
            />
            {request.error_message && (
              <div className="mt-2 p-2 rounded bg-destructive/10 border border-destructive/20">
                <p className="text-xs font-medium text-destructive mb-1">Error</p>
                <p className="text-xs text-destructive/80 font-mono whitespace-pre-wrap break-all">
                  {request.error_message}
                </p>
              </div>
            )}
          </section>

          {/* Link to live log */}
          <div className="pt-2">
            <Button variant="outline" size="sm" className="w-full" asChild>
              <a href={`/logs?requestId=${request.id}`}>
                <ExternalLink className="size-3 mr-1.5" />
                View in Live Logs
              </a>
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
