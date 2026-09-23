"use client";

import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, Field, LayerCard } from "@nocoo/basalt";
import { Autocomplete } from "@nocoo/basalt/components/autocomplete";
import { Banner } from "@nocoo/basalt/components/banner";
import { InputArea } from "@nocoo/basalt/components/input-area";
import { Database, ListPlus, RefreshCw, Send } from "lucide-react";
import { SectionIcon } from "@/components/section-icon";
import { modelIds } from "@/lib/routing-model";
import type { ProviderPublic } from "@/lib/routing-types";
import type { RoutingFeedback } from "@/lib/routing-client";
import { NativeProtocolStatus } from "./native-protocol-status";
import { OperationFeedback } from "./operation-feedback";
import { Feedback } from "./routing-ui";

export function UpstreamCatalog({ upstream, manual, onManualChange, busy, dirty, refresh, test, testModel, onTestModelChange, refreshFeedback, testFeedback }: {
  upstream: ProviderPublic | null; manual: string; onManualChange: (value: string) => void;
  busy: string | null; dirty: boolean; refresh: () => void; test: () => void;
  testModel: string; onTestModelChange: (value: string) => void;
  refreshFeedback: RoutingFeedback | null; testFeedback: RoutingFeedback | null;
}) {
  const disabled = !upstream || dirty || busy !== null;
  return <div className="space-y-3">
    <LayerCard role="region" aria-label="Model catalog">
      <LayerCard.Header className="flex-wrap items-center gap-3">
        <div className="flex min-w-0 items-center gap-2.5"><SectionIcon icon={Database} tone="purple" /><h3 className="text-sm font-semibold text-basalt-foreground">Available models <span className="ml-1 font-normal tabular-nums text-basalt-muted-foreground">{upstream?.models.length ?? 0}</span></h3></div>
        <Button size="sm" variant="outline" className="shrink-0" disabled={disabled} loading={busy === "refresh"} onClick={refresh}><RefreshCw className="size-3.5" />Refresh models</Button>
      </LayerCard.Header>
      <LayerCard.Body className="space-y-3">
        <OperationFeedback feedback={refreshFeedback} inlineSuccess />
        {!refreshFeedback && upstream?.last_refresh_error && <Feedback error={`Last model refresh failed: ${upstream.last_refresh_error}. Cached models were retained. Refresh again to capture current response details.`} />}
        {(!upstream || dirty) && <Banner variant="secondary" size="sm" description={upstream ? "Save or discard changes before refreshing or testing this connection." : "Save this upstream to enable model discovery and testing. You can add manual IDs now."} />}
        <p className="text-xs text-basalt-muted-foreground">{upstream?.kind === "copilot" ? "Copilot updates hourly. You can also refresh now." : "Refresh from the provider, or enter model IDs manually."}</p>
        <LayerCard.Well className="max-h-64 overflow-y-auto rounded-widget p-2">
          {upstream?.models.length ? <ul aria-label="Fetched models" className="space-y-1">{upstream.models.map(model => <li key={model.id}><Collapsible>
            <CollapsibleTrigger className="w-full justify-between gap-3 rounded-md px-2 py-2 text-left text-sm" aria-label={`${model.id} protocol details`}><code className="break-all font-normal">{model.id}</code></CollapsibleTrigger>
            <CollapsibleContent unstyled><div className="px-2 pb-2 pt-1"><NativeProtocolStatus upstream={upstream} model={model.id} /></div></CollapsibleContent>
          </Collapsible></li>)}</ul> : <div className="flex items-start gap-2 px-2 py-3 text-sm text-basalt-muted-foreground"><Database className="mt-0.5 size-4 shrink-0" />No fetched models yet. Refresh the catalog or add manual IDs below.</div>}
        </LayerCard.Well>
        {upstream && <p className="text-xs text-basalt-muted-foreground">Last refresh: {upstream.last_refreshed_at ? new Date(upstream.last_refreshed_at).toLocaleString() : "Never"}</p>}
      </LayerCard.Body>
    </LayerCard>
    <Collapsible asChild defaultOpen={manual.length > 0}><LayerCard>
      <LayerCard.Header><h3 className="w-full"><CollapsibleTrigger className="w-full justify-between text-sm font-semibold"><span className="flex items-center gap-2.5"><SectionIcon icon={ListPlus} tone="teal" />Manual model IDs</span></CollapsibleTrigger></h3></LayerCard.Header>
      <CollapsibleContent unstyled><LayerCard.Body className="space-y-2">
        <InputArea id="manual-models" aria-label="Manual model IDs" aria-describedby="manual-models-hint" rows={3} size="sm" className="font-mono text-sm" value={manual} onChange={event => onManualChange(event.target.value)} placeholder="your-model-id" />
        <p id="manual-models-hint" className="text-xs text-basalt-muted-foreground">One ID per line or comma-separated. Refreshing keeps these IDs.</p>
      </LayerCard.Body></CollapsibleContent>
    </LayerCard></Collapsible>
    <LayerCard role="region" aria-label="Test connection">
      <LayerCard.Header><h3 className="flex items-center gap-2.5 text-sm font-semibold text-basalt-foreground"><SectionIcon icon={Send} tone="blue" />Test a model</h3></LayerCard.Header>
      <LayerCard.Body className="space-y-3">
      <p className="text-xs text-basalt-muted-foreground">Sends “ping. Reply with exactly pong.” using this connection. Uses your account’s quota.</p>
      <div className="flex flex-col gap-2 @min-[26rem]/editor:flex-row @min-[26rem]/editor:items-end">
        <Field label="Test model" htmlFor="upstream-test-model" className="min-w-0 flex-1"><Autocomplete id="upstream-test-model" aria-label="Test model" size="sm" items={modelIds(upstream ?? undefined).map(id => ({ label: id, value: id }))} value={testModel} onValueChange={onTestModelChange} placeholder="Select or type a model ID" /></Field>
        <Button size="sm" variant="outline" className="shrink-0" disabled={disabled || !testModel.trim() || testModel.trim() === "auto"} loading={busy === "test"} onClick={test}><Send className="size-3.5" />Send one test</Button>
      </div>
      <OperationFeedback feedback={testFeedback} inlineSuccess />
      {upstream?.kind === "copilot" && <p className="text-xs text-basalt-muted-foreground">Copilot needs a cached endpoint for the selected model. Refresh models if it is unavailable.</p>}
      </LayerCard.Body>
    </LayerCard>
  </div>;
}
