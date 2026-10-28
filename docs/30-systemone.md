# 30 - Native Microsoft Decision / Systemone

Raven exposes `POST /v1/systemone` as a non-streaming, Copilot-native JSON
endpoint. It is not Chat Completions and does not translate another decision
protocol into TypeSafe's response format.

## Verified Live Binding

On 2026-10-28, an explicitly authorized diagnostic reused the GitHub credential
of the existing Raven process on port 7024. One token exchange succeeded; its
`endpoints.api` was `https://api.enterprise.githubcopilot.com`. Exactly one model
request was sent to that host's `/v1/systemone`, with no redirect following,
retry, alternate path, or model fallback. It returned HTTP 200 in 1680 ms.

Request:

```json
{
  "model": "microsoft-decision-1",
  "state": "A small code change has not been tested.",
  "questions": {
    "next_step": {
      "type": "choice",
      "instructions": "Choose the next step.",
      "criteria": {
        "test": "Run the focused tests.",
        "merge": "Merge without testing."
      }
    }
  }
}
```

Observed response, not a synthetic probability fixture:

```json
{
  "model": "microsoft-decision-1",
  "answers": {
    "next_step": {
      "choice": "test",
      "confidence": 0.9976609791233872,
      "probabilities": {
        "merge": 0.001169510438306388,
        "test": 0.9988304895616936
      },
      "type": "choice"
    }
  },
  "usage": { "input_tokens": 45, "output_tokens": 1 }
}
```

The direct diagnostic proves this credential's access to this model/path at
that time, not every plan's entitlement, every question type, or the new Raven
route. Private evidence is outside Git in
`/private/tmp/raven-decision-live.KZhSJX/report.json` and `response.txt`.
No credential was printed or persisted in those artifacts. The existing 7024
process and its checkout were not modified or restarted.

## Routing and Credentials

The endpoint uses existing `/v1/*` API-key authentication, key-bound routing,
IP admission, rate limiting, quota settlement, request logging and cancellation.
Environment and database API keys work normally; internal management credentials
never authorize inference. A custom-only key does not gain access to Copilot.
`auto` resolves through the selected rule; explicit model IDs remain unchanged.

Only Copilot models declaring the exact `/v1/systemone` endpoint are eligible.
Catalog declarations are capability evidence, not entitlement checks. The
existing cached `/v1/models` aggregation remains unchanged and is not filtered
by the calling key's routing rule. Upstream permission failures are authoritative.

The Copilot token's validated HTTPS `endpoints.api` destination is captured
alongside that token during initialization and refresh. Systemone requires
this destination rather than guessing a personal-account host. Only Copilot
API hosts with no userinfo, custom port, path, query or fragment are accepted.
Client JSON cannot override the destination, credentials, or routing selection.

## Native Wire Behavior

- Accept a nonempty model, a `state` field and a nonempty named `questions`
  object; every question has a string `type`. Preserve unknown fields and
  structured values, including exact numeric lexemes through Bun's native
  source-preserving JSON support. Upstream owns detailed validation and limits.
- Forward the same native JSON structure to `/v1/systemone`. No Chat, Messages,
  Responses, `/v1/decisions`, model-name or probability conversion occurs.
- Preserve successful JSON response text without reserializing numbers or
  inserting missing `model`, `usage`, `confidence`, `legend` or distributions.
  This is transport support, not an exhaustive semantic schema validator.
- Observe only reported `usage.input_tokens` and `usage.output_tokens` for
  accounting. Missing buckets stay null; incomplete usage is marked incomplete.
  Cache buckets are not invented. Accounting never changes the wire body.
- Preserve upstream error status and bounded, credential-redacted body. Do not
  forward credentials, cookies, arbitrary upstream headers or redirect targets.
  Malformed successful JSON or an unexpected success content type returns 502.
- Recognized HTTP 200 error/refusal bodies receive the same redaction and
  length bound as non-2xx errors; truncation never changes their failure outcome.
- Preserve native error/refusal JSON; record recognized error/refusal bodies as
  errors even when upstream HTTP is 200. Never turn them into fabricated answers.
- Do not retry, refresh credentials on an inference failure, switch accounts,
  probe another path or follow a redirect. Client cancellation stops transport.
- Non-streaming-only is a Raven limit, not a verified Copilot SSE restriction.
  The existing text-ping diagnostic refuses decision models instead of sending
  a chat prompt. Do not synthesize SSE or a `[DONE]` marker.

## Independent Protocol Evidence

Microsoft's official Foundry guide documents native `state` and named
`questions`, including Choice, Noul and Score, at the Azure-specific
`/providers/microsoft/v1/systemone` endpoint:

https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision

Official Azure SDK usage/answer consumers at a fixed revision:

https://github.com/Azure/azure-sdk-for-python/blob/762d184ec36fe4c1082a2c2939382e70dd942b59/sdk/evaluation/azure-ai-evaluation/azure/ai/evaluation/_evaluators/_common/_model_runners.py

Microsoft TypeAgent at the following revision uses **a different Copilot
contract**, default model `gpt-6-luna-decisions`, `/v1/decisions`, `input`, a
questions array, and an answers array with optional model/confidence:

https://github.com/microsoft/TypeAgent/blob/be99055dfa20d3cbe9978d298b087f6bb9896edf/ts/packages/aiclient/src/decisionModels.ts

That client does not establish that `microsoft-decision-1` uses the same path.
Raven's live `/v1/systemone` result resolves the binding for the tested account;
`/v1/decisions` has not been probed or added as an alias.

The earlier third-party report is supporting evidence, not Raven verification:

https://github.com/sxwxs/ghc-api/pull/70

The version-pinned official Copilot API package also resolves its base from
token `endpoints.api`:

https://unpkg.com/@vscode/copilot-api@0.5.2/dist/index.js

Complete Copilot question/error/SSE schemas and plan-wide entitlement remain
unverified. Do not import another client's probability tolerances or retry policy.
