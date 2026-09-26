"use client";

import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Label, Switch, Tooltip, TooltipContent, TooltipTrigger } from "@nocoo/basalt";
import { InputArea } from "@nocoo/basalt/components/input-area";
import { MapPin, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { loadIPPolicy, locateIP, policyPayload, saveIPPolicy, type IPLocation, type IPPolicy } from "@/lib/ip-management";
import { errorMessage } from "@/lib/routing-client";
import { LocalTime } from "@/components/local-time";

export function IPPolicyDialog({ keyId, name = keyId ? "Selected API key" : "All model requests", iconOnly = false }: { keyId?: string; name?: string; iconOnly?: boolean }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<IPPolicy | null>(null);
  const [ranges, setRanges] = useState("");
  const [trusted, setTrusted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    setBusy(true); setError(null); setPolicy(null);
    try { const next = await loadIPPolicy(keyId); setPolicy(next); setRanges(next.ranges.join("\n")); setTrusted(next.trusted_proxies?.join("\n") ?? ""); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!policy) return;
    setBusy(true); setError(null);
    try { await saveIPPolicy(policyPayload(policy.enabled, ranges, keyId ? undefined : trusted), keyId); setOpen(false); router.refresh(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  const label = keyId ? "IP access" : "Global IP access";
  const trigger = <DialogTrigger asChild><Button variant={iconOnly ? "ghost" : "outline"} size={iconOnly ? "icon" : "sm"} className={iconOnly ? "size-8" : undefined} aria-label={label}><ShieldCheck className="size-3.5" />{!iconOnly && label}</Button></DialogTrigger>;
  return <Dialog open={open} onOpenChange={value => { if (busy) return; setOpen(value); if (value) void load(); }}>
    {iconOnly ? <Tooltip disableHoverableContent><TooltipTrigger asChild>{trigger}</TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip> : trigger}
    <DialogContent><DialogHeader><DialogTitle>IP access · {name}</DialogTitle><DialogDescription>{keyId ? "This key must satisfy both its own whitelist and the global whitelist." : "Applies to model API calls. Local Dashboard management remains accessible."}</DialogDescription></DialogHeader>
      {policy && <div className="space-y-4">
        <div className="flex items-center justify-between gap-3"><Label htmlFor={`${id}-enabled`}>{policy.enabled ? "Whitelist only" : "Unrestricted"}</Label><Switch id={`${id}-enabled`} checked={policy.enabled} disabled={busy} onCheckedChange={enabled => setPolicy({ ...policy, enabled })} /></div>
        <div className="space-y-1.5"><Label htmlFor={`${id}-ranges`}>Allowed IPs and networks</Label><InputArea id={`${id}-ranges`} rows={4} value={ranges} onChange={event => setRanges(event.target.value)} disabled={busy} placeholder={"192.0.2.1\n2001:db8::/32"} className="font-mono text-sm" /><p className="text-xs text-basalt-muted-foreground">One IPv4 / IPv6 address, CIDR or range per line. Unknown sources are denied when enabled.</p></div>
        {!keyId && <details><summary className="cursor-pointer text-sm">Trusted reverse proxies</summary><div className="space-y-1.5 pt-3"><Label htmlFor={`${id}-trusted`}>Proxy addresses and networks</Label><InputArea id={`${id}-trusted`} rows={3} value={trusted} onChange={event => setTrusted(event.target.value)} disabled={busy} placeholder={"127.0.0.1\n::1"} className="font-mono text-sm" /><p className="text-xs text-basalt-muted-foreground">Only these peers may supply X-Forwarded-For. Proxies must append the actual peer or replace untrusted headers. Leave empty for direct connections.</p></div></details>}
      </div>}
      {busy && !policy && <p role="status" className="text-sm">Loading policy…</p>}
      {error && <p role="alert" className="text-sm text-basalt-destructive">{error}</p>}
      <DialogFooter>{!policy && !busy && <Button variant="outline" onClick={load}>Retry</Button>}<Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} disabled={!policy} onClick={save}>Save policy</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function IPLookup({ ip }: { ip: string }) {
  const [result, setResult] = useState<IPLocation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function lookup() {
    setBusy(true); setError(null);
    try { setResult(await locateIP(ip)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-3"><code className="break-all text-sm">{ip || "Unknown IP"}</code>{ip && <Button size="sm" variant="outline" loading={busy} onClick={lookup}><MapPin className="size-3.5" />{result ? "Refresh location" : "Look up location"}</Button>}</div>
    {error && <p role="alert" className="text-xs text-basalt-destructive">{error}</p>}
    {result && <div className="text-sm"><p>{[result.location?.city, result.location?.province, result.location?.country].filter(Boolean).join(", ") || "Location unknown"}</p><p className="text-basalt-muted-foreground">{[result.location?.isp, result.location?.asn ? `AS${result.location.asn}` : null, result.location?.asOrg].filter(Boolean).join(" · ")}</p><p className="mt-1 text-xs text-basalt-muted-foreground">{result.cached ? "Cached" : "Checked"} · <LocalTime timestamp={result.fetched_at} /></p></div>}
  </div>;
}
