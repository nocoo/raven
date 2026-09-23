"use client";

import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger, ConfirmDialog, LayerCard, Tabs, TabsContent, TabsList, TabsTrigger, useConfirm } from "@nocoo/basalt";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { FilePlus2, Globe, History, LockKeyhole, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { SectionIcon } from "@/components/section-icon";
import { ConfigurationHeader, useEditorClock, useUnsavedChanges, type EditorClock } from "@/components/routing/routing-ui";
import { OperationFeedback } from "@/components/routing/operation-feedback";
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
  const [tab, setTab] = useState("connection");
  const { confirm, dialogProps } = useConfirm();
  useUnsavedChanges(state.dirty);
  const choose = async (upstream: ProviderPublic | null) => {
    if (state.active?.id === upstream?.id) return;
    if (state.dirty && !(await confirm({ title: "Discard unsaved changes?", description: "The current upstream has changes that have not been saved.", confirmLabel: "Discard changes", variant: "destructive" }))) return;
    state.load(upstream); setTab("connection");
  };
  const remove = async () => {
    if (await confirm({ title: "Delete upstream?", description: `Delete ${state.active?.name}? Referenced upstreams must first be removed from all routing-rule chains.`, confirmLabel: "Delete upstream", variant: "destructive" })) await state.remove();
  };
  return <div className="space-y-4">
    <PageHeader title="Upstreams" description="Provider connections, models and quotas." actions={<Button size="sm" onClick={() => void choose(null)} disabled={state.busy !== null || !state.active}><Plus className="size-4" />New upstream</Button>} />
    <div className="routing-workbench">
      <div className="routing-directory space-y-3">
        <LayerCard padding="sm" className="space-y-1">
          <div className="flex justify-between px-2 pb-2 text-xs text-basalt-muted-foreground"><span>UPSTREAMS</span><span className="tabular-nums">{state.upstreams.length + (state.active ? 0 : 1)}</span></div>
          <nav aria-label="Upstreams" className="routing-directory-list">
            {!state.active && <Button variant="secondary" className="routing-directory-item" aria-current="true" disabled={state.busy !== null}>
              <FilePlus2 className="size-4 shrink-0 text-basalt-primary" /><span className="min-w-0 flex-1 truncate">{state.draft.name.trim() || "Untitled upstream"}</span><Badge variant="warning" className="text-xs">Draft</Badge>
            </Button>}
            {state.upstreams.map(upstream => <Button key={upstream.id} variant={state.active?.id === upstream.id ? "secondary" : "ghost"} className="routing-directory-item" aria-current={state.active?.id === upstream.id ? "true" : undefined} onClick={() => void choose(upstream)} disabled={state.busy !== null}>
              <SectionIcon icon={upstream.kind === "copilot" ? LockKeyhole : Globe} tone={upstream.kind === "copilot" ? "teal" : "blue"} />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm">{state.active?.id === upstream.id ? state.draft.name.trim() || upstream.name : upstream.name}</span><span className="mt-0.5 block text-xs font-normal text-basalt-muted-foreground">{upstream.kind === "copilot" ? "Built-in · protected" : `${FORMATS.find(format => format.value === upstream.format)?.short}${upstream.is_enabled ? "" : " · disabled"}`}</span></span>
            </Button>)}
          </nav>
        </LayerCard>
        {migration && <Collapsible><CollapsibleTrigger className="gap-2 px-3 py-2 text-xs text-basalt-muted-foreground"><span className="flex items-center gap-2"><History className="size-3.5" />Migration summary</span></CollapsibleTrigger><CollapsibleContent><div className="space-y-3 text-xs text-basalt-muted-foreground"><p>{new Date(migration.migrated_at).toLocaleString()}</p><p>{migration.keys.length} existing keys bound to the Copilot rule. Secrets and IDs were preserved.</p>{migration.upstreams.map(upstream => <div key={upstream.id} className="space-y-1"><p className="font-medium text-basalt-foreground">{upstream.name}</p><p className="break-all">Retained IDs: {upstream.retained_models.join(", ") || "None"}</p><p className="break-all">Discarded patterns: {upstream.discarded_patterns.join(", ") || "None"}</p></div>)}<ul className="space-y-1">{migration.keys.map(key => <li key={key.id} className="break-all">{key.name} · {key.rule_id}</li>)}</ul></div></CollapsibleContent></Collapsible>}
      </div>
      <fieldset className="@container/editor min-w-0 routing-enter" key={state.active?.id ?? "new"} disabled={state.busy !== null}><legend className="sr-only">Upstream editor</legend>
        <section aria-label="Upstream configuration" className="min-w-0">
          <Tabs value={tab} onValueChange={setTab} className="min-w-0 space-y-3">
            <LayerCard className="space-y-3 [&>header]:pb-0">
              <ConfigurationHeader name={state.draft.name} label="Upstream name" placeholder="Name this upstream" onNameChange={state.active?.kind === "copilot" ? undefined : name => state.change({ ...state.draft, name })} isNew={!state.active} dirty={state.dirty} busy={state.busy !== null} saving={state.busy === "save"} onSave={() => void state.save()} onDiscard={state.discard}>
                {state.active?.kind === "custom" && <Button variant="ghost" size="icon" aria-label="Delete" title="Delete upstream" onClick={remove} disabled={state.busy !== null} className="size-8 text-basalt-muted-foreground hover:text-basalt-destructive"><Trash2 className="size-3.5" /></Button>}
              </ConfigurationHeader>
              <OperationFeedback feedback={state.feedback?.action === "save" || state.feedback?.action === "delete" ? state.feedback : null} inlineSuccess />
              <TabsList><TabsTrigger value="connection">Connection</TabsTrigger><TabsTrigger value="models">Models</TabsTrigger><TabsTrigger value="quota">Quota</TabsTrigger></TabsList>
            </LayerCard>
            <TabsContent value="connection"><UpstreamConnection upstream={state.active} value={state.draft} onChange={state.change} /></TabsContent>
            <TabsContent value="models"><UpstreamCatalog upstream={state.active} manual={state.draft.manual} onManualChange={manual => state.change({ ...state.draft, manual })} busy={state.busy} dirty={state.dirty} refresh={() => void state.refresh()} test={() => void state.test()} testModel={state.testModel} onTestModelChange={state.setTestModel} refreshFeedback={state.feedback?.action === "refresh" ? state.feedback : null} testFeedback={state.feedback?.action === "test" ? state.feedback : null} /></TabsContent>
            <TabsContent value="quota" className="space-y-3">
                <QuotaEditor value={state.draft.quota} onChange={quota => state.change({ ...state.draft, quota })} clock={clock} />
                {state.active && (state.active.quota || !state.active.quota_status.healthy) && <LayerCard role="region" aria-label="Saved quota status">
                  <LayerCard.Header className="flex-wrap items-center gap-3"><h3 className="text-sm font-semibold text-basalt-foreground">Current usage</h3><Button variant="outline" size="sm" disabled={state.dirty || state.busy !== null} onClick={() => void state.reload()} loading={state.busy === "status"}><RefreshCw className="size-3.5" />Reload status</Button></LayerCard.Header>
                  <LayerCard.Body className="space-y-3"><OperationFeedback feedback={state.feedback?.action === "status" ? state.feedback : null} inlineSuccess /><QuotaStatusView upstream={state.active} /></LayerCard.Body>
                </LayerCard>}
            </TabsContent>
          </Tabs>
        </section>
      </fieldset>
    </div>
    <ConfirmDialog {...dialogProps} />
  </div>;
}
