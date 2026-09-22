"use client";

import { Badge, Button, ConfirmDialog, Field, Input, LayerCard, Switch, useConfirm } from "@nocoo/basalt";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { ArrowRight, GitBranch, LockKeyhole, Plus, Trash2 } from "lucide-react";
import { ChainEditor } from "@/components/routing/chain-editor";
import { ScheduleEditor } from "@/components/routing/schedule-editor";
import { Feedback, SaveBar, TimezoneNote, useEditorClock, useUnsavedChanges, type EditorClock } from "@/components/routing/routing-ui";
import { useRoutingRules } from "@/hooks/use-routing-rules";
import type { ProviderPublic, RoutingRule } from "@/lib/routing-types";

export function RulesContent({ rules, upstreams }: { rules: RoutingRule[]; upstreams: ProviderPublic[] }) {
  const clock = useEditorClock();
  if (!clock) return <LayerCard.Loading label="Preparing local routing timetable" />;
  return <RulesWorkbench rules={rules} upstreams={upstreams} clock={clock} />;
}

function RulesWorkbench({ rules, upstreams, clock }: { rules: RoutingRule[]; upstreams: ProviderPublic[]; clock: EditorClock }) {
  const state = useRoutingRules(rules, upstreams, clock.offset);
  const { confirm, dialogProps } = useConfirm();
  useUnsavedChanges(state.dirty);
  const choose = async (rule: RoutingRule | null) => {
    if (state.dirty && !(await confirm({ title: "Discard unsaved changes?", description: "The current rule has changes that have not been saved.", confirmLabel: "Discard changes", variant: "destructive" }))) return;
    state.load(rule);
  };
  const remove = async () => {
    if (await confirm({ title: "Delete routing rule?", description: `Delete ${state.active?.name}? A rule bound to client keys cannot be deleted. Rebind those keys in Connect first.`, confirmLabel: "Delete rule", variant: "destructive" })) await state.remove();
  };
  return <div className="space-y-4">
    <PageHeader title="Routing Rules" description="Choose where each key goes. Make time, quota and fallback behavior explicit." actions={<Button size="sm" onClick={() => void choose(null)} disabled={state.busy}><Plus className="size-4" />New rule</Button>} />
    <TimezoneNote clock={clock} />
    <div className="routing-workbench">
      <LayerCard padding="sm" className="routing-directory space-y-1">
        <div className="flex items-center justify-between px-2 pb-2 text-xs text-basalt-muted-foreground"><span>YOUR RULES</span><Badge variant="secondary" className="text-xs">{state.rules.length}</Badge></div>
        <nav aria-label="Routing rules" className="flex gap-1 overflow-x-auto min-[1100px]:flex-col">
          {state.rules.map(rule => <Button key={rule.id} variant={state.active?.id === rule.id ? "secondary" : "ghost"} className="h-auto min-w-40 justify-start gap-2 px-3 py-2.5 text-left min-[1100px]:w-full min-[1100px]:min-w-0" aria-current={state.active?.id === rule.id ? "true" : undefined} onClick={() => void choose(rule)} disabled={state.busy}>
            <GitBranch className="size-4 shrink-0 text-basalt-primary" /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{rule.name}</span><span className="mt-0.5 block text-xs font-normal text-basalt-muted-foreground">{rule.mode === "all_day" ? "All day" : rule.mode === "daily" ? "Daily timetable" : "Weekly timetable"}</span></span>{rule.is_builtin && <LockKeyhole className="size-3.5 shrink-0 text-basalt-muted-foreground" />}
          </Button>)}
        </nav>
        <p className="px-2 pt-3 text-xs leading-relaxed text-basalt-muted-foreground">Bind client keys to these rules in <a href="/connect" className="text-basalt-primary underline underline-offset-2">Connect</a>. Each request stays on one upstream.</p>
      </LayerCard>
      <fieldset className="min-w-0 space-y-4 routing-enter" key={state.active?.id ?? "new"} disabled={state.busy}><legend className="sr-only">Rule editor</legend>
        <LayerCard className="space-y-3">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">{state.active ? "Rule workbench" : "New routing rule"}</h2>{state.active?.is_builtin && <Badge variant="outline" className="text-xs"><LockKeyhole className="mr-1 size-3" />Built-in · protected</Badge>}
            {state.active && !state.active.is_builtin && <Button size="sm" variant="ghost" className="ml-auto text-basalt-muted-foreground hover:text-basalt-destructive" onClick={remove} disabled={state.busy}><Trash2 className="size-3.5" />Delete</Button>}
          </div>
          <div className="grid items-end gap-4 lg:grid-cols-2">
            <Field label="Rule name" htmlFor="rule-name"><Input id="rule-name" size="sm" value={state.draft.name} maxLength={100} placeholder="e.g. Daily coding" onChange={event => state.change({ ...state.draft, name: event.target.value })} /></Field>
            <div className="flex items-center justify-between gap-3 pb-1"><div><label htmlFor="allow-conversion" className="text-sm font-medium">Allow protocol conversion</label><p className="text-xs text-basalt-muted-foreground">Native protocols are recommended.</p></div><Switch id="allow-conversion" checked={state.draft.allow_conversion} onCheckedChange={allow_conversion => state.change({ ...state.draft, allow_conversion })} /></div>
          </div>
          <Feedback error={state.error} message={state.message} />
          <SaveBar dirty={state.dirty} saving={state.busy} onSave={() => void state.save()} onDiscard={() => state.load(state.active)} />
        </LayerCard>
        <LayerCard>
          <LayerCard.Header className="flex flex-wrap items-center gap-2"><GitBranch className="size-4 text-basalt-primary" /><h2 className="text-sm font-semibold">Default chain</h2><Badge variant="secondary" className="ml-auto text-xs">{state.draft.mode === "all_day" ? "All requests" : "Outside scheduled periods"}</Badge></LayerCard.Header>
          <LayerCard.Body className="space-y-3"><p className="text-xs text-basalt-muted-foreground">The visible default covers every gap. Its terminal fallback is the last target in this chain.</p><ChainEditor label="Default chain" value={state.draft.default_chain} upstreams={upstreams} conversion={state.draft.allow_conversion} onChange={default_chain => state.change({ ...state.draft, default_chain })} /></LayerCard.Body>
        </LayerCard>
        <LayerCard>
          <LayerCard.Header className="flex items-center gap-2"><ArrowRight className="size-4 text-basalt-primary" /><h2 className="text-sm font-semibold">Time-period chains</h2><span className="ml-auto text-xs text-basalt-muted-foreground">Local editing → UTC</span></LayerCard.Header>
          <LayerCard.Body><ScheduleEditor mode={state.draft.mode} windows={state.draft.windows} offset={clock.offset}
            onChange={(mode, windows) => state.change({ ...state.draft, mode, windows })}
            newValue={() => structuredClone(state.draft.default_chain)} summarize={targets => `${targets.length} target${targets.length === 1 ? "" : "s"}`}
            renderValue={(targets, onChange) => <ChainEditor label="Period chain" value={targets} upstreams={upstreams} conversion={state.draft.allow_conversion} onChange={onChange} />}
            emptyLabel="The default chain applies all day. Add a daily or weekday timetable to override it during selected periods." /></LayerCard.Body>
        </LayerCard>
      </fieldset>
    </div>
    <ConfirmDialog {...dialogProps} />
  </div>;
}
