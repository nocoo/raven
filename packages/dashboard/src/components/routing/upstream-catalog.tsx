"use client";

import { Badge, Button, Field, LayerCard } from "@nocoo/basalt";
import { Autocomplete } from "@nocoo/basalt/components/autocomplete";
import { InputArea } from "@nocoo/basalt/components/input-area";
import { Database, RefreshCw, Send } from "lucide-react";
import { modelIds } from "@/lib/routing-model";
import type { ProviderPublic, UpstreamDiagnostic } from "@/lib/routing-types";

export function UpstreamCatalog({ upstream, manual, onManualChange, busy, dirty, refresh, test, testModel, onTestModelChange, diagnostic }: {
  upstream: ProviderPublic | null; manual: string; onManualChange: (value: string) => void;
  busy: string | null; dirty: boolean; refresh: () => void; test: () => void;
  testModel: string; onTestModelChange: (value: string) => void; diagnostic: UpstreamDiagnostic | null;
}) {
  const disabled = !upstream || dirty || busy !== null;
  return <div className="space-y-4">
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">Fetched catalog</h3><Badge variant="secondary" className="text-xs">{upstream?.models.length ?? 0}</Badge><Button size="sm" variant="outline" className="ml-auto" disabled={disabled} loading={busy === "refresh"} onClick={refresh}><RefreshCw className="size-3.5" />Refresh models</Button></div>
        <LayerCard.Well className="max-h-56 space-y-1 overflow-y-auto p-2">
          {upstream?.models.length ? <ul aria-label="Fetched models">{upstream.models.map(model => <li key={model.id} className="flex flex-wrap items-center justify-between gap-1 rounded-md px-2 py-1.5 text-xs"><code className="break-all">{model.id}</code>{Array.isArray(model.supported_endpoints) && <span className="text-basalt-muted-foreground">{model.supported_endpoints.filter(endpoint => typeof endpoint === "string").join(" · ")}</span>}</li>)}</ul> : <div className="flex items-start gap-2 px-1 py-3 text-sm text-basalt-muted-foreground"><Database className="mt-0.5 size-4 shrink-0" />No fetched models yet. Refresh explicitly, or add manual IDs.</div>}
        </LayerCard.Well>
        <div className="space-y-1 text-xs text-basalt-muted-foreground"><p>Last refresh: {upstream?.last_refreshed_at ? new Date(upstream.last_refreshed_at).toLocaleString() : "Never"}</p><p>{upstream?.kind === "copilot" ? "Copilot also refreshes hourly in the background." : "Custom catalogs refresh only when you choose Refresh models."}</p></div>
        {upstream?.last_refresh_error && <p role="alert" className="rounded-widget bg-basalt-warning/10 p-2 text-xs text-basalt-warning">Last refresh failed: {upstream.last_refresh_error}. The last good catalog is retained.</p>}
      </div>
      <Field label="Manual model IDs" htmlFor="manual-models" hint="One ID per line or comma-separated. Saved separately; refreshing never removes these IDs."><InputArea id="manual-models" rows={5} size="sm" className="font-mono text-xs" value={manual} onChange={event => onManualChange(event.target.value)} placeholder="your-model-id" /></Field>
    </div>
    <LayerCard.Well outlined className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2"><Send className="size-4 text-basalt-primary" /><h3 className="text-sm font-semibold">Test a model</h3><Badge variant="warning" className="text-xs">Counts toward quota</Badge></div>
      <p className="text-xs text-basalt-muted-foreground">Sends one small, non-streaming ping → pong request using this upstream's native protocol. No retries or fallback. Model IDs may be typed even when absent from the catalog.</p>
      {upstream?.kind === "copilot" && <p className="text-xs text-basalt-muted-foreground">Copilot tests require a cached generation endpoint for the chosen model. Refresh the catalog if this metadata is unavailable.</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label="Test model" htmlFor="upstream-test-model" className="min-w-0 flex-1"><Autocomplete id="upstream-test-model" aria-label="Test model" size="sm" items={modelIds(upstream ?? undefined).map(id => ({ label: id, value: id }))} value={testModel} onValueChange={onTestModelChange} placeholder="Select or type an explicit model ID" /></Field>
        <Button size="sm" variant="outline" disabled={disabled || !testModel.trim() || testModel.trim() === "auto"} loading={busy === "test"} onClick={test}><Send className="size-3.5" />Send one test</Button>
      </div>
      {dirty && <p className="text-xs text-basalt-warning">Save or discard changes before refreshing or testing the saved configuration.</p>}
      {diagnostic && <div role="status" className="space-y-2 rounded-widget bg-basalt-success/10 p-3">
        <div className="flex flex-wrap items-center gap-2"><Badge variant={diagnostic.expected_pong ? "success" : "warning"}>{diagnostic.expected_pong ? "Received pong" : "Generation succeeded · unexpected answer"}</Badge><span className="text-xs tabular-nums text-basalt-muted-foreground">{diagnostic.latency_ms} ms · {diagnostic.protocol} · {diagnostic.model}</span></div>
        <pre className="whitespace-pre-wrap break-all font-mono text-xs">{diagnostic.answer}</pre>
        {!diagnostic.expected_pong && <p className="text-xs text-basalt-muted-foreground">The request succeeded. An unexpected answer is separate from network or authentication health.</p>}
      </div>}
    </LayerCard.Well>
  </div>;
}
