# Gemini-compatible client API

Raven accepts Google Gemini requests on its existing Proxy listener. Official
Gemini CLI can connect directly; no separate translation process is needed.
Raven converts these requests to Chat Completions using the authenticated key's
routing rule, upstream credentials, IP policy, quota accounting and request logs.
This is a compatible subset of the Gemini API, not a native Google upstream.

## Endpoints and authentication

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/v1beta/models/{model}:generateContent` | Chat response converted to Gemini JSON |
| POST | `/v1beta/models/{model}:streamGenerateContent?alt=sse` | Gemini SSE, including complete function calls and usage trailers |
| POST | `/v1beta/models/{model}:countTokens` | Local estimate; `x-raven-token-count: estimate` |
| GET | `/v1beta/models` | Compatible models from the cached catalog, with raw IDs |
| GET | `/v1beta/models/{model}` | Cached model metadata |

Use a client API key in `x-goog-api-key`, `Authorization: Bearer`, or `x-api-key`.
Query-string keys are not accepted. Management keys do not authorize these
endpoints; `x-goog-api-key` does not authorize other API families or management.
HTTP failures use Google's `{error: {code, message, status}}` shape. Stream
failures emit an error in SSE and record an error outcome. Interrupted or malformed
streams never receive a fabricated success terminator. This path does not retry
upstream inference or refresh-and-replay rejected requests.

The key's rule must allow protocol conversion and select a Chat Completions
upstream. Copilot models that declare only Messages, Responses, images or
decisions are rejected. Explicit IDs remain unchanged; `auto` resolves through
the rule. Model listings describe cached capabilities, not a guarantee that every
listed model is reachable through every key.

## Official Gemini CLI

Verified with npm `@google/gemini-cli` **0.68.0-preview.0** using synthetic
credentials and an isolated local upstream. Set the existing Raven client key
locally; do not paste it into repository files or issue reports:

```sh
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:7024
export GEMINI_API_KEY='<your Raven client API key>'
gemini -m '<raw model ID from Raven>'
```

Merge the following into `~/.gemini/settings.json`, replacing `YOUR_MODEL_ID`
with an available Chat model. Select **Gemini API key** authentication. The
preview's headless auth validator does not accept the `gateway` auth type.

```json
{
  "security": { "auth": { "selectedType": "gemini-api-key" } },
  "model": { "name": "YOUR_MODEL_ID" },
  "experimental": { "dynamicModelConfiguration": true },
  "modelConfigs": {
    "modelDefinitions": {
      "YOUR_MODEL_ID": { "displayName": "YOUR_MODEL_ID", "tier": "flash", "isVisible": true }
    },
    "modelIdResolutions": {
      "YOUR_MODEL_ID": { "default": "YOUR_MODEL_ID", "contexts": [] }
    },
    "customOverrides": [
      {
        "match": { "model": "YOUR_MODEL_ID" },
        "modelConfig": { "generateContentConfig": { "topK": null } }
      }
    ]
  }
}
```

The CLI defaults to `topK: 64`; Chat Completions has no equivalent. The explicit
null override removes that field from the CLI's wire request. Raven rejects
non-null `topK` instead of silently changing its meaning. Set an override and
resolution for each model used by chat or auxiliary CLI tasks. `contexts: []`
prevents inherited CLI resolution contexts from selecting another model ID.
`gemini models --output-format json` displays the CLI's configured model list;
it does not automatically import Raven's catalog.

## Supported conversion and limits

- Text/system instructions, inline PNG/JPEG/WebP/HEIC/HEIF images, function
  declarations (`parameters` or `parametersJsonSchema`), calls and responses.
  Parallel calls retain their IDs. Name-only responses must identify one pending
  call unambiguously. Streaming arguments are buffered until the call completes.
- Temperature, top-p, output limit, stop sequences, penalties, seed, one candidate,
  JSON output/schema and function selection. Google schema type casing and
  nullability are normalized; JSON Schema passes through.
- Requested thought text maps from `reasoning_content`. Thinking levels map to
  `reasoning_effort`; budgets `-1` (automatic) and `0` (none) are supported.
  Explicit positive token budgets have no faithful Chat equivalent and reject.
- Token counting accepts `contents` or a `generateContentRequest` wrapper. It
  requires cached model metadata, performs no upstream call and settles no quota.
  Its tokenizer is an estimate, not Google's billing count.

Unknown or unsupported fields return 400, including Google built-in search/code
execution tools, safety settings, cached contents, file API references,
audio/video/PDF inputs, image generation and real thought signatures. The fixed
`skip_thought_signature_validator` marker injected by this CLI for unsigned
function calls is accepted; signed Google conversation state is not translated.
Clients can use their own ordinary function tools. Gemini CLI's Google-grounded
search feature requires an unsupported Google built-in tool.

## Isolated verification

```sh
bun run gate:coverage
bun run typecheck
bun run lint
bun run gate:arch
bun run gate:security
bun run scripts/verify-gemini-cli.ts /path/to/gemini
```

The CLI runner creates fresh SQLite/settings/workspace state, uses synthetic
keys and random loopback ports, and blocks external sockets in the CLI child.
It checks catalog reads, local token estimation, a streamed text reply and a
fragmented `read_file` call followed by its result. It keeps a private report and
request receipts outside the repository, then removes runtime state and both
fixture servers. No live Copilot or Google account is exercised.
