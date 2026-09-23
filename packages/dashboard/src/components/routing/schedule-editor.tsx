"use client";

import { Badge, Button, Checkbox, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, LayerCard, SegmentControl, useConfirm } from "@nocoo/basalt";
import { Clock3, Copy, Moon, Plus, Trash2 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { availableWindow, changeScheduleMode, copyDay, DAY, DAYS, daySegments, minuteLabel, setWindowEnd, toUtcWindows, type LocalWindow } from "@/lib/routing-schedule";
import type { ScheduleMode } from "@/lib/routing-types";
import { errorMessage } from "@/lib/routing-client";
import { Feedback, RoutingSelect } from "./routing-ui";

function timeOptions(current: number, end = false) {
  const values = [...new Set([...Array.from({ length: end ? 49 : 48 }, (_, index) => index * 30), current])].sort((a, b) => a - b);
  return values.map(value => ({ value: String(value), label: minuteLabel(value) }));
}

export function ScheduleEditor<T>({ mode, windows, offset, onChange, newValue, summarize, renderValue, emptyLabel, defaultLabel }: {
  mode: ScheduleMode; windows: LocalWindow<T>[]; offset: number;
  onChange: (mode: ScheduleMode, windows: LocalWindow<T>[]) => void;
  newValue: () => T; summarize: (value: T) => string;
  renderValue: (value: T, onChange: (value: T) => void) => ReactNode;
  emptyLabel: string;
  defaultLabel?: string;
}) {
  const controlId = useId();
  const [day, setDay] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyDays, setCopyDays] = useState<number[]>([]);
  const { confirm, dialogProps } = useConfirm();
  const selected = windows.find(window => window.id === selectedId && window.day === day) ?? windows.find(window => window.day === day);
  let validation: string | null = null;
  try { toUtcWindows(windows, mode, offset); } catch (cause) { validation = errorMessage(cause); }
  const update = (next: LocalWindow<T>) => { onChange(mode, windows.map(window => window.id === next.id ? next : window)); setError(null); };
  const setMode = async (next: ScheduleMode) => {
    if (mode === next) return;
    if (windows.length && (next === "all_day" || next === "daily")) {
      const accepted = await confirm({ title: "Change timetable?", description: next === "all_day" ? `Period overrides will be removed. ${defaultLabel ?? "The default policy"} will apply all day.` : `Only periods starting on ${DAYS[day]} will repeat every day. Other weekdays will be replaced.`, confirmLabel: "Change timetable" });
      if (!accepted) return;
    }
    try {
      const nextWindows = changeScheduleMode(windows, mode, next, day, () => crypto.randomUUID());
      toUtcWindows(nextWindows, next, offset);
      onChange(next, nextWindows); setDay(0); setSelectedId(null); setError(null);
    } catch (cause) { setError(errorMessage(cause)); }
  };
  const add = () => {
    const time = availableWindow(windows, day, mode);
    if (!time) { setError("This day is full. Shorten or remove a period first."); return; }
    const window = { id: crypto.randomUUID(), day, ...time, value: newValue() };
    onChange(mode, [...windows, window]); setSelectedId(window.id); setError(null);
  };
  const applyCopy = () => {
    try {
      onChange(mode, copyDay(windows, day, copyDays, offset, () => crypto.randomUUID()));
      setCopyOpen(false); setError(null);
    } catch (cause) { setError(errorMessage(cause)); }
  };
  return <div className="space-y-3">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <SegmentControl legend="Timetable" value={mode} onValueChange={value => void setMode(value as ScheduleMode)} options={[{ value: "all_day", label: defaultLabel ? `${defaultLabel} all day` : "All day" }, { value: "daily", label: "Every day" }, { value: "weekly", label: "Weekly" }]} />
      {mode !== "all_day" && <div className="flex gap-2">
        {mode === "weekly" && <Button variant="ghost" size="sm" onClick={() => { setCopyDays([]); setError(null); setCopyOpen(true); }}><Copy className="size-3.5" />Copy day</Button>}
        <Button variant="outline" size="sm" onClick={add}><Plus className="size-3.5" />Add period</Button>
      </div>}
    </div>
    <Feedback error={error ?? validation} />
    {mode === "all_day" ? <LayerCard.Well className="flex items-center gap-3 py-3 text-sm text-basalt-muted-foreground"><Clock3 className="size-4 shrink-0" />{emptyLabel}</LayerCard.Well> : <>
      <section className="overflow-x-auto rounded-widget" aria-label="Local schedule visualization">
        <div className="min-w-[24rem] space-y-1.5 pb-1">
          <div className="ml-16 flex justify-between pr-1 text-xs tabular-nums text-basalt-muted-foreground">{["00:00", "06:00", "12:00", "18:00", "24:00"].map(time => <span key={time}>{time}</span>)}</div>
          {(mode === "weekly" ? DAYS : ["Every day"]).map((label, index) => <div key={label} className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-2">
            <Button variant={day === index ? "secondary" : "ghost"} size="sm" className="h-9 justify-start px-2 text-xs" aria-pressed={day === index} onClick={() => { setDay(index); setSelectedId(null); }}>{mode === "weekly" ? label.slice(0, 3) : "Daily"}</Button>
            <div className="routing-schedule-track relative h-9 overflow-hidden rounded-md">
              {daySegments(windows, index, mode).map(segment => <Button key={`${segment.id}-${segment.tail}`} size="sm" variant="secondary"
                className="routing-period absolute inset-y-0 h-9 min-w-0 justify-start overflow-hidden rounded-md px-1.5 text-xs"
                data-selected={selected?.id === segment.id} aria-label={`${label} ${minuteLabel(segment.start)} to ${minuteLabel(segment.end)}, ${segment.tail ? "overnight continuation, " : ""}${summarize(segment.value)}`}
                title={`${minuteLabel(segment.start)}–${minuteLabel(segment.end)} · ${summarize(segment.value)}`}
                style={{ left: `${segment.start / DAY * 100}%`, width: `${(segment.end - segment.start) / DAY * 100}%` }}
                onClick={() => { setDay(segment.day); setSelectedId(segment.id); }}>
                <span className="truncate">{segment.tail ? "↳ " : ""}{summarize(segment.value)}</span>
              </Button>)}
            </div>
          </div>)}
        </div>
      </section>
      <div className="flex flex-wrap items-center gap-3 text-xs text-basalt-muted-foreground"><span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-basalt-primary/70" />Period override</span><span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-basalt-muted" />Gaps use {defaultLabel ?? "the default"}</span><span>30-minute editing steps · click a period to edit</span></div>
      <section className="flex flex-wrap gap-1.5" aria-label={`${DAYS[day]} periods`}>
        {windows.filter(window => window.day === day).map(window => <Button key={window.id} size="sm" variant={selected?.id === window.id ? "secondary" : "ghost"} aria-pressed={selected?.id === window.id} onClick={() => setSelectedId(window.id)} className="text-xs">
          {minuteLabel(window.start)}–{minuteLabel(window.end === DAY ? DAY : window.end % DAY)}{window.end > DAY && <Moon className="size-3" />}
        </Button>)}
      </section>
      {selected ? <LayerCard className="routing-enter space-y-3 p-3 md:p-4">
        <div className="flex items-center gap-2"><h3 className="text-sm font-semibold">Period override</h3><Badge variant="purple" className="text-xs">{mode === "weekly" ? DAYS[selected.day] : "Every day"}</Badge>{selected.end > DAY && <Badge variant="outline" className="text-xs">Ends next day</Badge>}
          <Button size="icon" variant="ghost" className="ml-auto size-7" aria-label="Remove period" onClick={() => { onChange(mode, windows.filter(window => window.id !== selected.id)); setSelectedId(null); setError(null); }}><Trash2 className="size-3.5" /></Button>
        </div>
        <div className="grid gap-3 @min-[32rem]/editor:grid-cols-3">
          {mode === "weekly" && <RoutingSelect label="Starts on" value={String(selected.day)} options={DAYS.map((label, index) => ({ label, value: String(index) }))} onChange={value => { const next = Number(value); update({ ...selected, day: next }); setDay(next); }} />}
          <RoutingSelect label="Start time" value={String(selected.start)} options={timeOptions(selected.start)} onChange={value => { const start = Number(value); update({ ...selected, start, end: setWindowEnd(start, selected.end === DAY ? DAY : selected.end % DAY) }); }} />
          <RoutingSelect label="End time" value={String(selected.end === DAY ? DAY : selected.end % DAY)} options={timeOptions(selected.end === DAY ? DAY : selected.end % DAY, true)} onChange={value => update({ ...selected, end: setWindowEnd(selected.start, Number(value)) })} />
        </div>
        <p className="text-xs text-basalt-muted-foreground">An end before the start continues overnight and belongs to the day it starts. Equal times are invalid.</p>
        {renderValue(selected.value, value => update({ ...selected, value }))}
      </LayerCard> : <LayerCard className="flex flex-wrap items-center justify-between gap-2 py-3"><p className="text-sm text-basalt-muted-foreground">No periods start {mode === "weekly" ? `on ${DAYS[day]}` : "today"}. {defaultLabel ?? "The default"} covers gaps.</p><Button size="sm" variant="ghost" onClick={add}>Add a period</Button></LayerCard>}
    </>}
    <ConfirmDialog {...dialogProps} />
    <Dialog open={copyOpen} onOpenChange={setCopyOpen}><DialogContent className="grid gap-5 p-5 sm:p-6">
      <DialogHeader className="space-y-2"><DialogTitle>Copy {DAYS[day]}</DialogTitle><DialogDescription>Replace periods starting on the selected days. Overnight tails stay attached to their starting day. The complete week is checked for overlaps before applying.</DialogDescription></DialogHeader>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">{DAYS.map((label, index) => index === day ? null : <label key={label} htmlFor={`${controlId}-copy-${index}`} className="flex min-h-8 items-center gap-2 text-sm"><Checkbox id={`${controlId}-copy-${index}`} checked={copyDays.includes(index)} onCheckedChange={checked => setCopyDays(current => checked ? [...current, index] : current.filter(value => value !== index))} />{label}</label>)}</div>
      <Feedback error={error} />
      <DialogFooter className="mt-0"><Button variant="ghost" onClick={() => setCopyOpen(false)}>Cancel</Button><Button onClick={applyCopy} disabled={!copyDays.length}>Apply copy</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
