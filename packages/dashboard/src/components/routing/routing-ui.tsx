"use client";

import { Button, Field, Input } from "@nocoo/basalt";
import { Banner } from "@nocoo/basalt/components/banner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nocoo/basalt/components/select";
import { AlertCircle, Check, PencilLine, Save, Undo2 } from "lucide-react";
import { useEffect, useId, useState } from "react";

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
  return <p className="text-xs text-basalt-muted-foreground">Local time · {clock.zone}</p>;
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
  if (error) return <Banner role="alert" variant="error" size="sm" icon={<AlertCircle />} description={error} />;
  if (message) return <Banner role="status" variant="secondary" size="sm" icon={<Check className="text-basalt-success" />} description={message} />;
  return null;
}

export function ConfigurationHeader({ name, label, placeholder, onNameChange, isNew, dirty, busy, saving, onSave, onDiscard, children }: {
  name: string; label: string; placeholder: string; onNameChange: ((value: string) => void) | undefined;
  isNew: boolean; dirty: boolean; busy: boolean; saving: boolean;
  onSave: () => void; onDiscard: () => void; children?: React.ReactNode;
}) {
  return <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-3 pb-3">
    <div className="min-w-0 flex-1 basis-52">
      {onNameChange ? <div className="group relative">
        <Input aria-label={label} value={name} onChange={event => onNameChange(event.target.value)} placeholder={placeholder} maxLength={100} size="sm" className="routing-config-name pr-8 text-base font-semibold" />
        <PencilLine className="pointer-events-none absolute right-2.5 top-2.5 size-3.5 text-basalt-muted-foreground" aria-hidden="true" />
      </div> : <h2 className="flex h-8 items-center text-base font-semibold text-basalt-foreground">{name}</h2>}
      {(dirty || isNew) && <p className="mt-1 flex items-center gap-1.5 text-xs text-basalt-muted-foreground" role="status">
        <span className="size-1.5 rounded-full bg-basalt-warning" aria-hidden="true" />{isNew ? "New draft · not saved" : "Unsaved changes"}
      </p>}
    </div>
    <div className="flex shrink-0 items-center gap-1.5 max-sm:w-full max-sm:justify-end">
      {children}
      <Button size="sm" variant="ghost" onClick={onDiscard} disabled={(!dirty && !isNew) || busy}><Undo2 className="size-3.5" />Discard</Button>
      <Button size="sm" onClick={onSave} disabled={(!dirty && !isNew) || busy} loading={saving}><Save className="size-3.5" />Save changes</Button>
    </div>
  </header>;
}
