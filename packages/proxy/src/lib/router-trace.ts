// Phase F.1 — temporary router trace.
//
// Emits a debug-level `system` event with `data.kind = "router_trace"`
// at every routing decision in the three handlers. F.2 captures these
// into `test/core/router.fixtures.json`; F.3 deletes this file together
// with all `emitRouterTrace` import + call sites.

import { state } from "./state"
import { logEmitter } from "../util/log-emitter"

export type RouterTraceProtocol = "anthropic" | "openai" | "responses"

export type RouterTraceDecision =
  | { kind: "ok"; name: string; providerId?: string | null }
  | { kind: "reject"; status: number; errorType: string; message: string }

export interface RouterTraceInput {
  requestId: string
  protocol: RouterTraceProtocol
  model: string
  decision: RouterTraceDecision
  extras?: Record<string, unknown>
}

export function emitRouterTrace(input: RouterTraceInput): void {
  const { requestId, protocol, model, decision, extras } = input

  const providers = state.providers.map((p) => ({
    id: p.id,
    name: p.name,
    format: p.format,
    enabled: p.enabled === 1,
    patterns: p.patterns.map((pat) => pat.raw),
    supports_reasoning: p.supports_reasoning === 1,
  }))

  const modelsCatalogIds = state.models?.data?.map((m) => m.id) ?? []

  logEmitter.emitLog({
    ts: Date.now(),
    level: "debug",
    type: "system",
    requestId,
    msg: `router_trace ${protocol} ${model} → ${decision.kind === "ok" ? decision.name : `reject ${decision.status}`}`,
    data: {
      kind: "router_trace",
      protocol,
      model,
      providers,
      modelsCatalogIds,
      decision,
      ...(extras ?? {}),
    },
  })
}
