"use client";

import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@nocoo/basalt";
import { GitBranch } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Feedback, RoutingSelect } from "@/components/routing/routing-ui";
import { errorMessage, jsonRequest, routingRequest } from "@/lib/routing-client";
import type { ApiKeyPublic } from "@/lib/types";
import type { RoutingRule } from "@/lib/routing-types";

export function KeyRuleBinding({ apiKey, rules }: { apiKey: ApiKeyPublic; rules: RoutingRule[] }) {
  const [open, setOpen] = useState(false);
  const [ruleId, setRuleId] = useState(apiKey.rule_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const ruleName = rules.find(rule => rule.id === apiKey.rule_id)?.name ?? `Unknown rule (${apiKey.rule_id})`;
  const save = async () => {
    if (busy || ruleId === apiKey.rule_id || !rules.some(rule => rule.id === ruleId)) return;
    setBusy(true); setError(null);
    try {
      await routingRequest(`/api/keys/${encodeURIComponent(apiKey.id)}`, jsonRequest("PATCH", { rule_id: ruleId }));
      setOpen(false); router.refresh();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={value => { if (busy) return; setOpen(value); if (value) { setRuleId(apiKey.rule_id); setError(null); } }}>
    <DialogTrigger asChild><Button size="sm" variant="ghost" className="max-w-64 justify-start text-xs" aria-label={`Change rule for ${apiKey.name}`}><GitBranch className="size-3.5 shrink-0" /><span className="truncate">{ruleName}</span></Button></DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>Bind {apiKey.name} to a rule</DialogTitle><DialogDescription>The secret stays unchanged. Only new requests use the new rule; running requests keep their selected upstream.</DialogDescription></DialogHeader>
      <RoutingSelect label="Routing rule" value={ruleId} onChange={setRuleId} disabled={busy} options={rules.map(rule => ({ value: rule.id, label: rule.name }))} />
      <Feedback error={error} />
      <DialogFooter><Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button onClick={save} disabled={ruleId === apiKey.rule_id || !rules.some(rule => rule.id === ruleId)} loading={busy}>Save binding</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
