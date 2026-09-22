"use client";

import { useRef, useState } from "react";
import { errorMessage, jsonRequest, routingRequest } from "@/lib/routing-client";
import { newRule, ruleDraft, rulePayload, type RuleDraft } from "@/lib/routing-model";
import type { ProviderPublic, RoutingRule } from "@/lib/routing-types";

export function useRoutingRules(initial: RoutingRule[], upstreams: ProviderPublic[], offset: number) {
  const [rules, setRules] = useState(initial);
  const [active, setActive] = useState<RoutingRule | null>(initial[0] ?? null);
  const [draft, setDraft] = useState<RuleDraft>(() => initial[0] ? ruleDraft(initial[0], offset) : newRule());
  const [baseline, setBaseline] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const locked = useRef(false);
  const dirty = !active || JSON.stringify(draft) !== JSON.stringify(baseline);
  const load = (rule: RoutingRule | null) => {
    const next = rule ? ruleDraft(rule, offset) : newRule();
    setActive(rule); setDraft(next); setBaseline(next); setError(null); setMessage(null);
  };
  const change = (next: RuleDraft) => { setDraft(next); setError(null); setMessage(null); };
  const save = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true); setError(null); setMessage(null);
    try {
      if (new Date().getTimezoneOffset() !== offset) throw new Error("Your timezone offset changed. Reload this page before saving the timetable.");
      const body = rulePayload(draft, upstreams, offset);
      const saved = await routingRequest<RoutingRule>(active ? `/api/routing-rules/${encodeURIComponent(active.id)}` : "/api/routing-rules", jsonRequest(active ? "PUT" : "POST", body));
      setRules(current => active ? current.map(rule => rule.id === saved.id ? saved : rule) : [...current, saved]);
      load(saved); setMessage("Rule saved. New requests will use this configuration.");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { locked.current = false; setBusy(false); }
  };
  const remove = async () => {
    if (!active || active.is_builtin || locked.current) return;
    locked.current = true;
    setBusy(true); setError(null);
    try {
      await routingRequest(`/api/routing-rules/${encodeURIComponent(active.id)}`, { method: "DELETE" });
      const remaining = rules.filter(rule => rule.id !== active.id);
      setRules(remaining); load(remaining[0] ?? null); setMessage("Rule deleted.");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { locked.current = false; setBusy(false); }
  };
  return { rules, active, draft, dirty, busy, error, message, load, change, save, remove };
}
