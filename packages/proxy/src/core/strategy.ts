// ---------------------------------------------------------------------------
// Strategy interface (§3.3) — the seven-method contract that Runner consumes.
// Concretions live under packages/proxy/src/strategies/*.ts. Wiring (binding
// a strategy to its UpstreamClient and dependencies) lives in
// packages/proxy/src/composition/.
//
// G.3 introduces only the type. G.5 fills in the streaming method shapes and
// G.6+ port the concrete strategies one branch at a time.
// ---------------------------------------------------------------------------

import type { SSEMessage } from "hono/streaming"

import type { RequestContext } from "./context"

export type StrategyName =
  | "copilot-native"
  | "copilot-translated"
  | "copilot-openai-direct"
  | "copilot-responses"
  | "custom-openai"
  | "custom-anthropic"

/**
 * Enumerated runtime list of every legal `StrategyName`. Mirrors the
 * StrategyName union; the type-side and value-side are kept in sync by the
 * `STRATEGY_NAMES satisfies readonly StrategyName[]` clause and by the
 * symmetry assertion in test/core/strategy.test.ts.
 */
export const STRATEGY_NAMES = [
  "copilot-native",
  "copilot-translated",
  "copilot-openai-direct",
  "copilot-responses",
  "custom-openai",
  "custom-anthropic",
] as const satisfies readonly StrategyName[]

export function isStrategyName(value: string): value is StrategyName {
  return (STRATEGY_NAMES as readonly string[]).includes(value)
}

/**
 * Discriminated dispatch result. JSON ⇒ a single completed body; Stream ⇒ an
 * async iterable of upstream chunks the Runner will pump through `adaptChunk`.
 */
export type DispatchResult<UpResp, ChunkIn> =
  | { kind: "json"; body: UpResp }
  | { kind: "stream"; chunks: AsyncIterable<ChunkIn> }

/**
 * End-log discriminator passed to `describeEndLog`. Mirrors the dispatch
 * outcome but exposes the JSON body / stream state directly so the strategy
 * can read out token counts, resolvedModel, etc. The `error` arm is used by
 * Runner when dispatch rejects before stream open or before JSON parse — it
 * lets the strategy still contribute its protocol-fixed fields (path, model,
 * upstream/upstreamFormat) to the failure log. Each arm carries the
 * upstream request so strategies can recover request-scoped fields like the
 * resolved provider without a side channel.
 */
export type EndLogResult<UpReq, UpResp, StreamState> =
  | { kind: "json"; req: UpReq; resp: UpResp }
  | { kind: "stream"; req: UpReq; state: StreamState }
  | { kind: "error"; req: UpReq; err: unknown }

export interface Strategy<
  ClientReq,
  UpstreamReq,
  UpstreamResp,
  ClientResp,
  ChunkIn,
  EventOut extends SSEMessage,
  StreamState,
> {
  name: StrategyName

  /** Pure: build the exact payload the upstream will see. */
  prepare(req: ClientReq, ctx: RequestContext): UpstreamReq

  /** Side-effecting: call the upstream via UpstreamClient. */
  dispatch(
    up: UpstreamReq,
    ctx: RequestContext,
  ): Promise<DispatchResult<UpstreamResp, ChunkIn>>

  /** Pure: convert one upstream JSON response to the client shape. */
  adaptJson(resp: UpstreamResp, req: UpstreamReq, ctx: RequestContext): ClientResp

  /** Pure: convert one upstream chunk to zero or more client events. */
  adaptChunk(
    chunk: ChunkIn,
    state: StreamState,
    ctx: RequestContext,
  ): EventOut[]

  /** Pure: produce protocol-correct terminal event(s) for a mid-flight error. */
  adaptStreamError(
    err: unknown,
    state: StreamState,
    ctx: RequestContext,
  ): EventOut[]

  /** Pure: produce strategy-specific fields for the Runner's request_end log. */
  describeEndLog(
    result: EndLogResult<UpstreamReq, UpstreamResp, StreamState>,
    ctx: RequestContext,
  ): Record<string, unknown>

  /** Factory for per-request stream state (resolvedModel, usage, accumulators). */
  initStreamState(req: UpstreamReq, ctx: RequestContext): StreamState
}
