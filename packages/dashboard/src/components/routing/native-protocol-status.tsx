"use client";

import { Badge } from "@nocoo/basalt";
import { CheckCircle2, CircleHelp } from "lucide-react";
import { nativeProtocolRows } from "@/lib/routing-model";
import type { ProviderPublic } from "@/lib/routing-types";

export function NativeProtocolStatus({ upstream, model }: { upstream: ProviderPublic | undefined; model: string }) {
  const rows = nativeProtocolRows(upstream, model);
  if (!rows.length) return <p className="text-xs text-basalt-muted-foreground">Native protocol unknown.</p>;
  return <section className="space-y-1.5" aria-label={`${model} native protocols`}>
    {rows.map(row => <div key={row.label} className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-medium">{row.label} native</span>
      {row.modes.map(mode => <Badge key={mode.label} variant={mode.evidence ? "success" : "secondary"} className="gap-1 text-xs" title={mode.evidence ? `${mode.evidence.tested_at} · ${mode.evidence.case_id} · ${mode.evidence.revision}` : "Catalog or configured format; not live-verified."}>
        {mode.evidence ? <CheckCircle2 className="size-3" aria-hidden="true" /> : <CircleHelp className="size-3" aria-hidden="true" />}{mode.label}: {mode.status}
      </Badge>)}
    </div>)}
  </section>;
}
