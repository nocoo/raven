"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger, Field, Input, LayerCard, Switch } from "@nocoo/basalt";
import { ExternalLink, LockKeyhole } from "lucide-react";
import { FORMATS } from "@/lib/routing-model";
import type { ProviderPublic, UpstreamFormat } from "@/lib/routing-types";
import type { UpstreamDraft } from "@/lib/upstream-model";
import { RoutingSelect } from "./routing-ui";

export function UpstreamConnection({ upstream, value, onChange }: { upstream: ProviderPublic | null; value: UpstreamDraft; onChange: (value: UpstreamDraft) => void }) {
  if (upstream?.kind === "copilot") return <LayerCard.Well className="space-y-3 p-4">
    <div className="flex items-center gap-2"><LockKeyhole className="size-4 text-basalt-primary" /><h3 className="text-sm font-semibold">Connected through your GitHub account</h3></div>
    <p className="text-sm text-basalt-muted-foreground">Copilot uses your existing sign-in. This built-in connection cannot be disabled or deleted.</p>
    <a href="/copilot/account" className="inline-flex items-center gap-1.5 text-sm text-basalt-primary hover:underline">Manage Copilot account<ExternalLink className="size-3.5" /></a>
  </LayerCard.Well>;
  return <div className="space-y-4">
    <RoutingSelect label="Native API format" value={value.format} options={FORMATS} onChange={format => onChange({ ...value, format: format as UpstreamFormat })} className="max-w-sm" />
    <Field label="Base URL" htmlFor="upstream-base-url" hint="The provider's API base, usually ending in /v1."><Input id="upstream-base-url" size="sm" type="url" value={value.base_url} placeholder="https://api.example.com/v1" onChange={event => onChange({ ...value, base_url: event.target.value })} /></Field>
    <Field label={upstream ? "Replace API key" : "API key"} htmlFor="upstream-api-key" hint={upstream ? `Current: ${upstream.api_key_preview || "configured"}. Leave empty to keep the saved secret.` : "Stored securely in Raven. The saved secret is never returned to the dashboard."}>
      <Input id="upstream-api-key" size="sm" type="password" autoComplete="new-password" passwordManagerIgnore value={value.api_key} onChange={event => onChange({ ...value, api_key: event.target.value })} placeholder={upstream ? "Leave empty to keep current key" : "Provider API key"} />
    </Field>
    <div className="flex items-center justify-between gap-3"><div><label htmlFor="upstream-enabled" className="text-sm font-medium">Enabled</label><p className="text-xs text-basalt-muted-foreground">Allow new requests to use this connection.</p></div><Switch id="upstream-enabled" checked={value.is_enabled} onCheckedChange={is_enabled => onChange({ ...value, is_enabled })} /></div>
    <Collapsible>
      <CollapsibleTrigger className="text-sm">Advanced connection settings</CollapsibleTrigger>
      <CollapsibleContent unstyled><div className="space-y-4 pt-3"><div className="grid gap-3 sm:grid-cols-2">
      <RoutingSelect label="Authentication header" value={value.auth_style ?? "default"} options={[{ value: "default", label: "Protocol default" }, { value: "bearer", label: "Authorization: Bearer" }, { value: "x-api-key", label: "x-api-key" }]} onChange={auth => onChange({ ...value, auth_style: auth === "default" ? null : auth as "bearer" | "x-api-key" })} />
      <RoutingSelect label="SOCKS5 proxy" value={value.use_socks5 === null ? "default" : value.use_socks5 ? "on" : "off"} options={[{ value: "default", label: "Use Raven setting" }, { value: "on", label: "Always use proxy" }, { value: "off", label: "Direct connection" }]} onChange={proxy => onChange({ ...value, use_socks5: proxy === "default" ? null : proxy === "on" })} />
    </div>
      <div className="flex items-center justify-between gap-3"><div><label htmlFor="upstream-reasoning" className="text-sm font-medium">Reasoning support</label><p className="text-xs text-basalt-muted-foreground">Accepts reasoning effort parameters.</p></div><Switch id="upstream-reasoning" checked={value.supports_reasoning} onCheckedChange={supports_reasoning => onChange({ ...value, supports_reasoning })} /></div>
      </div></CollapsibleContent>
    </Collapsible>
  </div>;
}
