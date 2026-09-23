"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger, Field, Input, LayerCard, Switch } from "@nocoo/basalt";
import { ExternalLink, LockKeyhole, Plug, SlidersHorizontal } from "lucide-react";
import { SectionIcon } from "@/components/section-icon";
import { FORMATS } from "@/lib/routing-model";
import type { ProviderPublic, UpstreamFormat } from "@/lib/routing-types";
import type { UpstreamDraft } from "@/lib/upstream-model";
import { RoutingSelect } from "./routing-ui";

export function UpstreamConnection({ upstream, value, onChange }: { upstream: ProviderPublic | null; value: UpstreamDraft; onChange: (value: UpstreamDraft) => void }) {
  if (upstream?.kind === "copilot") return <LayerCard>
    <LayerCard.Header><h3 className="flex items-center gap-2.5 text-sm font-semibold text-basalt-foreground"><SectionIcon icon={LockKeyhole} tone="teal" />Connected through your GitHub account</h3></LayerCard.Header>
    <LayerCard.Body className="space-y-3">
    <p className="text-sm text-basalt-muted-foreground">Built-in connection · cannot be disabled or deleted.</p>
    <a href="/copilot/account" className="inline-flex items-center gap-1.5 text-sm text-basalt-primary hover:underline">Manage Copilot account<ExternalLink className="size-3.5" /></a>
    </LayerCard.Body>
  </LayerCard>;
  return <div className="settings-grid">
    <LayerCard>
    <LayerCard.Header className="items-center gap-3"><h3 className="flex items-center gap-2.5 text-sm font-semibold text-basalt-foreground"><SectionIcon icon={Plug} tone="blue" />API connection</h3><Switch id="upstream-enabled" aria-label="Enabled" checked={value.is_enabled} onCheckedChange={is_enabled => onChange({ ...value, is_enabled })} /></LayerCard.Header>
    <LayerCard.Body className="max-w-3xl space-y-4">
    <RoutingSelect label="Native API format" value={value.format} options={FORMATS} onChange={format => onChange({ ...value, format: format as UpstreamFormat })} className="max-w-sm" />
    <Field label="Base URL" htmlFor="upstream-base-url" hint="The provider's API base, usually ending in /v1."><Input id="upstream-base-url" size="sm" type="url" value={value.base_url} placeholder="https://api.example.com/v1" onChange={event => onChange({ ...value, base_url: event.target.value })} /></Field>
    <Field label={upstream ? "Replace API key" : "API key"} htmlFor="upstream-api-key" hint={upstream ? `Current: ${upstream.api_key_preview || "configured"}. Leave empty to keep the saved secret.` : "Stored securely in Raven. The saved secret is never returned to the dashboard."}>
      <Input id="upstream-api-key" size="sm" type="password" autoComplete="new-password" passwordManagerIgnore value={value.api_key} onChange={event => onChange({ ...value, api_key: event.target.value })} placeholder={upstream ? "Leave empty to keep current key" : "Provider API key"} />
    </Field>
    </LayerCard.Body>
    </LayerCard>
    <Collapsible asChild defaultOpen={value.auth_style !== null || value.use_socks5 !== null || value.supports_reasoning}><LayerCard>
      <LayerCard.Header><h3 className="w-full"><CollapsibleTrigger className="w-full justify-between text-sm font-semibold text-basalt-foreground"><span className="flex items-center gap-2.5"><SectionIcon icon={SlidersHorizontal} tone="purple" />Advanced connection settings</span></CollapsibleTrigger></h3></LayerCard.Header>
      <CollapsibleContent unstyled><LayerCard.Body className="max-w-3xl space-y-4"><div className="grid gap-3 @min-[26rem]/editor:grid-cols-2">
      <RoutingSelect label="Authentication header" value={value.auth_style ?? "default"} options={[{ value: "default", label: "Protocol default" }, { value: "bearer", label: "Authorization: Bearer" }, { value: "x-api-key", label: "x-api-key" }]} onChange={auth => onChange({ ...value, auth_style: auth === "default" ? null : auth as "bearer" | "x-api-key" })} />
      <RoutingSelect label="SOCKS5 proxy" value={value.use_socks5 === null ? "default" : value.use_socks5 ? "on" : "off"} options={[{ value: "default", label: "Use Raven setting" }, { value: "on", label: "Always use proxy" }, { value: "off", label: "Direct connection" }]} onChange={proxy => onChange({ ...value, use_socks5: proxy === "default" ? null : proxy === "on" })} />
    </div>
      <div className="flex items-center justify-between gap-3"><div><label htmlFor="upstream-reasoning" className="text-sm font-medium">Reasoning support</label><p className="text-xs text-basalt-muted-foreground">Accepts reasoning effort parameters.</p></div><Switch id="upstream-reasoning" checked={value.supports_reasoning} onCheckedChange={supports_reasoning => onChange({ ...value, supports_reasoning })} /></div>
      </LayerCard.Body></CollapsibleContent>
    </LayerCard></Collapsible>
  </div>;
}
