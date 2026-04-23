// ---------------------------------------------------------------------------
// Emit one `upstream_raw_sse` log event per raw upstream SSE event.
//
// §4.3 refactor E2E fixtures record the byte-level stream the proxy received
// from upstream, so `adaptChunk` unit tests can replay the exact chunks
// without re-calling a real provider. Translated streams (Anthropic <->
// OpenAI) would otherwise lose the original upstream bytes the moment the
// proxy translates them — this emitter preserves them in the log bus.
//
// Level is `debug` so production terminals stay quiet; the refactor E2E
// capture harness connects over the WS log stream with `level=debug` and
// filters by requestId.
// ---------------------------------------------------------------------------

import { logEmitter } from "./log-emitter"

export function emitUpstreamRawSse(
  requestId: string,
  ev: { event?: string | null; data: string },
): void {
  logEmitter.emitLog({
    ts: Date.now(),
    level: "debug",
    type: "upstream_raw_sse",
    requestId,
    msg: ev.event ? `upstream ${ev.event}` : "upstream data",
    data: {
      event: ev.event ?? null,
      data: ev.data,
    },
  })
}
