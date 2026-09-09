import { matchProvider } from "../core/router"
import type { CompiledProvider } from "../db/providers"
import { HTTPError } from "../lib/error"
import { checkRateLimit } from "../lib/rate-limit"
import { state } from "../lib/state"
import { parseImageRequest } from "../protocols/images/request"
import type { CustomImagesClient } from "../upstream/custom-images"
import { buildUpstreamClient } from "./upstream-registry"

export interface ImageDispatchDeps {
  providers: CompiledProvider[]
  checkRateLimit(): Promise<void>
  client: Pick<CustomImagesClient, "send">
}

export function defaultImageDispatchDeps(): ImageDispatchDeps {
  return {
    providers: state.providers,
    checkRateLimit: () => checkRateLimit(state),
    client: buildUpstreamClient("custom-images"),
  }
}

export async function dispatchImageGeneration(
  value: unknown,
  signal?: AbortSignal,
  deps: ImageDispatchDeps = defaultImageDispatchDeps(),
): Promise<Response> {
  const payload = parseImageRequest(value)
  if (!payload) {
    throw new HTTPError(
      "Expected a JSON image request with non-empty model and prompt, valid options, and stream omitted or false. Image streaming is not supported.",
      400,
    )
  }
  const match = matchProvider(
    [payload.model],
    deps.providers.filter((provider) => provider.enabled === 1),
  )
  if (!match) {
    throw new HTTPError(
      "Image generation requires an enabled custom OpenAI upstream with a matching model pattern. Copilot fallback is not supported.",
      400,
    )
  }
  if (match.provider.format !== "openai") {
    throw new HTTPError(
      "The matched image upstream must use OpenAI format; Anthropic upstreams are not supported.",
      400,
    )
  }
  await deps.checkRateLimit()
  return deps.client.send(match.provider, payload, signal)
}
