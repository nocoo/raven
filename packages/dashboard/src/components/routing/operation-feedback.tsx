"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger, toast } from "@nocoo/basalt";
import { Banner } from "@nocoo/basalt/components/banner";
import { AlertCircle, Check, MessageSquare } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { CopyButton } from "@/components/copy-button";
import { errorMessage, RoutingRequestError, type RoutingFeedback } from "@/lib/routing-client";
import type { UpstreamOperationDetails } from "@/lib/routing-types";

function ResponseDetails({ details, error, open = false }: { details?: UpstreamOperationDetails | undefined; error?: RoutingRequestError | undefined; open?: boolean }) {
  if (!details && !error) return null;
  const request = error?.request;
  const body = details?.response_body ?? request?.response_body;
  const truncated = details?.response_body_truncated ?? request?.response_body_truncated;
  const entries = [
    ["Dashboard request", request && `${request.method} ${request.path}`],
    ["Proxy HTTP status", request?.status],
    ["Error type", error?.detail?.type],
    ["Upstream request", details?.url && `${details.method ?? ""} ${details.url}`.trim()],
    ["Upstream HTTP status", details?.upstream_status],
    ["Content type", details?.content_type ?? request?.content_type],
    ["Request ID", details?.request_id],
    ["Response status", details?.response_status],
    ["Finish reason", details?.finish_reason],
  ].filter(([, value]) => value !== undefined && value !== "");
  const copy = JSON.stringify({ ...(error ? { message: error.message, request, type: error.detail?.type, references: error.detail?.references } : {}), details }, null, 2);
  return <Collapsible defaultOpen={open} className="mt-2">
    <div className="flex items-center gap-2">
      <CollapsibleTrigger className="min-w-0 flex-1 py-1 text-xs">Response details</CollapsibleTrigger>
      <CopyButton value={copy} className="size-7 shrink-0" />
    </div>
    <CollapsibleContent unstyled>
      <div className="space-y-3 pt-2 text-basalt-foreground">
        <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">{entries.map(([label, value]) => <div key={label} className="contents"><dt className="text-basalt-muted-foreground">{label}</dt><dd className="min-w-0 break-words font-mono [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>
        {body !== undefined && <div className="space-y-1.5"><p className="text-xs font-medium">{details?.response_body !== undefined ? "Upstream response" : "Proxy response"}</p><section aria-label="Response body" className="max-h-64 overflow-y-auto rounded-widget bg-basalt-background/50 p-3"><pre className="whitespace-pre-wrap break-words font-mono text-xs [overflow-wrap:anywhere]">{body || "(empty response body)"}</pre></section>{truncated && <p className="text-xs text-basalt-muted-foreground">Response excerpt · remaining content omitted.</p>}</div>}
      </div>
    </CollapsibleContent>
  </Collapsible>;
}

export function OperationFeedback({ feedback }: { feedback: RoutingFeedback | null }) {
  const region = useRef<HTMLDivElement>(null);
  const toastId = useId();
  useEffect(() => {
    if (feedback?.kind === "success") toast.success(feedback.message, { id: toastId });
    else if (feedback) region.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
  }, [feedback, toastId]);
  if (!feedback || feedback.kind === "success") return null;
  if (feedback.kind === "error") {
    const error = feedback.cause instanceof RoutingRequestError ? feedback.cause : undefined;
    return <div ref={region}><Banner role="alert" variant="error" size="sm" icon={<AlertCircle />} title={feedback.title} description={<>
      <p className="break-words [overflow-wrap:anywhere]">{errorMessage(feedback.cause)}</p>
      {error?.detail?.details?.upstream_status !== undefined && <p className="mt-1 text-xs">Upstream HTTP {error.detail.details.upstream_status}</p>}
      <ResponseDetails error={error} details={error?.detail?.details} />
    </>} /></div>;
  }
  const result = feedback.result;
  const hasText = result.answer.trim().length > 0;
  return <div ref={region}><Banner role="status" variant={result.expected_pong ? "secondary" : "alert"} size="sm" icon={result.expected_pong ? <Check className="text-basalt-success" /> : <MessageSquare />} title={result.expected_pong ? "Received pong" : hasText ? "Request succeeded · unexpected answer" : "Request succeeded · no text returned"} description={<div className="space-y-2">
    <p className="text-xs">{result.latency_ms} ms · {result.protocol} · {result.model}</p>
    {hasText ? <div className="space-y-1"><p className="text-xs font-medium">Model reply</p><section aria-label="Model reply" className="max-h-48 overflow-y-auto rounded-widget bg-basalt-background/50 p-3"><pre className="whitespace-pre-wrap break-words font-mono text-sm text-basalt-foreground [overflow-wrap:anywhere]">{result.answer}</pre></section>{result.answer_truncated && <p className="text-xs">Reply excerpt · inspect the response details for more.</p>}</div> : <p className="text-sm">The provider returned no visible text. Inspect its response below for a finish reason or incomplete output.</p>}
    {!result.expected_pong && hasText && <p className="text-xs">Expected “pong”. The reply differs; this alone does not indicate a connection or authentication failure.</p>}
    <ResponseDetails details={result.details} open={!result.expected_pong} />
  </div>} /></div>;
}
