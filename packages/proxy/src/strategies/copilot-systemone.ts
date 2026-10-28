import type { SSEMessage } from "hono/streaming"
import type { Strategy } from "../core/strategy"
import { normalizeUsage } from "../core/usage"
import { isRecord, type SystemonePayload } from "../protocols/systemone"
import type { CopilotSystemoneClient, SystemoneResult } from "../upstream/copilot-systemone"

export function makeCopilotSystemone(deps: { client: CopilotSystemoneClient }): Strategy<
  SystemonePayload, SystemonePayload, SystemoneResult, Response, never, SSEMessage, null
> {
  return {
    name: "copilot-systemone",
    prepare: req => req,
    dispatch: async (req, ctx) => ({ kind: "json", body: await deps.client.send(req, ctx.signal) }),
    adaptJson: resp => new Response(resp.text || null, { status: resp.status, headers: { "content-type": resp.contentType } }),
    jsonOutcome: resp => resp.failed ? "error" : "success",
    initStreamState: () => null,
    adaptChunk: () => [],
    adaptStreamError: () => [],
    describeEndLog: result => {
      if (result.kind !== "json") return { model: result.req.model }
      const data = isRecord(result.resp.data) ? result.resp.data : {}
      const usage = normalizeUsage("systemone", data.usage)
      return {
        model: result.req.model, resolvedModel: typeof data.model === "string" ? data.model : null,
        inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_tokens, cacheWriteTokens: usage.cache_write_tokens,
        ...(result.resp.status >= 300 ? { error: result.resp.text.slice(0, 512) }
          : result.resp.failed ? { error: "Upstream returned a decision error or refusal" } : {}),
      }
    },
  }
}
