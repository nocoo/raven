"use client";

import { Badge, Button, Field } from "@nocoo/basalt";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nocoo/basalt/components/select";
import { AlertCircle, Check, Save, Undo2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { offsetLabel } from "@/lib/routing-schedule";

export interface EditorClock { offset: number; zone: string; now: number }
export function useEditorClock(): EditorClock | null {
  const [clock, setClock] = useState<EditorClock | null>(null);
  useEffect(() => {
    setClock({ offset: new Date().getTimezoneOffset(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: Date.now() });
  }, []);
  return clock;
}

export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
}

export function TimezoneNote({ clock }: { clock: EditorClock }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-basalt-muted-foreground">
    <Badge variant="outline" className="text-xs font-normal">{clock.zone} · {offsetLabel(clock.offset)}</Badge>
    <span>Fixed UTC recurrence. Local times shift when your timezone or daylight saving changes.</span>
  </div>;
}

export function RoutingSelect({ label, value, options, onChange, disabled = false, className = "" }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean; className?: string;
}) {
  const id = useId();
  return <Field label={label} htmlFor={id} className={className}>
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} size="sm" className="w-full"><SelectValue placeholder="Choose…" /></SelectTrigger>
      <SelectContent position="popper" style={{ maxHeight: "min(20rem, var(--radix-select-content-available-height))" }}>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
    </Select>
  </Field>;
}

export function Feedback({ error, message }: { error?: string | null; message?: string | null }) {
  if (error) return <div role="alert" className="flex items-start gap-2 rounded-widget bg-basalt-destructive/10 p-3 text-sm text-basalt-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span>{error}</span></div>;
  if (message) return <div role="status" className="flex items-center gap-2 text-sm text-basalt-success"><Check className="size-4 shrink-0" />{message}</div>;
  return null;
}

export function SaveBar({ dirty, saving, onSave, onDiscard, children }: {
  dirty: boolean; saving: boolean; onSave: () => void; onDiscard: () => void; children?: React.ReactNode;
}) {
  return <div className="routing-savebar flex flex-wrap items-center gap-2">
    <span className="mr-auto flex items-center gap-2 text-xs text-basalt-muted-foreground" role="status">
      <span className={`size-1.5 rounded-full ${dirty ? "bg-basalt-warning" : "bg-basalt-success"}`} />{dirty ? "Unsaved changes" : "All changes saved"}
    </span>
    {children}
    <Button size="sm" variant="ghost" onClick={onDiscard} disabled={!dirty || saving}><Undo2 className="size-3.5" />Discard</Button>
    <Button size="sm" onClick={onSave} disabled={!dirty} loading={saving}><Save className="size-3.5" />Save changes</Button>
  </div>;
}
