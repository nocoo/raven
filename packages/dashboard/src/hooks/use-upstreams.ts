"use client";

import { useRef, useState } from "react";
import { errorMessage, jsonRequest, routingRequest } from "@/lib/routing-client";
import { modelIds } from "@/lib/routing-model";
import type { ProviderPublic, UpstreamDiagnostic } from "@/lib/routing-types";
import { upstreamDraft, upstreamPayload, type UpstreamDraft } from "@/lib/upstream-model";

export function useUpstreams(initial: ProviderPublic[], offset: number, now: number) {
  const [upstreams, setUpstreams] = useState(initial);
  const [active, setActive] = useState<ProviderPublic | null>(initial[0] ?? null);
  const [draft, setDraft] = useState(() => upstreamDraft(initial[0] ?? null, offset, now));
  const [baseline, setBaseline] = useState(draft);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<UpstreamDiagnostic | null>(null);
  const [testModel, setTestModel] = useState(modelIds(initial[0])[0] ?? "");
  const locked = useRef(false);
  const dirty = !active || JSON.stringify(draft) !== JSON.stringify(baseline);
  const load = (upstream: ProviderPublic | null) => {
    const next = upstreamDraft(upstream, offset, now);
    setActive(upstream); setDraft(next); setBaseline(next); setError(null); setMessage(null); setDiagnostic(null); setTestModel(modelIds(upstream ?? undefined)[0] ?? "");
  };
  const change = (next: UpstreamDraft) => { setDraft(next); setError(null); setMessage(null); setDiagnostic(null); };
  const adopt = (upstream: ProviderPublic) => {
    setUpstreams(current => current.some(item => item.id === upstream.id) ? current.map(item => item.id === upstream.id ? upstream : item) : [...current, upstream]);
    load(upstream);
  };
  const run = async (kind: string, action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(kind); setError(null); setMessage(null);
    try { await action(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { locked.current = false; setBusy(null); }
  };
  const save = () => run("save", async () => {
    if (new Date().getTimezoneOffset() !== offset) throw new Error("Your timezone offset changed. Reload this page before saving the timetable.");
    const body = upstreamPayload(draft, active, offset);
    const saved = await routingRequest<ProviderPublic>(active ? `/api/upstreams/${encodeURIComponent(active.id)}` : "/api/upstreams", jsonRequest(active ? "PUT" : "POST", body));
    adopt(saved); setMessage("Upstream saved. No discovery or generation request was sent.");
  });
  const remove = () => run("delete", async () => {
    if (!active || active.kind === "copilot") return;
    await routingRequest(`/api/upstreams/${encodeURIComponent(active.id)}`, { method: "DELETE" });
    const remaining = upstreams.filter(item => item.id !== active.id);
    setUpstreams(remaining); load(remaining[0] ?? null); setMessage("Upstream deleted.");
  });
  const refresh = () => run("refresh", async () => {
    if (!active || dirty) throw new Error("Save or discard your changes before refreshing the saved upstream.");
    adopt(await routingRequest<ProviderPublic>(`/api/upstreams/${encodeURIComponent(active.id)}/models/refresh`, { method: "POST" }));
    setMessage("Fetched catalog refreshed. Manual model IDs were preserved.");
  });
  const reload = () => run("status", async () => {
    if (!active || dirty) throw new Error("Save or discard your changes before reloading status.");
    adopt(await routingRequest<ProviderPublic>(`/api/upstreams/${encodeURIComponent(active.id)}`));
    setMessage("Cached status updated.");
  });
  const test = () => run("test", async () => {
    if (!active || dirty) throw new Error("Save or discard your changes before testing the saved upstream.");
    const model = testModel.trim();
    if (!model || model === "auto") throw new Error("Select or type an explicit model ID to test.");
    setDiagnostic(null);
    const result = await routingRequest<UpstreamDiagnostic>(`/api/upstreams/${encodeURIComponent(active.id)}/test`, jsonRequest("POST", { model }));
    setDiagnostic(result);
    setMessage("One generation completed and observed usage was charged. Reload status to see the latest quota balance.");
  });
  return { upstreams, active, draft, dirty, busy, error, message, diagnostic, testModel, setTestModel, load, change, save, remove, refresh, reload, test };
}
