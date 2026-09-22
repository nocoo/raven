"use client";

import { Badge, Field, Input, LayerCard, Meter, Switch } from "@nocoo/basalt";
import { Activity, Gauge } from "lucide-react";
import { effectiveReset, type QuotaDraft } from "@/lib/upstream-model";
import { localDateTime, utcDateTime } from "@/lib/routing-schedule";
import type { ProviderPublic } from "@/lib/routing-types";
import { ScheduleEditor } from "./schedule-editor";
import { TimezoneNote, type EditorClock } from "./routing-ui";

function tokens(value: number): string { return value.toLocaleString(undefined, { maximumFractionDigits: 6 }); }

export function QuotaStatusView({ upstream }: { upstream: ProviderPublic }) {
  const status = upstream.quota_status;
  const limited = upstream.quota !== null;
  const exhausted = limited && status.remaining_tokens !== null && status.remaining_tokens <= 0;
  return <LayerCard.Well className="space-y-3 p-3">
    <div className="flex flex-wrap items-center gap-2"><Gauge className="size-4 text-basalt-primary" /><Badge variant={exhausted ? "warning" : limited ? "info" : "secondary"} className="text-xs">{exhausted ? "Exhausted" : limited ? "Soft limit" : "No limit"}</Badge>{!status.healthy && <Badge variant="destructive" className="ml-auto text-xs">Accounting blocked</Badge>}</div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
      <div><dt className="text-xs text-basalt-muted-foreground">Weighted use</dt><dd className="mt-0.5 font-mono text-sm tabular-nums">{tokens(status.used_tokens)} <span className="text-xs text-basalt-muted-foreground">tokens</span></dd></div>
      <div><dt className="text-xs text-basalt-muted-foreground">1× allowance</dt><dd className="mt-0.5 font-mono text-sm">{status.limit_tokens === null ? "Unlimited" : tokens(status.limit_tokens)}</dd></div>
      <div><dt className="text-xs text-basalt-muted-foreground">Remaining</dt><dd className="mt-0.5 font-mono text-sm">{status.remaining_tokens === null ? "—" : tokens(status.remaining_tokens)}</dd></div>
      <div><dt className="text-xs text-basalt-muted-foreground">Current multiplier</dt><dd className="mt-0.5 font-mono text-sm">{status.multiplier}×</dd></div>
    </dl>
    {status.limit_tokens !== null && <Meter aria-label="Shared quota consumed" hideValue value={Math.min(100, status.used_tokens / status.limit_tokens * 100)} />}
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-basalt-muted-foreground"><span>Next reset: {status.ends_at === null ? "Not scheduled" : new Date(status.ends_at).toLocaleString()}</span><span className={`flex items-center gap-1.5 ${status.usage_complete ? "" : "text-basalt-warning"}`}><Activity className="size-3.5" />{status.usage_complete ? "Usage complete" : "Usage incomplete · some tokens unreported"}</span></div>
    {!status.healthy && <p className="text-xs text-basalt-destructive">{limited ? "New requests stop until accounting recovers. Raven will not skip to another provider." : "Quota is disabled, so requests may proceed while accounting recovers."}</p>}
  </LayerCard.Well>;
}

export function QuotaEditor({ value, onChange, clock }: { value: QuotaDraft; onChange: (value: QuotaDraft) => void; clock: EditorClock }) {
  const reset = utcDateTime(value.reset, clock.offset);
  const duration = Number(value.window);
  const previewReset = Number.isFinite(reset) && duration > 0 ? effectiveReset(reset, duration, clock.now) : null;
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3"><div><label htmlFor="quota-enabled" className="text-sm font-medium">Enable shared token quota</label><p className="text-xs text-basalt-muted-foreground">One pool across every model, rule and client key using this upstream.</p></div><Switch id="quota-enabled" checked={value.enabled} onCheckedChange={enabled => onChange({ ...value, enabled })} /></div>
    {value.enabled ? <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="1× token allowance" htmlFor="quota-limit"><Input id="quota-limit" type="number" min="1" step="1" size="sm" value={value.limit} onChange={event => onChange({ ...value, limit: event.target.value })} /></Field>
        <Field label="Window (minutes)" htmlFor="quota-window"><Input id="quota-window" type="number" min="1" step="1" size="sm" value={value.window} onChange={event => onChange({ ...value, window: event.target.value })} /></Field>
        <Field label="Next reset (local time)" htmlFor="quota-reset"><Input id="quota-reset" type="datetime-local" size="sm" value={value.reset} onChange={event => onChange({ ...value, reset: event.target.value })} /></Field>
      </div>
      <LayerCard.Well className="space-y-1 py-3 text-xs text-basalt-muted-foreground"><p>Effective next reset: <span className="font-medium text-basalt-foreground">{previewReset === null ? "Choose a valid reset time" : localDateTime(previewReset, clock.offset).replace("T", " ")}</span></p><p>Limit and multiplier edits retain charged usage. A past reset advances to the current window. In-flight requests may exceed the soft limit.</p></LayerCard.Well>
      <div className="space-y-3"><h3 className="text-sm font-semibold">Consumption multipliers</h3><TimezoneNote clock={clock} />
        <ScheduleEditor mode={value.mode} windows={value.windows} offset={clock.offset} onChange={(mode, windows) => onChange({ ...value, mode, windows })} newValue={() => 1} summarize={multiplier => `${multiplier}×`}
          renderValue={(multiplier, change) => <Field label="Token multiplier" htmlFor="period-multiplier" hint="One reported token charges this many tokens against the shared allowance."><Input id="period-multiplier" size="sm" type="number" min="0.001" step="any" value={Number.isFinite(multiplier) ? multiplier : ""} onChange={event => change(Number(event.target.value))} className="max-w-44" /></Field>}
          emptyLabel="Tokens consume 1× allowance all day. Add periods for different multipliers; gaps always use 1×." />
      </div>
    </> : <p className="text-sm text-basalt-muted-foreground">No token limit is applied. Enable a quota to track an allowance and move to the next target when it is used up.</p>}
  </div>;
}
