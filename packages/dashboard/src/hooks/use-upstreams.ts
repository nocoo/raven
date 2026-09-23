"use client";

import { useRef, useState } from "react";
import { jsonRequest, routingRequest, type RoutingFeedback } from "@/lib/routing-client";
import { modelIds } from "@/lib/routing-model";
import type { ProviderPublic, UpstreamDiagnostic } from "@/lib/routing-types";
import { upstreamDraft, upstreamPayload, type UpstreamDraft } from "@/lib/upstream-model";

type UpstreamAction = "save" | "delete" | "refresh" | "status" | "test";

export function useUpstreams(initial: ProviderPublic[], offset: number, now: number) {
  const [upstreams, setUpstreams] = useState(initial);
  const [active, setActive] = useState<ProviderPublic | null>(initial[0] ?? null);
  const [draft, setDraft] = useState(() => upstreamDraft(initial[0] ?? null, offset, now));
  const [baseline, setBaseline] = useState(draft);
  const [busy, setBusy] = useState<UpstreamAction | null>(null);
  const [feedback, setFeedback] = useState<(RoutingFeedback & { action: UpstreamAction }) | null>(null);
  const [testModel, setTestModel] = useState(modelIds(initial[0])[0] ?? "");
  const locked = useRef(false);
  const lastSavedId = useRef(initial[0]?.id);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const load = (upstream: ProviderPublic | null) => {
    const next = upstreamDraft(upstream, offset, now);
    if (upstream) lastSavedId.current = upstream.id;
    setActive(upstream); setDraft(next); setBaseline(next); setFeedback(null); setTestModel(modelIds(upstream ?? undefined)[0] ?? "");
  };
  const change = (next: UpstreamDraft) => { setDraft(next); setFeedback(null); };
  const discard = () => load(active ?? upstreams.find(upstream => upstream.id === lastSavedId.current) ?? upstreams[0] ?? null);
  const adopt = (upstream: ProviderPublic) => {
    setUpstreams(current => current.some(item => item.id === upstream.id) ? current.map(item => item.id === upstream.id ? upstream : item) : [...current, upstream]);
    load(upstream);
  };
  const run = async (kind: UpstreamAction, title: string, action: () => Promise<RoutingFeedback | undefined>) => {
    if (locked.current) return;
    locked.current = true; setBusy(kind); setFeedback(null);
    try {
      const result = await action();
      if (result) setFeedback({ ...result, action: kind });
    }
    catch (cause) { setFeedback({ kind: "error", title, cause, action: kind }); }
    finally { locked.current = false; setBusy(null); }
  };
  const save = () => run("save", "Upstream could not be saved", async () => {
    if (new Date().getTimezoneOffset() !== offset) throw new Error("Your timezone offset changed. Reload this page before saving the timetable.");
    const body = upstreamPayload(draft, active, offset);
    const saved = await routingRequest<ProviderPublic>(active ? `/api/upstreams/${encodeURIComponent(active.id)}` : "/api/upstreams", jsonRequest(active ? "PUT" : "POST", body));
    adopt(saved); return { kind: "success", message: "Upstream saved." };
  });
  const remove = () => run("delete", "Upstream could not be deleted", async () => {
    if (!active || active.kind === "copilot") return;
    await routingRequest(`/api/upstreams/${encodeURIComponent(active.id)}`, { method: "DELETE" });
    const remaining = upstreams.filter(item => item.id !== active.id);
    setUpstreams(remaining); load(remaining[0] ?? null); return { kind: "success", message: "Upstream deleted." };
  });
  const refresh = () => run("refresh", "Model refresh failed", async () => {
    if (!active || dirty) throw new Error("Save or discard your changes before refreshing the saved upstream.");
    adopt(await routingRequest<ProviderPublic>(`/api/upstreams/${encodeURIComponent(active.id)}/models/refresh`, { method: "POST" }));
    return { kind: "success", message: "Models refreshed. Manual IDs were preserved." };
  });
  const reload = () => run("status", "Quota status could not be loaded", async () => {
    if (!active || dirty) throw new Error("Save or discard your changes before reloading status.");
    adopt(await routingRequest<ProviderPublic>(`/api/upstreams/${encodeURIComponent(active.id)}`));
    return { kind: "success", message: "Quota status updated." };
  });
  const test = () => run("test", "Model test failed", async () => {
    if (!active || dirty) throw new Error("Save or discard your changes before testing the saved upstream.");
    const model = testModel.trim();
    if (!model || model === "auto") throw new Error("Select or type an explicit model ID to test.");
    const result = await routingRequest<UpstreamDiagnostic>(`/api/upstreams/${encodeURIComponent(active.id)}/test`, jsonRequest("POST", { model }));
    return { kind: "diagnostic", result };
  });
  return { upstreams, active, draft, dirty, busy, feedback, testModel, setTestModel, load, change, discard, save, remove, refresh, reload, test };
}
