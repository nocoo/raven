# Image generation via a custom upstream

Raven accepts `POST /v1/images/generations` using the same client API keys and IP whitelist as the other `/v1/*` routes. This is **JSON generation only**: edits, image streaming, and the Responses `image_generation` tool are not supported. Existing Responses tool filtering is unchanged.

## Configure explicitly

In Dashboard → Upstreams, configure an OpenAI-format provider with an image-capable upstream URL, its API key, and a model pattern such as `gpt-image-2`. Enable that provider. Existing exact-before-prefix-glob matching and provider priority apply. A matched Anthropic provider is rejected, not skipped. No enabled match returns a structured 400 error; Raven never selects Copilot or an implicit paid fallback.

For this image endpoint, base URLs may be roots (`https://api.openai.com`) or include `/v1` (`https://api.openai.com/v1`); trailing slashes are accepted. Prefixes such as `https://example.com/proxy/v1` are retained. This does not change URL handling for existing chat endpoints. Provider-specific SOCKS5 settings are honored. Redirects are rejected and an upstream request has a five-minute timeout; there are no automatic retries.

Configuring a model does not grant upstream access or establish billing support. The selected provider must actually support image generation, and usage may be billed by that provider.

## Request

Unlike OpenAI's optional model default, Raven requires an explicit non-empty `model` (up to 256 characters) to select the upstream safely. `prompt` must be non-empty and at most 32,000 characters. The JSON request body is limited to 1 MiB (413 when exceeded). `stream: true` is rejected before sending a request. Generic types and numeric ranges are checked locally; model-specific capability combinations are left to the selected upstream. Options including `size`, `quality`, `background`, `output_format`, `output_compression`, and future JSON fields are passed through without chat preprocessing or model renaming.

```bash
curl http://localhost:7024/v1/images/generations \
  -H "Authorization: Bearer $RAVEN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-image-2","prompt":"A minimal blue pocket logo","size":"1024x1024","quality":"high","output_format":"png"}'
```

Successful JSON bodies are returned unchanged, including `data[].b64_json`, URLs, revised prompts, and `usage`. Upstream JSON error bodies and status codes are preserved; `Retry-After` is forwarded when present. Non-JSON responses and connection failures produce a structured 502. Request logs contain lifecycle metadata only, never prompts, image/base64 data, upstream error bodies, or API keys. Token usage is preserved in the client response but is not added to chat token metrics.

Implementation follows route → composition → upstream, using the existing pure provider matcher. Like embeddings, this non-streaming passthrough does not add a chat/SSE strategy. Only the upstream client performs HTTP calls, and all tests use mocked upstream responses (no paid generation or Copilot E2E).

API contract checked against [OpenAI Create image](https://developers.openai.com/api/reference/resources/images/methods/generate) on 2026-09-09, including `gpt-image-2` options and base64 response shape.
