// ---------------------------------------------------------------------------
// composition/index.ts (H.4) — `dispatch` entry point.
//
// The single function route handlers are expected to call after H.17:
//
//   return dispatch(c, ctx, payload, "openai", { model, stream })
//
// Responsibilities:
//   1. Run the pure router (`pickStrategy`).
//   2. On reject → 400 via the central mapper (`respondRouterReject`) so the
//      request_end log shape stays uniform.
//   3. On ok → build the strategy via `buildStrategy` and hand it to
//      `runner.execute`. Any throw from `runner.execute` is re-raised so the
//      route can surface it through `forwardError`.
//
// In Phase H, only `copilot-openai-direct` is wired through here; the rest
// keep their G-phase shims until their own H.x step lands. `dispatch` itself
// is fully generic and unaware of which strategies the registry can build.
// ---------------------------------------------------------------------------

import type { Context } from "hono"

import type { RequestContext } from "../core/context"
import { pickStrategy } from "../core/router"
import type { StrategyName } from "../core/router"
import { respondRouterReject } from "../core/router-reject"
import { execute as runnerExecute } from "../core/runner"
import { buildStrategy, type BuildStrategyDeps } from "./strategy-registry"
import type { CompiledProvider } from "../db/providers"

export interface DispatchInput {
  /** `payload.model` — used by the router, the reject log, and end-log fall-backs. */
  model: string
  /** `!!payload.stream` — pre-stream errors need the correct log flag (G.14b). */
  stream: boolean
  /** Anthropic-only header that gates a few model aliases. */
  anthropicBeta?: string | null
  /** Live router inputs. Composition reads `state` and threads them in. */
  providers: CompiledProvider[]
  /** Catalog model IDs (structural — composition stays decoupled from get-models). */
  models: Array<{ id: string }>
  /** Strategy-construction deps. */
  buildDeps: BuildStrategyDeps
}

export type ClientProtocol = "openai" | "anthropic" | "responses"

/**
 * Single function the route handlers will call once Phase H.17 shrinks them.
 * Returns the response to send to the client (success body, SSE stream, or
 * router-reject 400). Any other failure is re-thrown for the route layer's
 * `forwardError` to handle.
 */
export async function dispatch<Payload>(
  c: Context,
  ctx: RequestContext,
  payload: Payload,
  protocol: ClientProtocol,
  input: DispatchInput,
): Promise<Response> {
  const decision = pickStrategy({
    protocol,
    model: input.model,
    anthropicBeta: input.anthropicBeta ?? null,
    providers: input.providers,
    modelsCatalogIds: input.models.map((m) => m.id),
  })

  if (decision.kind === "reject") {
    return respondRouterReject(c, decision, {
      requestId: ctx.requestId,
      startTime: ctx.startTime,
      path: ctx.path,
      format: ctx.format,
      model: input.model,
      stream: input.stream,
      accountName: ctx.accountName,
      sessionId: ctx.sessionId,
      clientName: ctx.clientName,
      clientVersion: ctx.clientVersion,
    })
  }

  const strategy = buildStrategy(decision, input.buildDeps)
  return runnerExecute(c, ctx, strategy, payload as unknown)
}

export type { StrategyName }
