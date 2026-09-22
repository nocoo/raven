"use client";

import { useRef, useState } from "react";
import { jsonRequest, routingRequest, type RoutingFeedback } from "@/lib/routing-client";
import { newRule, ruleDraft, rulePayload, type RuleDraft } from "@/lib/routing-model";
import type { ProviderPublic, RoutingRule } from "@/lib/routing-types";

export function useRoutingRules(initial: RoutingRule[], upstreams: ProviderPublic[], offset: number) {
  const [rules, setRules] = useState(initial);
  const [active, setActive] = useState<RoutingRule | null>(initial[0] ?? null);
  const [draft, setDraft] = useState<RuleDraft>(() => initial[0] ? ruleDraft(initial[0], offset) : newRule());
  const [baseline, setBaseline] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<RoutingFeedback | null>(null);
  const locked = useRef(false);
  const lastSavedId = useRef(initial[0]?.id);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const load = (rule: RoutingRule | null) => {
    const next = rule ? ruleDraft(rule, offset) : newRule();
    if (rule) lastSavedId.current = rule.id;
    setActive(rule); setDraft(next); setBaseline(next); setFeedback(null);
  };
  const change = (next: RuleDraft) => { setDraft(next); setFeedback(null); };
  const discard = () => load(active ?? rules.find(rule => rule.id === lastSavedId.current) ?? rules[0] ?? null);
  const save = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true); setFeedback(null);
    try {
      if (new Date().getTimezoneOffset() !== offset) throw new Error("Your timezone offset changed. Reload this page before saving the timetable.");
      const body = rulePayload(draft, upstreams, offset);
      const saved = await routingRequest<RoutingRule>(active ? `/api/routing-rules/${encodeURIComponent(active.id)}` : "/api/routing-rules", jsonRequest(active ? "PUT" : "POST", body));
      setRules(current => active ? current.map(rule => rule.id === saved.id ? saved : rule) : [...current, saved]);
      load(saved); setFeedback({ kind: "success", message: "Rule saved. New requests will use this configuration." });
    } catch (cause) { setFeedback({ kind: "error", title: "Rule could not be saved", cause }); }
    finally { locked.current = false; setBusy(false); }
  };
  const remove = async () => {
    if (!active || active.is_builtin || locked.current) return;
    locked.current = true;
    setBusy(true); setFeedback(null);
    try {
      await routingRequest(`/api/routing-rules/${encodeURIComponent(active.id)}`, { method: "DELETE" });
      const remaining = rules.filter(rule => rule.id !== active.id);
      setRules(remaining); load(remaining[0] ?? null); setFeedback({ kind: "success", message: "Rule deleted." });
    } catch (cause) { setFeedback({ kind: "error", title: "Rule could not be deleted", cause }); }
    finally { locked.current = false; setBusy(false); }
  };
  return { rules, active, draft, dirty, busy, feedback, load, change, discard, save, remove };
}
