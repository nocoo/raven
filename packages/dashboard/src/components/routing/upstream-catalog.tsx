"use client";

import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Field, LayerCard } from "@nocoo/basalt";
import { Autocomplete } from "@nocoo/basalt/components/autocomplete";
import { Banner } from "@nocoo/basalt/components/banner";
import { InputArea } from "@nocoo/basalt/components/input-area";
import { Database, RefreshCw, Send } from "lucide-react";
import { SectionIcon } from "@/components/section-icon";
import { modelIds } from "@/lib/routing-model";
import type { ProviderPublic } from "@/lib/routing-types";
import { NativeProtocolStatus } from "./native-protocol-status";

export function UpstreamCatalog({ upstream, manual, onManualChange, busy, dirty, refresh, test, testModel, onTestModelChange }: {
  upstream: ProviderPublic | null; manual: string; onManualChange: (value: string) => void;
  busy: string | null; dirty: boolean; refresh: () => void; test: () => void;
  testModel: string; onTestModelChange: (value: string) => void;
}) {
  const disabled = !upstream || dirty || busy !== null;
  return <div className="space-y-5">
    {(!upstream || dirty) && <Banner variant="secondary" size="sm" description={upstream ? "Save or discard changes before refreshing or testing this connection." : "Save this upstream to enable model discovery and testing. You can add manual IDs now."} />}
    <LayerCard className="space-y-3" role="region" aria-label="Model catalog">
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2.5"><SectionIcon icon={Database} tone="purple" /><div><h3 className="text-sm font-semibold">Available models <span className="ml-1 font-normal tabular-nums text-basalt-muted-foreground">{upstream?.models.length ?? 0}</span></h3><p className="mt-0.5 text-xs text-basalt-muted-foreground">{upstream?.kind === "copilot" ? "Copilot updates hourly. You can also refresh now." : "Refresh from the provider, or enter model IDs manually."}</p></div></div><Button size="sm" variant="outline" disabled={disabled} loading={busy === "refresh"} onClick={refresh}><RefreshCw className="size-3.5" />Refresh models</Button></div>
      <LayerCard.Well className="max-h-48 space-y-1 overflow-y-auto rounded-widget p-2">
        {upstream?.models.length ? <ul aria-label="Fetched models">{upstream.models.map(model => <li key={model.id} className="rounded-md px-2 py-1.5 text-sm"><Collapsible>
          <CollapsibleTrigger className="w-full text-left text-sm" aria-label={`${model.id} protocol details`}><code className="break-all">{model.id}</code></CollapsibleTrigger>
          <CollapsibleContent unstyled><div className="py-2"><NativeProtocolStatus upstream={upstream} model={model.id} /></div></CollapsibleContent>
        </Collapsible></li>)}</ul> : <div className="flex items-start gap-2 px-1 py-3 text-sm text-basalt-muted-foreground"><Database className="mt-0.5 size-4 shrink-0" />No fetched models yet. Refresh the catalog or add manual IDs below.</div>}
      </LayerCard.Well>
      {upstream && <p className="text-xs text-basalt-muted-foreground">Last refresh: {upstream.last_refreshed_at ? new Date(upstream.last_refreshed_at).toLocaleString() : "Never"}</p>}
      <Collapsible defaultOpen={manual.length > 0}>
        <CollapsibleTrigger className="text-sm">Manual model IDs</CollapsibleTrigger>
        <CollapsibleContent unstyled><Field label="Manual model IDs" htmlFor="manual-models" hint="One ID per line or comma-separated. Refreshing keeps these IDs." className="pt-3"><InputArea id="manual-models" rows={3} size="sm" className="font-mono text-sm" value={manual} onChange={event => onManualChange(event.target.value)} placeholder="your-model-id" /></Field></CollapsibleContent>
      </Collapsible>
    </LayerCard>
    <LayerCard className="space-y-3" role="region" aria-label="Test connection">
      <div className="flex items-start gap-2.5"><SectionIcon icon={Send} tone="blue" /><div className="space-y-1"><h3 className="text-sm font-semibold">Test a model</h3><p className="text-xs text-basalt-muted-foreground">Sends “ping. Reply with exactly pong.” using this connection. Uses your account’s quota.</p></div></div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label="Test model" htmlFor="upstream-test-model" className="min-w-0 flex-1"><Autocomplete id="upstream-test-model" aria-label="Test model" size="sm" items={modelIds(upstream ?? undefined).map(id => ({ label: id, value: id }))} value={testModel} onValueChange={onTestModelChange} placeholder="Select or type a model ID" /></Field>
        <Button size="sm" variant="outline" disabled={disabled || !testModel.trim() || testModel.trim() === "auto"} loading={busy === "test"} onClick={test}><Send className="size-3.5" />Send one test</Button>
      </div>
      {upstream?.kind === "copilot" && <p className="text-xs text-basalt-muted-foreground">Copilot needs a cached endpoint for the selected model. Refresh models if it is unavailable.</p>}
    </LayerCard>
  </div>;
}
