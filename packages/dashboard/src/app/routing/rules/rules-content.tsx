"use client";

import { Badge, Button, ConfirmDialog, LayerCard, Switch, Tabs, TabsContent, TabsList, TabsTrigger, useConfirm } from "@nocoo/basalt";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { ArrowLeftRight, CalendarClock, FilePlus2, GitBranch, LockKeyhole, Plus, Trash2 } from "lucide-react";
import { SectionIcon } from "@/components/section-icon";
import { useState } from "react";
import { ChainEditor } from "@/components/routing/chain-editor";
import { ScheduleEditor } from "@/components/routing/schedule-editor";
import { ConfigurationHeader, TimezoneNote, useEditorClock, useUnsavedChanges, type EditorClock } from "@/components/routing/routing-ui";
import { OperationFeedback } from "@/components/routing/operation-feedback";
import { useRoutingRules } from "@/hooks/use-routing-rules";
import type { ProviderPublic, RoutingRule } from "@/lib/routing-types";

export function RulesContent({ rules, upstreams }: { rules: RoutingRule[]; upstreams: ProviderPublic[] }) {
  const clock = useEditorClock();
  if (!clock) return <LayerCard.Loading label="Preparing local routing timetable" />;
  return <RulesWorkbench rules={rules} upstreams={upstreams} clock={clock} />;
}

