import type { Context } from "hono"
import type { RequestContext } from "../core/context"
import { declaredProtocols } from "../core/router"
import { RoutingError } from "../core/routing-types"
import { buildUpstreamClient } from "./upstream-registry"
import { accountedFetch, resolveRouting } from "./routing"
import type { EmbeddingRequest } from "../upstream/copilot-embeddings"

export async function dispatchEmbedding(c: Context, ctx: RequestContext, payload: EmbeddingRequest) {
  const route = resolveRouting(c, ctx, payload.model)
  ctx.upstreamProtocol = "openai"
  if (route.upstream.kind !== "copilot") throw new RoutingError("The selected upstream does not support embeddings", "unsupported_endpoint", 400)
  if (payload.model === "auto") {
    const model = route.upstream.models.find((entry) => entry.id === route.resolved_model)
    const type = (model?.capabilities as { type?: string } | undefined)?.type
    const endpoints = model?.supported_endpoints ?? []
    const embedding = type === "embeddings" || type === "embedding" || endpoints.includes("/embeddings") || endpoints.includes("/v1/embeddings")
    if (!embedding) {
      if (declaredProtocols(model).length || type === "chat" || type === "completion") {
        throw new RoutingError("The configured auto model does not support embeddings", "unsupported_endpoint", 400)
      }
      throw new RoutingError("Copilot embedding capabilities are unavailable. Refresh its model catalog in Upstreams.", "copilot_capabilities_unavailable", 503)
    }
  }
  return buildUpstreamClient("copilot-embeddings", { fetch: accountedFetch(c, ctx, "embeddings") })
    .send({ ...payload, model: route.resolved_model }, c.req.raw.signal)
}
