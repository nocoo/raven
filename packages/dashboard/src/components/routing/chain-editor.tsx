"use client";

import { Badge, Button, Collapsible, CollapsibleContent, CollapsibleTrigger, LayerCard } from "@nocoo/basalt";
import { Autocomplete } from "@nocoo/basalt/components/autocomplete";
import { Banner } from "@nocoo/basalt/components/banner";
import { ArrowDown, ArrowUp, CornerDownRight, GripVertical, Plus, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { compatibility, dragState, FORMATS, IDLE_DRAG, modelIds, moveItem, previewChain } from "@/lib/routing-model";
import type { ProviderPublic, RoutingTarget } from "@/lib/routing-types";
import { RoutingSelect } from "./routing-ui";

export function ChainEditor({ value, upstreams, conversion, onChange, label }: {
  value: RoutingTarget[]; upstreams: ProviderPublic[]; conversion: boolean; onChange: (value: RoutingTarget[]) => void; label: string;
}) {
  const [drag, setDrag] = useState(IDLE_DRAG);
  const [announcement, setAnnouncement] = useState("");
  const id = useId();
  const identities = useRef(new WeakMap<RoutingTarget, string>());
  const serial = useRef(0);
  const targetKey = (target: RoutingTarget) => {
    let key = identities.current.get(target);
    if (!key) { key = `${id}-${serial.current++}`; identities.current.set(target, key); }
    return key;
  };
  const preview = previewChain(value, upstreams);
  const reorder = (from: number, to: number) => {
    const next = moveItem(value, from, to);
    if (next !== value) {
      onChange(next);
      setAnnouncement(`Target moved to position ${to + 1}. The last target is the terminal fallback.`);
    }
    setDrag(IDLE_DRAG);
  };
  const update = (index: number, target: RoutingTarget) => {
    identities.current.set(target, targetKey(value[index]!));
    onChange(value.map((current, i) => i === index ? target : current));
  };
  return <section className="space-y-3" aria-label={label}>
    <p className="sr-only" id={`${id}-drag-help`}>Drag the handle to reorder. Alternatively use the move buttons or Alt plus Arrow Up or Arrow Down on the handle.</p>
    <ol className="space-y-2" aria-label={`${label} targets`}>
      {value.map((target, index) => {
        const upstream = upstreams.find(item => item.id === target.upstream_id);
        const terminal = index === value.length - 1;
        return <li key={targetKey(target)} onDragOver={event => {
          if (drag.source === null) return;
          event.preventDefault();
          setDrag(current => dragState(current, { type: "over", index }, value.length));
        }} onDrop={event => {
          event.preventDefault();
          if (drag.source !== null) reorder(drag.source, index);
        }} className="routing-target" data-dragging={drag.source === index} data-over={drag.over === index && drag.source !== index}>
          <LayerCard.Well outlined className="space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="icon" variant="ghost" className="size-7 cursor-grab touch-none active:cursor-grabbing" draggable
                aria-label={`Move target ${index + 1}`} aria-describedby={`${id}-drag-help`}
                onDragStart={event => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", `${id}:${index}`);
                  setDrag(current => dragState(current, { type: "start", index }, value.length));
                }} onDragEnd={() => setDrag(IDLE_DRAG)}
                onKeyDown={event => {
                  if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
                    event.preventDefault(); reorder(index, index + (event.key === "ArrowUp" ? -1 : 1));
                  }
                  if (event.key === "Escape") setDrag(IDLE_DRAG);
                }}><GripVertical className="size-4" /></Button>
              <span className="text-xs font-medium tabular-nums text-basalt-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
              <Badge variant={terminal && value.length > 1 ? "purple" : "secondary"} className="text-xs">{value.length === 1 ? "Target" : terminal ? "Terminal fallback" : "Quota candidate"}</Badge>
              <span className="order-last basis-full text-xs text-basalt-muted-foreground sm:order-none sm:ml-auto sm:basis-auto">{preview.labels[index]}</span>
              <div className="ml-auto flex items-center gap-0.5 sm:ml-0">
                <Button size="icon" variant="ghost" className="size-7" aria-label={`Move target ${index + 1} up`} disabled={index === 0} onClick={() => reorder(index, index - 1)}><ArrowUp className="size-3.5" /></Button>
                <Button size="icon" variant="ghost" className="size-7" aria-label={`Move target ${index + 1} down`} disabled={terminal} onClick={() => reorder(index, index + 1)}><ArrowDown className="size-3.5" /></Button>
                <Button size="icon" variant="ghost" className="size-7 text-basalt-muted-foreground hover:text-basalt-destructive" aria-label={`Remove target ${index + 1}`} disabled={value.length === 1} onClick={() => onChange(value.filter((_, i) => i !== index))}><Trash2 className="size-3.5" /></Button>
              </div>
            </div>
            <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <RoutingSelect label={`Upstream ${index + 1}`} value={target.upstream_id} options={upstreams.map(item => ({ value: item.id, label: `${item.name}${item.is_enabled ? "" : " · disabled"}` }))}
                onChange={upstream_id => update(index, { upstream_id, model: modelIds(upstreams.find(item => item.id === upstream_id))[0] ?? "" })} />
              <div className="space-y-1.5"><label htmlFor={`${id}-model-${index}`} className="text-sm font-medium">Model {index + 1}</label>
                <Autocomplete id={`${id}-model-${index}`} aria-label={`Model ${index + 1}`} size="sm" value={target.model} placeholder="Select or type an exact model ID" items={modelIds(upstream).map(model => ({ value: model, label: model }))} onValueChange={model => update(index, { ...target, model })} className="w-full font-mono text-xs" />
              </div>
            </div>
          </LayerCard.Well>
        </li>;
      })}
    </ol>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={() => {
        const upstream = upstreams[0];
        onChange([...value.slice(0, -1), { upstream_id: upstream?.id ?? "", model: modelIds(upstream)[0] ?? "" }, ...value.slice(-1)]);
      }}><Plus className="size-3.5" />Add quota candidate</Button>
      <span className="flex items-center gap-1.5 text-xs text-basalt-muted-foreground"><CornerDownRight className="size-3.5" />Only exhausted quotas advance the chain.</span>
    </div>
    {preview.warnings.map(warning => <Banner key={warning} variant="alert" size="sm" description={warning} />)}
    <Collapsible>
      <CollapsibleTrigger className="text-xs text-basalt-muted-foreground">Protocol preview</CollapsibleTrigger>
      <CollapsibleContent unstyled><div className="space-y-3 pt-2">
        {value.map((target, index) => <section key={targetKey(target)} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-label={`Target ${index + 1} protocol preview`}>
          <span className="font-medium">Target {index + 1}</span>
          {FORMATS.map(format => {
            const state = compatibility(upstreams.find(item => item.id === target.upstream_id), target.model, format.value, conversion);
            return <span key={format.value} className={state === "Blocked" || state === "Unavailable" ? "text-basalt-warning" : "text-basalt-muted-foreground"}>{format.short}: <span className="font-medium">{state}</span></span>;
          })}
        </section>)}
        <p className="text-xs text-basalt-muted-foreground">Preview uses cached capabilities for <code>auto</code>. Unavailable means Copilot needs a usable catalog. Errors stop on the selected target; catalogs never restrict explicit model IDs.</p>
      </div></CollapsibleContent>
    </Collapsible>
    <span role="status" className="sr-only">{announcement}</span>
  </section>;
}