function RulesWorkbench({ rules, upstreams, clock }: { rules: RoutingRule[]; upstreams: ProviderPublic[]; clock: EditorClock }) {
  const state = useRoutingRules(rules, upstreams, clock.offset);
  const [tab, setTab] = useState("targets");
  const { confirm, dialogProps } = useConfirm();
  useUnsavedChanges(state.dirty);
  const choose = async (rule: RoutingRule | null) => {
    if (state.active?.id === rule?.id) return;
    if (state.dirty && !(await confirm({ title: "Discard unsaved changes?", description: "The current rule has changes that have not been saved.", confirmLabel: "Discard changes", variant: "destructive" }))) return;
    state.load(rule); setTab("targets");
  };
  const remove = async () => {
    if (await confirm({ title: "Delete routing rule?", description: `Delete ${state.active?.name}? A rule bound to client keys cannot be deleted. Rebind those keys in Connect first.`, confirmLabel: "Delete rule", variant: "destructive" })) await state.remove();
  };
  return <div className="space-y-4">
    <PageHeader title="Routing Rules" description="Upstreams and models for your client keys." actions={<Button size="sm" onClick={() => void choose(null)} disabled={state.busy || !state.active}><Plus className="size-4" />New rule</Button>} />
    <div className="routing-workbench">
      <LayerCard padding="sm" className="routing-directory space-y-1">
        <div className="flex items-center justify-between px-2 pb-2 text-xs text-basalt-muted-foreground"><span>YOUR RULES</span><span className="tabular-nums">{state.rules.length + (state.active ? 0 : 1)}</span></div>
        <nav aria-label="Routing rules" className="routing-directory-list">
          {!state.active && <Button variant="secondary" className="routing-directory-item" aria-current="true" disabled={state.busy}>
            <FilePlus2 className="size-4 shrink-0 text-basalt-primary" /><span className="min-w-0 flex-1 truncate">{state.draft.name.trim() || "Untitled rule"}</span><Badge variant="warning" className="text-xs">Draft</Badge>
          </Button>}
          {state.rules.map(rule => <Button key={rule.id} variant={state.active?.id === rule.id ? "secondary" : "ghost"} className="routing-directory-item" aria-current={state.active?.id === rule.id ? "true" : undefined} onClick={() => void choose(rule)} disabled={state.busy}>
            <SectionIcon icon={GitBranch} tone="purple" /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{state.active?.id === rule.id ? state.draft.name.trim() || rule.name : rule.name}</span><span className="mt-0.5 block text-xs font-normal text-basalt-muted-foreground">{rule.mode === "all_day" ? "All day" : rule.mode === "daily" ? "Daily timetable" : "Weekly timetable"}</span></span>{rule.is_builtin && <LockKeyhole aria-label="Built-in · protected" className="size-3.5 shrink-0 text-basalt-muted-foreground" />}
          </Button>)}
        </nav>
        <p className="px-2 pt-3 text-xs text-basalt-muted-foreground">Assign keys in <a href="/connect" className="text-basalt-primary underline underline-offset-2">Connect</a>.</p>
      </LayerCard>
      <fieldset className="@container/editor min-w-0 routing-enter" key={state.active?.id ?? "new"} disabled={state.busy}><legend className="sr-only">Rule editor</legend>
        <section aria-label="Rule configuration" className="min-w-0">
          <ConfigurationHeader name={state.draft.name} label="Rule name" placeholder="Name this rule" onNameChange={name => state.change({ ...state.draft, name })} isNew={!state.active} dirty={state.dirty} busy={state.busy} saving={state.busy} onSave={() => void state.save()} onDiscard={state.discard}>
            {state.active && !state.active.is_builtin && <Button size="icon" variant="ghost" aria-label="Delete" title="Delete rule" className="size-8 text-basalt-muted-foreground hover:text-basalt-destructive" onClick={remove} disabled={state.busy}><Trash2 className="size-3.5" /></Button>}
          </ConfigurationHeader>
          <div className="space-y-3">
            <OperationFeedback feedback={state.feedback} />
            <Tabs value={tab} onValueChange={setTab} className="min-w-0">
              <TabsList className="mb-4"><TabsTrigger value="targets">Targets</TabsTrigger><TabsTrigger value="schedule">Schedule</TabsTrigger><TabsTrigger value="protocol">Protocol</TabsTrigger></TabsList>
              <TabsContent value="targets" className="space-y-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><h3 className="flex items-center gap-2.5 text-sm font-semibold"><SectionIcon icon={GitBranch} tone="purple" />Default chain</h3><p className="text-xs text-basalt-muted-foreground">{state.draft.mode === "all_day" ? "Used all day" : "Used outside scheduled periods"}</p></div>
                <ChainEditor label="Default chain" value={state.draft.default_chain} upstreams={upstreams} conversion={state.draft.allow_conversion} onChange={default_chain => state.change({ ...state.draft, default_chain })} />
              </TabsContent>
              <TabsContent value="schedule" className="space-y-4">
                <h3 className="flex items-center gap-2.5 text-sm font-semibold"><SectionIcon icon={CalendarClock} tone="orange" />Time-period overrides</h3>
                {state.draft.mode !== "all_day" && <TimezoneNote clock={clock} />}
                <ScheduleEditor mode={state.draft.mode} windows={state.draft.windows} offset={clock.offset}
                  onChange={(mode, windows) => state.change({ ...state.draft, mode, windows })}
                  newValue={() => structuredClone(state.draft.default_chain)} summarize={targets => `${targets.length} target${targets.length === 1 ? "" : "s"}`}
                  renderValue={(targets, onChange) => <ChainEditor label="Period chain" value={targets} upstreams={upstreams} conversion={state.draft.allow_conversion} onChange={onChange} />}
                  emptyLabel="The default chain applies all day. Choose Every day or Weekly to add time periods." />
              </TabsContent>
              <TabsContent value="protocol" className="space-y-4">
                <LayerCard><LayerCard.Header className="items-center gap-3"><h3 className="flex items-center gap-2.5 text-sm font-semibold text-basalt-foreground"><SectionIcon icon={ArrowLeftRight} tone="blue" /><label htmlFor="allow-conversion">Allow protocol conversion</label></h3><Switch id="allow-conversion" checked={state.draft.allow_conversion} onCheckedChange={allow_conversion => state.change({ ...state.draft, allow_conversion })} /></LayerCard.Header><LayerCard.Body><p className="max-w-prose text-sm text-basalt-muted-foreground">For clients using a different API format from the upstream. Applies to every chain in this rule.</p></LayerCard.Body></LayerCard>
              </TabsContent>
            </Tabs>
          </div>
        </section>
      </fieldset>
    </div>
    <ConfirmDialog {...dialogProps} />
  </div>;
}
