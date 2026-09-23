"use client";




import { JsonBlock } from "@/components/ui/json-block";
import type { ExtendedRequestRecord } from "@/lib/types";
import { formatLatency } from "@/lib/chart-config";
import { Copy, Terminal, TriangleAlert, X } from "lucide-react";
import { Banner } from "@nocoo/basalt/components/banner";
import {
  Badge,
  Button,
  LayerCard,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@nocoo/basalt";
import { useLogDock } from "@/components/logs/log-dock-context";
import Link from "next/link";
import { DEFAULT_FILTERS, type AnalyticsFilters } from "@/lib/analytics-filters";
import { dimensionHref, keyIdentity, monitorHref, PROTOCOL_META, protocolLabel, requestProtocolRoute, requestTranslationWarning } from "@/lib/monitor";
import { LocalTime } from "@/components/local-time";

interface RequestDetailDrawerProps {
  request: ExtendedRequestRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters?: AnalyticsFilters;
}

function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {
      /* silently fail if clipboard permission denied */
    });
  }
}

function isJsonLike(value: string): boolean {
  const trimmed = value.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function DetailRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex justify-between items-start gap-4 py-1.5 border-b border-basalt-border/30 last:border-0">
      <span className="text-xs text-basalt-muted-foreground shrink-0">{label}</span>
      <span className={`min-w-0 break-words text-xs text-right ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

export function RequestDetailDrawer({ request, open, onOpenChange, filters = DEFAULT_FILTERS }: RequestDetailDrawerProps) {
  const { openLogs } = useLogDock();
  if (!request) return null;

  const totalLatency = request.latency_ms;
  const safeLatency = Math.max(totalLatency, 1); // guard division by zero
  const ttft = request.ttft_ms;
  const processing = request.processing_ms;
  const warning = requestTranslationWarning(request);

  // Clamp TTFT + processing to not exceed 100%
  const ttftPct = ttft != null && ttft > 0 ? Math.min((ttft / safeLatency) * 100, 100) : 0;
  const procPct = processing != null && processing > 0 ? Math.min((processing / safeLatency) * 100, 100 - ttftPct) : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetClose
          aria-label="Close"
          className="absolute top-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-lg text-basalt-muted-foreground hover:bg-basalt-accent hover:text-basalt-foreground"
        >
          <X className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
        </SheetClose>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 pr-8">
            <Badge variant={request.status === "success" ? "success" : "destructive"}>
              {request.status}
            </Badge>
            {" "}
            <span className="truncate font-mono text-sm">{request.model}</span>
          </SheetTitle>
          <SheetDescription>
            <LocalTime timestamp={request.timestamp} precision="millisecond" />
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-4 space-y-4">
          <LayerCard padding="sm" className="space-y-2">
            <div className="flex flex-wrap items-center gap-2"><Badge variant={request.protocol_mode === "native" ? "success" : request.protocol_mode === "translated" ? "warning" : "secondary"}>{protocolLabel(request.protocol_mode)}</Badge>{request.server_tools_used > 0 && <Badge variant="secondary">Server tools</Badge>}</div>
            {warning ? <Banner variant="alert" size="sm" icon={<TriangleAlert className="size-4" aria-hidden="true" />} {...warning} /> : <>
              <p className="text-sm font-medium">{requestProtocolRoute(request)}</p>
              <p className="text-xs leading-relaxed text-basalt-muted-foreground">{PROTOCOL_META[request.protocol_mode].description}</p>
            </>}
          </LayerCard>
          {request.routing && <section aria-label="Routing details" className="rounded-widget border border-basalt-border p-3">
            <div className="mb-2 flex items-center gap-2"><h4 className="text-sm font-medium">Routing</h4>{request.routing.diagnostic && <Badge variant="info" className="text-xs">Diagnostic · quota accounted</Badge>}</div>
            <DetailRow label="Chosen target" value={request.routing.upstream_name} />
            <DetailRow label="Upstream ID" value={request.routing.upstream_id} mono />
            <DetailRow label="Rule ID" value={request.routing.rule_id} mono />
            <DetailRow label="Period" value={request.routing.period_id ?? "Default chain"} mono />
            <DetailRow label="Requested model" value={request.routing.requested_model} mono />
            <DetailRow label="Resolved model" value={request.routing.resolved_model} mono />
            <DetailRow label="Quota window" value={request.routing.quota_window_id ?? "No quota"} mono />
            <DetailRow label="Multiplier" value={`${request.routing.multiplier}×`} mono />
            <DetailRow label="Weighted usage" value={`${request.routing.weighted_tokens.toLocaleString(undefined, { maximumFractionDigits: 6 })} tokens`} mono />
            <DetailRow label="Usage completeness" value={request.routing.usage_complete ? "Complete" : "Incomplete"} />
            <DetailRow label="Accounting" value={request.routing.accounting_healthy ? "Healthy" : "Blocked"} />
            <DetailRow label="Admitted at" value={<LocalTime timestamp={request.routing.admitted_at} precision="millisecond" />} mono />
            <DetailRow label="Skipped candidates" value={request.routing.skipped.map(skip => `${skip.upstream_id} · ${skip.reason}`).join("; ")} mono />
          </section>}
          {/* Request ID */}
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-basalt-muted-foreground truncate flex-1">
              {request.id}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copyToClipboard(request.id)}
              aria-label="Copy request ID"
            >
              <Copy className="size-3" />
            </Button>
          </div>

          {/* Timing Breakdown */}
          <section>
            <h4 className="text-xs font-medium text-basalt-foreground mb-2">Timing</h4>
            <div className="space-y-1">
              {/* Visual waterfall bar */}
              <div className="h-6 flex rounded overflow-hidden bg-basalt-muted text-xs">
                {ttft != null && ttftPct > 0 && (
                  <div
                    className="flex items-center justify-center bg-basalt-chart-2 text-white"
                    style={{ width: `${ttftPct}%` }}
                    title={`TTFT: ${formatLatency(ttft)}`}
                  >
                    {ttftPct > 15 && "TTFT"}
                  </div>
                )}
                {processing != null && procPct > 0 && (
                  <div
                    className="flex items-center justify-center bg-basalt-chart-3 text-white"
                    style={{ width: `${procPct}%` }}
                    title={`Processing: ${formatLatency(processing)}`}
                  >
                    {procPct > 15 && "Proc"}
                  </div>
                )}
                <div
                  className="flex flex-1 items-center justify-center bg-basalt-chart-1 text-white"
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
            <h4 className="text-xs font-medium text-basalt-foreground mb-2">Request</h4>
            <DetailRow label="Path" value={request.path} mono />
            <DetailRow label="Model" value={<Link className="text-basalt-primary underline underline-offset-2" href={dimensionHref("model", request.model, filters)}>Analyze {request.model}</Link>} mono />
            <DetailRow label="Resolved Model" value={request.routing?.resolved_model ?? request.resolved_model} mono />
            <DetailRow label="Translated Model" value={request.translated_model || null} mono />
            <DetailRow label="Format" value={request.client_format} />
            <DetailRow label="Stream" value={request.stream ? "Yes" : "No"} />
            <DetailRow label="Status Code" value={request.status_code} mono />
            <DetailRow label="Upstream Status" value={request.upstream_status} mono />
          </section>

          {/* Tokens */}
          <section>
            <h4 className="text-xs font-medium text-basalt-foreground mb-2">Tokens</h4>
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
            <DetailRow
              label="Cache Read"
              value={request.cache_read_tokens != null ? request.cache_read_tokens.toLocaleString() : "—"}
              mono
            />
            <DetailRow
              label="Cache Write"
              value={request.cache_write_tokens != null ? request.cache_write_tokens.toLocaleString() : "—"}
              mono
            />
          </section>

          {/* Routing */}
          <section>
            <h4 className="text-xs font-medium text-basalt-foreground mb-2">Routing</h4>
            <DetailRow label="Strategy" value={request.strategy || null} />
            <DetailRow label="Upstream" value={request.upstream || null} />
            <DetailRow label="Upstream Format" value={request.upstream_format || null} />
            <DetailRow label="Routing Path" value={request.routing_path || null} />
            <DetailRow label="Copilot Model" value={request.copilot_model || null} mono />
          </section>

          {/* Client Context */}
          <section>
            <h4 className="text-xs font-medium text-basalt-foreground mb-2">Client</h4>
            <DetailRow label="API Key" value={<Link className="text-basalt-primary underline underline-offset-2" href={dimensionHref("key_id", request.key_id, filters)}>{request.account_name || "Unattributed"}</Link>} />
            <DetailRow label="Key identity" value={keyIdentity(request.key_id)} mono />
            <DetailRow label="Client" value={request.client_name ? <Link className="text-basalt-primary underline underline-offset-2" href={dimensionHref("client", request.client_name, filters)}>{request.client_name}</Link> : null} />
            <DetailRow label="Version" value={request.client_version} />
            {request.session_id && (
              isJsonLike(request.session_id) ? (
                <div className="py-1.5">
                  <div className="text-xs text-basalt-muted-foreground mb-1">Session</div>
                  <JsonBlock value={request.session_id} />
                </div>
              ) : (
                <DetailRow label="Session" value={<Link className="text-basalt-primary underline underline-offset-2 break-all" href={monitorHref("/requests", filters, { session: request.session_id })}>{request.session_id}</Link>} mono />
              )
            )}
          </section>

          {/* Response Metadata */}
          <section>
            <h4 className="text-xs font-medium text-basalt-foreground mb-2">Response</h4>
            <DetailRow label="Stop Reason" value={request.stop_reason || null} />
            <DetailRow
              label="Tool Calls"
              value={request.tool_call_count > 0 ? request.tool_call_count : null}
              mono
            />
            {request.error_message && (
              <div className="mt-2 p-2 rounded bg-basalt-destructive/10 border border-basalt-destructive/20">
                <p className="text-xs font-medium text-basalt-destructive mb-1">Error</p>
                <p className="text-xs text-basalt-destructive/80 font-mono whitespace-pre-wrap break-all">
                  {request.error_message}
                </p>
              </div>
            )}
          </section>

          {/* Link to live log */}
          <div className="pt-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                onOpenChange(false);
                openLogs(request.id);
              }}
            >
              <Terminal className="size-3 mr-1.5" />
              View in Live Logs
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
