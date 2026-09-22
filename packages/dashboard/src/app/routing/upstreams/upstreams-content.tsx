"use client";

import { Badge, Button, ConfirmDialog, LayerCard, Tabs, TabsContent, TabsList, TabsTrigger, useConfirm } from "@nocoo/basalt";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { Globe, History, LockKeyhole, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Feedback, SaveBar, useEditorClock, useUnsavedChanges, type EditorClock } from "@/components/routing/routing-ui";
import { QuotaEditor, QuotaStatusView } from "@/components/routing/quota-editor";
import { UpstreamCatalog } from "@/components/routing/upstream-catalog";
import { UpstreamConnection } from "@/components/routing/upstream-connection";
import { useUpstreams } from "@/hooks/use-upstreams";
import { FORMATS } from "@/lib/routing-model";
import type { MigrationSummary, ProviderPublic } from "@/lib/routing-types";

export function UpstreamsContent({ upstreams, migration }: { upstreams: ProviderPublic[]; migration: MigrationSummary | null }) {
  const clock = useEditorClock();
  if (!clock) return <LayerCard.Loading label="Preparing upstream workbench" />;
  return <UpstreamsWorkbench upstreams={upstreams} migration={migration} clock={clock} />;
}

function UpstreamsWorkbench({ upstreams, migration, clock }: { upstreams: ProviderPublic[]; migration: MigrationSummary | null; clock: EditorClock }) {
  const state = useUpstreams(upstreams, clock.offset, clock.now);
  const { confirm, dialogProps } = useConfirm();
  useUnsavedChanges(state.dirty);
  const choose = async (upstream: ProviderPublic | null) => {
    if (state.dirty && !(await confirm({ title: "Discard unsaved changes?", description: "The current upstream has changes that have not been saved.", confirmLabel: "Discard changes", variant: "destructive" }))) return;
    state.load(upstream);
  };
  const remove = async () => {
    if (await confirm({ title: "Delete upstream?", description: `Delete ${state.active?.name}? Referenced upstreams must first be removed from all routing-rule chains.`, confirmLabel: "Delete upstream", variant: "destructive" })) await state.remove();
  };
  return <div className="space-y-4">
    <PageHeader title="Upstreams" description="Connections, model catalogs and a shared quota for every provider." actions={<Button size="sm" onClick={() => void choose(null)} disabled={state.busy !== null}><Plus className="size-4" />New upstream</Button>} />
    <div className="routing-workbench">
      <div className="routing-directory space-y-3">
        <LayerCard padding="sm" className="space-y-1"><div className="flex justify-between px-2 pb-2 text-xs text-basalt-muted-foreground"><span>CONNECTIONS</span><Badge variant="secondary" className="text-xs">{state.upstreams.length}</Badge></div>
          <nav aria-label="Upstreams" className="flex gap-1 overflow-x-auto min-[1100px]:flex-col">{state.upstreams.map(upstream => <Button key={upstream.id} variant={state.active?.id === upstream.id ? "secondary" : "ghost"} className="h-auto min-w-40 justify-start gap-2 px-3 py-2.5 text-left min-[1100px]:w-full min-[1100px]:min-w-0" aria-current={state.active?.id === upstream.id ? "true" : undefined} onClick={() => void choose(upstream)} disabled={state.busy !== null}>
            {upstream.kind === "copilot" ? <LockKeyhole className="size-4 shrink-0 text-basalt-primary" /> : <Globe className="size-4 shrink-0 text-basalt-primary" />}
            <span className="min-w-0 flex-1"><span className="block truncate text-sm">{upstream.name}</span><span className="mt-0.5 block text-xs font-normal text-basalt-muted-foreground">{upstream.kind === "copilot" ? "Built-in · protected" : FORMATS.find(format => format.value === upstream.format)?.short}</span></span><span className={`size-1.5 shrink-0 rounded-full ${upstream.is_enabled ? "bg-basalt-success" : "bg-basalt-muted-foreground"}`} aria-hidden="true" /><span className="sr-only">{upstream.is_enabled ? "Enabled" : "Disabled"}</span>
          </Button>)}</nav>
        </LayerCard>
        {migration && <LayerCard padding="sm"><details><summary className="flex cursor-pointer items-center gap-2 text-xs font-medium"><History className="size-3.5" />Migration summary</summary><div className="mt-3 space-y-3 text-xs text-basalt-muted-foreground"><p>{new Date(migration.migrated_at).toLocaleString()}</p><p>{migration.keys.length} existing keys bound to the Copilot rule. Secrets and IDs were preserved.</p>{migration.upstreams.map(upstream => <div key={upstream.id} className="space-y-1"><p className="font-medium text-basalt-foreground">{upstream.name}</p><p className="break-all">Retained IDs: {upstream.retained_models.join(", ") || "None"}</p><p className="break-all">Discarded patterns: {upstream.discarded_patterns.join(", ") || "None"}</p></div>)}<ul className="space-y-1">{migration.keys.map(key => <li key={key.id} className="break-all">{key.name} · {key.rule_id}</li>)}</ul></div></details></LayerCard>}
      </div>
      <fieldset className="min-w-0 space-y-4 routing-enter" key={state.active?.id ?? "new"} disabled={state.busy !== null}><legend className="sr-only">Upstream editor</legend>
        <LayerCard className="space-y-3">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">{state.active?.name ?? "New custom upstream"}</h2>{state.active?.kind === "copilot" ? <Badge variant="purple" className="text-xs">Protected</Badge> : state.active && <Badge variant={state.active.is_enabled ? "success" : "secondary"} className="text-xs">{state.active.is_enabled ? "Enabled" : "Disabled"}</Badge>}
            {state.active && <Button variant="ghost" size="sm" className="ml-auto" disabled={state.dirty || state.busy !== null} onClick={() => void state.reload()} loading={state.busy === "status"}><RefreshCw className="size-3.5" />Reload status</Button>}
            {state.active?.kind === "custom" && <Button variant="ghost" size="sm" onClick={remove} disabled={state.busy !== null} className="text-basalt-muted-foreground hover:text-basalt-destructive"><Trash2 className="size-3.5" />Delete</Button>}
          </div>
          <Feedback error={state.error} message={state.message} />
          <SaveBar dirty={state.dirty} saving={state.busy !== null} onSave={() => void state.save()} onDiscard={() => state.load(state.active)} />
        </LayerCard>
        {state.active && <QuotaStatusView upstream={state.active} />}
        <LayerCard>
          <Tabs defaultValue={state.active ? "models" : "connection"} className="min-w-0">
            <TabsList className="mb-4 flex w-full justify-start overflow-x-auto"><TabsTrigger value="connection">Connection</TabsTrigger><TabsTrigger value="models">Models & test</TabsTrigger><TabsTrigger value="quota">Shared quota</TabsTrigger></TabsList>
            <TabsContent value="connection"><UpstreamConnection upstream={state.active} value={state.draft} onChange={state.change} /></TabsContent>
            <TabsContent value="models"><UpstreamCatalog upstream={state.active} manual={state.draft.manual} onManualChange={manual => state.change({ ...state.draft, manual })} busy={state.busy} dirty={state.dirty} refresh={() => void state.refresh()} test={() => void state.test()} testModel={state.testModel} onTestModelChange={state.setTestModel} diagnostic={state.diagnostic} /></TabsContent>
            <TabsContent value="quota"><QuotaEditor value={state.draft.quota} onChange={quota => state.change({ ...state.draft, quota })} clock={clock} /></TabsContent>
          </Tabs>
        </LayerCard>
      </fieldset>
    </div>
    <ConfirmDialog {...dialogProps} />
  </div>;
}
