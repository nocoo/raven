/**
 * Upstream client contract (§3.6).
 *
 * Every outbound HTTP call from the proxy must flow through an UpstreamClient.
 * The interface decouples request/response shapes (Req/Resp) from transport
 * concerns (token retrieval, baseURL, proxy resolution) so that strategies
 * can inject fakes for unit tests without touching `state` or `fetch`
 * directly.
 *
 * A client returns either:
 *   - a parsed JSON object (`Resp`) for non-streaming requests, or
 *   - an `AsyncGenerator<ServerSentEvent>` for streaming requests.
 *
 * The discriminator is request-shape-dependent (e.g. `payload.stream === true`)
 * and intentionally not encoded in the type — concrete clients narrow the
 * union in their own signatures.
 */

import type { ServerSentEvent } from "../util/sse"

export type UpstreamResult<Resp> = Resp | AsyncGenerator<ServerSentEvent>

export interface UpstreamClient<Req, Resp> {
  send(payload: Req): Promise<UpstreamResult<Resp>>
}
