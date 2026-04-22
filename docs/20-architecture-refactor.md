# 20 — Architecture Refactor: Symmetric Layered Pipeline

Status: proposal
Scope: `packages/proxy`
Owner: @nocoo
Depends on: none; supersedes exploratory notes in `19-pipeline-refactor.md`

---

## 1. Goals and Non-Goals

### 1.1 Goals

1. Collapse today's parallel branches into a single pipeline with a fixed, enumerated set of strategies (6 as of this doc; see §3.2).
2. Make every layer independently testable with ≥95% statement coverage (matching the repo's existing coverage gate of 90%+; current proxy L1 is 95.6%).
3. Guarantee that every in-scope client route — `/v1/messages`, `/v1/chat/completions`, `/v1/responses` — traverses the same, clearly named layers. `/v1/models`, `/v1/embeddings`, `/v1/messages/count_tokens` are explicitly out of scope (§1.3).
4. Preserve behaviour. Existing unit tests keep passing; tests that today mutate the `state` singleton are migrated in-place per §4.4 as part of the step that changes the module they target — not all at once.
5. Build a comprehensive E2E suite up front that exercises every strategy with 2–3 real models, and run it before and after every migration step. This suite is the refactor's primary safety net.
6. Reduce `routes/messages/handler.ts` from ~970 lines to a thin binding (~30 lines); similarly collapse `chat-completions` and `responses` handlers.

### 1.2 Non-Goals

- Do not introduce a DI framework. Manual constructor injection only.
- Do not alter log field names, token accounting, error status codes, or SSE event shapes.
- Do not generalise strategies into an open (client × upstream) matrix. Register only the combinations we ship today.
- Do not touch dashboard routes, DB schema, or the WebSocket log stream.
- **Anti-ban protocol is suspended for this refactor.** E2E may retry, loop, and exercise multiple models per strategy. Anti-ban will be re-enabled for regular operations after the refactor merges.

### 1.3 Scope: in and out

In scope (become symmetric layered routes):

- `POST /v1/messages` (Anthropic)
- `POST /v1/chat/completions`, `POST /chat/completions` (OpenAI)
- `POST /v1/responses` (OpenAI Responses). It is a distinct client protocol with its own SSE event vocabulary (`response.created`, `response.completed`, …) and today has its own duplicated streaming template. The refactor brings it onto the same pipeline as a `CopilotResponses` strategy (§3.2).

Out of scope (remain as-is):

- `POST /v1/messages/count_tokens` — no upstream streaming, trivial handler.
- `GET /v1/models`, `POST /v1/embeddings`, `/embeddings` — already thin.
- All dashboard `/api/*` routes.

---

## 2. Current State Diagnosis

### 2.1 Three parallel branches today

| # | Branch | Client protocol | Upstream | Code location |
|---|---|---|---|---|
| 1 | Copilot direct (OpenAI side) | `/v1/chat/completions` | Copilot `/chat/completions` | `routes/chat-completions/handler.ts` |
| 1 | Copilot direct (Anthropic side, non-Claude) | `/v1/messages` | Copilot `/chat/completions` (via translate) | `routes/messages/handler.ts` default branch |
| 2 | Custom upstream (translate) | either | Any OpenAI- or Anthropic-compatible server | `services/upstream/send-*.ts` + `resolveProvider` |
| 3 | Copilot native Anthropic | `/v1/messages` | Copilot `/v1/messages` | `routes/messages/native-handler.ts` |

### 2.2 Concrete pain points (file-level)

1. **Controller overload.** `routes/messages/handler.ts` is 970 lines. It contains three almost-identical `streamSSE` bodies (default Copilot, custom OpenAI upstream, Anthropic passthrough), each with its own `try/catch/finally`, TTFT calculation, token extraction, and `request_end` log emission.
2. **Duplication across entries.** `routes/chat-completions/handler.ts` repeats the same streaming template a fourth time for OpenAI direct + custom OpenAI passthrough.
3. **Routing is inline.** `resolveProvider → preprocessPayload → supportsNativeMessages` decisions are spread across `if` blocks inside the handler. There is no single function that answers "given this request, which strategy runs?"
4. **Global `state` is a hidden parameter.** `state.copilotToken / providers / models / optToolCallDebug / stWebSearch*` are imported directly in handlers, services, translators, and the router. Unit tests must mutate the singleton to isolate behaviour.
5. **Translation code lives under `routes/`.** `routes/messages/{preprocess, non-stream-translation, stream-translation, anthropic-types, effort-fallback, server-tools}.ts` are protocol concerns, not route concerns.
6. **Type guards and utilities are leaked into handlers.** `isNonStreaming`, `isAnthropicNonStreaming`, `isChatCompletionResponse`, `consumeStreamToResponse`, `streamAnthropicResponse` are defined inline.
7. **Asymmetric model preprocessing.** `/v1/messages` normalises `claude-opus-4-6-YYYYMMDD → claude-opus-4.6` before matching providers, but uses the **raw** model in `resolveProvider`. `/v1/chat/completions` does no normalisation and matches on `payload.model` directly. The mismatch is a latent bug.
8. **Dead path in code.** `/v1/chat/completions` + Anthropic provider reaches the handler before being rejected with 400. It should be eliminated at router level.
9. **Server-tool interception is an `if` inside the handler.** It reads as another branch instead of a composition over a strategy.

### 2.3 What is working and must be preserved

- Two-pass provider matching (`exact` > `glob`).
- Pre-compiled `CompiledProvider.patterns` in `state.providers`.
- Anti-ban invariants (1 request per E2E test, fail-fast). **Suspended during the refactor** (§1.2) and **restored in Phase J**.
- Structured logging events (`request_start`, `request_end`, `sse_chunk`, `upstream_error`) and their field set.
- Rate limit check at the top of every request.
- `X-Initiator: agent|user` header logic in Copilot chat completions.
- All streaming token bookkeeping (input/output/cached) semantics.
- Per-protocol stream-error event shapes (OpenAI JSON chunk, Anthropic `error` event, Responses `event: error`).
- Per-route `request_end` extra fields (`translatedModel`, `routingPath`, `upstream`, `upstreamFormat`, `serverToolsUsed`).

---

## 3. Target Architecture

### 3.1 Pipeline shape

Every request passes through seven layers, top to bottom, in order.

```
L1  Ingress              Hono binding; parse JSON; attach headers
L2  RequestContext       requestId, clientIdentity, scoped logger, rate-limit gate
L3  Router               pickStrategy(ctx) → StrategyDecision  (pure function, data-only)
L4  Preprocess           protocol-level normalisation of payload + beta + tools
L5  Translate            protocol ↔ protocol transforms (pure, request/response/chunk)
L6  UpstreamClient       the single HTTP egress; one impl per upstream
L7  Runner               generic executor: SSE loop, TTFT, metrics, logs, errors
```

L1 owns the framework. L7 owns the side effects (logging + SSE write + timing). Everything in between is either pure (L3–L5) or a thin HTTP client (L6).

### 3.2 Strategy as the branching axis

Today's "three branches" become six named strategies. The **Router** (`core/router.ts::pickStrategy`) is a pure function mapping `(clientProtocol, model, providers, modelsCatalog) → StrategyDecision`, where `StrategyDecision` is a plain data value:

```
type StrategyName =
  | "copilot-native" | "copilot-translated" | "copilot-openai-direct"
  | "copilot-responses" | "custom-openai" | "custom-anthropic"

type StrategyDecision =
  | { kind: "ok"; name: StrategyName; providerId?: string }
  | { kind: "reject"; status: number; message: string; errorType: string }
```

The router never constructs a strategy instance. Instantiation happens in the **composition root** (§3.8).

| Strategy | Client | Upstream | Translate direction |
|---|---|---|---|
| `CopilotNative` | Anthropic (`/v1/messages`) | Copilot `/v1/messages` | none |
| `CopilotTranslated` | Anthropic (`/v1/messages`) | Copilot `/chat/completions` | A→O request, O→A response/chunk |
| `CopilotOpenAIDirect` | OpenAI (`/v1/chat/completions`) | Copilot `/chat/completions` | none |
| `CopilotResponses` | OpenAI Responses (`/v1/responses`) | Copilot `/responses` | none (event passthrough with metrics extraction) |
| `CustomOpenAI` | OpenAI client, or Anthropic client via translate | external OpenAI-compatible | passthrough for OpenAI client; A↔O for Anthropic client |
| `CustomAnthropic` | Anthropic (`/v1/messages`) | external Anthropic-compatible | none (passthrough) |

The combinations "OpenAI client × Anthropic upstream" and "Responses client × any custom provider" are router-level rejections; they never reach a strategy.

### 3.3 Strategy interface

The interface has seven methods. `prepare/dispatch/adaptJson/adaptChunk` carry the request/response flow. `adaptStreamError`, `describeEndLog`, and `initStreamState` are the **extension points that let Runner stay protocol-agnostic without losing fidelity** — they exist precisely because today's routes differ in error envelope (OpenAI error chunk vs. Anthropic `error` event vs. Responses `event: error` vs. custom provider) and in `request_end` field set (`translatedModel`, `copilotModel`, `routingPath`, `upstream`, `upstreamFormat`, `serverToolsUsed`).

All usage/token/resolvedModel bookkeeping is held in the per-stream `StreamState` (initialised by `initStreamState`, mutated by `adaptChunk`) and read out by `describeEndLog`. There is no separate `extractMetrics` method — Runner asks `describeEndLog` for the field bag at the end of the request and merges it with its own shared fields (§3.3.1).

```
interface Strategy<ClientReq, UpstreamReq, UpstreamResp, ClientResp, ChunkIn, EventOut, StreamState> {
  name: StrategyName

  // Pure: build the exact payload the upstream will see.
  prepare(req: ClientReq, ctx: RequestContext): UpstreamReq

  // Side-effecting: call the upstream via UpstreamClient. Returns either
  // a completed JSON body or an async iterator of upstream chunks.
  dispatch(
    up: UpstreamReq,
    ctx: RequestContext,
  ): Promise<UpstreamResp | AsyncIterable<ChunkIn>>

  // Pure: convert one upstream JSON response to the client shape.
  adaptJson(resp: UpstreamResp, ctx: RequestContext): ClientResp

  // Pure: convert one upstream chunk to zero or more client events,
  // mutating StreamState to accumulate usage / resolvedModel / tool calls.
  adaptChunk(chunk: ChunkIn, state: StreamState, ctx: RequestContext): EventOut[]

  // Pure: when the upstream stream throws mid-flight, produce the
  // protocol-correct terminal event(s) to emit before closing the stream.
  // OpenAI → single JSON error chunk; Anthropic → "error" SSE event;
  // Responses → "event: error" with JSON body.
  adaptStreamError(err: unknown, state: StreamState, ctx: RequestContext): EventOut[]

  // Pure: produce the strategy-specific fields for the Runner's request_end
  // log. Called after adaptJson (kind: "json") and in the stream's finally
  // block (kind: "stream"). Must include at minimum: resolvedModel,
  // inputTokens, outputTokens; plus any strategy-specific fields
  // (translatedModel, copilotModel, routingPath, upstream, upstreamFormat,
  // serverToolsUsed). The record is merged into Runner's base data.
  describeEndLog(
    result: { kind: "json"; resp: UpstreamResp } | { kind: "stream"; state: StreamState },
    ctx: RequestContext,
  ): Record<string, unknown>

  // Factory for per-request stream state (e.g. AnthropicStreamState,
  // toolCall accumulator, resolvedModel holder, usage accumulator).
  // Called once per stream.
  initStreamState(): StreamState
}
```

Key consequences:

- Runner does not know what "Anthropic" or "OpenAI" means. It only knows "ask the strategy how to close a broken stream" and "ask the strategy what extra fields to put in the log".
- Every per-protocol quirk (error chunk shape, terminal-event vocabulary, resolvedModel extraction, usage field names) lives with the strategy it belongs to.
- Golden-file tests (§4.3) pin the output of `adaptChunk + adaptStreamError` so this is verifiable, not just asserted by comments.

### 3.3.1 Protocol differences the interface must absorb

Captured here so reviewers can trace each method back to today's code:

| Concern | `/v1/chat/completions` today | `/v1/messages` translated | `/v1/messages` native | `/v1/responses` today |
|---|---|---|---|---|
| Stream-error event | `data: {"error":{…}}` JSON chunk | `event: error` with Anthropic error body | same as translated | `event: error` with OpenAI-shaped body |
| Extra request_end fields | — | `translatedModel` | `routingPath: "native"` | — |
| Custom-upstream fields | `upstream`, `upstreamFormat` | `upstream`, `upstreamFormat`, `translatedModel` | n/a (Copilot only) | n/a |
| Server-tool flag | n/a | `serverToolsUsed: true` | `serverToolsUsed: true` | n/a |
| Model field in log msg | `model` | `model` (raw) | `originalModel` | `resolvedModel` (after response.created) |

`describeEndLog` is the single place the strategy declares which of these apply. Runner owns the shared fields (`path`, `format`, `latencyMs`, `ttftMs`, `processingMs`, `status`, `statusCode`, `upstreamStatus`, `accountName`, `sessionId`, `clientName`, `clientVersion`, `inputTokens`, `outputTokens`).

### 3.4 Server-tool interception as a decorator

`withServerToolInterception` is today a large `if` block inside the translated path. After refactor it becomes:

```
decorate(strategy, { webSearch: enabled, tavilyKey })
  → wraps prepare() and dispatch() to pre-execute server-side tool calls
    and fold their results back into the next upstream call.
  → adaptJson / adaptChunk are unchanged.
```

It composes. A strategy with server tools disabled equals the original strategy.

### 3.5 Runner contract

`core/runner.ts` exposes one function. It accepts a fully-constructed `Strategy` (the composition root is responsible for building it; see §3.8):

```
execute<Req, UpReq, UpResp, Resp, Ch, Ev, St>(
  c: HonoContext,
  ctx: RequestContext,
  strategy: Strategy<Req, UpReq, UpResp, Resp, Ch, Ev, St>,
  payload: Req,
): Promise<Response>
```

Runner responsibilities, in order:

1. Log `request_start` (already done in L2; Runner only touches end).
2. Call `strategy.prepare`.
3. Call `strategy.dispatch`.
4. If the result is JSON: call `adaptJson`, emit `request_end` merging `strategy.describeEndLog({ kind: "json", resp })`, return `c.json`.
5. If the result is a stream: call `strategy.initStreamState()`, open SSE, loop through chunks via `adaptChunk`, write events, track TTFT; on error call `adaptStreamError` and emit its events before closing; emit `request_end` in `finally` merging `describeEndLog({ kind: "stream", state })`.
6. On any upstream error before the stream opens: emit `request_end` with `status: "error"` and rethrow for the global error middleware.

### 3.6 Directory layout after refactor

`protocols/` is strictly pure (no `state`, no `fetch`, no `logEmitter`). Anything impure — server-tool orchestration, effort fallback driven by model capabilities, model-capability lookups — moves under `strategies/support/` where it belongs semantically.

```
packages/proxy/src/
  routes/
    messages/route.ts               ~40 lines total (incl. count_tokens)
    chat-completions/route.ts       ~30 lines
    responses/route.ts              ~25 lines (now on the pipeline)
    embeddings/route.ts             (unchanged, out of scope)
    models/route.ts                 (unchanged, out of scope)
    (dashboard routes unchanged)
  core/
    context.ts                      RequestContext, ClientIdentity
    router.ts                       pickStrategy (pure)
    runner.ts                       generic executor
    stream-runner.ts                SSE read/write helpers used by Runner
    logger-scope.ts                 per-request emit helpers
  protocols/                        PURE ZONE
    anthropic/
      types.ts
      guards.ts
      preprocess.ts                 translateModelName, filterBeta,
                                    sanitizePayload, detectServerTools
      stream-state.ts
    openai/
      types.ts
      preprocess.ts                 normalizeTokenLimitParams,
                                    applyDefaultMaxTokens
    responses/
      types.ts
      stream-state.ts               resolvedModel / usage extraction helpers
    translate/
      anthropic-to-openai.ts        request-side (pure)
      openai-to-anthropic.ts        response + chunk (pure)
      consume-stream.ts             was consumeStreamToResponse (pure)
  strategies/
    copilot-native.ts
    copilot-translated.ts
    copilot-openai-direct.ts
    copilot-responses.ts
    custom-openai.ts
    custom-anthropic.ts
    support/                        IMPURE HELPERS USED BY STRATEGIES
      server-tools.ts               decorator: reads state, calls Tavily,
                                    emits debug logs
      effort-fallback.ts            reads model capabilities, emits debug logs
      anthropic-stream-writer.ts    was streamAnthropicResponse (writes SSE
                                    via Hono sseStream — not pure)
      model-capabilities.ts         wrapper around state.models lookup
  upstream/
    interface.ts                    UpstreamClient
    copilot-openai.ts               was services/copilot/create-chat-completions
    copilot-native.ts               was services/copilot/create-native-messages
    copilot-responses.ts            was services/copilot/create-responses
    copilot-embeddings.ts
    custom-openai.ts                was services/upstream/send-openai
    custom-anthropic.ts             was services/upstream/send-anthropic
  infra/
    state.ts
    rate-limit.ts
    upstream-router.ts              pattern matching, consumed by core/router
    ip-whitelist.ts
    socks5-bridge.ts
    error.ts
    api-config.ts
  db/   util/   ws/                 unchanged
```

### 3.7 Layering rules (enforced by review, later by dependency-cruiser)

- `routes/` may import only `core/`, `composition/`, `infra/middleware`, and Hono. **Not** `strategies/`, `upstream/`, `protocols/`, or `infra/state`.
- `strategies/*.ts` (the strategy concretions themselves) may import `protocols/`, `strategies/support/`, `upstream/`, `core/context`, `util/log-emitter`. **`strategies/*.ts` may NOT import `infra/state` directly.** Any state-derived value (tokens, providers, models catalog, feature flags, debug toggles) must be read through a `strategies/support/` helper that the strategy receives by explicit parameter or constructor injection.
- `strategies/support/` may import `protocols/`, `infra/state`, `util/log-emitter`, `lib/server-tools/*`. This is the only place in the post-refactor tree where "impure protocol helpers" live, and it is the only layer outside `infra/`, `composition/`, and `util/` allowed to import `infra/state`.
- `protocols/` is strictly pure. No `infra/state` import. No `fetch`. No `util/log-emitter`. No `hono/streaming`. Enforcement is **primarily dep-cruiser** (rule activated in D.7); a text grep `grep -rE "from.*(infra/state|util/log-emitter|hono/streaming)" packages/proxy/src/protocols/` is kept as a redundant CI check but is not authoritative — dep-cruiser is.
- `upstream/` is the only layer allowed to call `fetch`. It accepts config via constructor, never touches `state` at call time.
- `core/` may not import `strategies/` or `upstream/` concretions — only interfaces.

Canonical state-access rule (single source of truth, referenced by §5 D.7 / J.7 and §8 acceptance):

> **Only `infra/`, `composition/`, `strategies/support/`, and `util/` may import `infra/state`.** Anywhere else — `routes/`, `protocols/`, `core/`, `strategies/*.ts` (concretions), `upstream/` — is a violation. Enforcement is primarily dep-cruiser (path-aware, immune to relative-path aliasing); any text grep in this document is a belt-and-braces check, not the authority.

### 3.8 Composition root and strategy instantiation

The review correctly flagged that "router returns a name" and "routes/ can't import strategies/" together leave no legal place to build a strategy instance. Resolution: add a tiny **composition root** as its own layer. It is the only module allowed to know every concretion.

```
packages/proxy/src/
  composition/
    strategy-registry.ts            buildStrategy(decision, deps) → Strategy
    upstream-registry.ts            buildUpstreamClient(kind, deps) → UpstreamClient
    index.ts                        dispatch(ctx, req, payload) → Response
```

Responsibilities:

- `strategy-registry.ts` imports every `strategies/*.ts` concretion plus the `upstream-registry`. Exports one function:
  ```
  buildStrategy(decision: StrategyDecision, deps: Deps): Strategy
  ```
  For `decision.kind === "ok"` it returns the matching strategy wired with the right `UpstreamClient`; for `decision.kind === "reject"` the routes handler returns the typed error directly without building anything.
- `upstream-registry.ts` imports every `upstream/*.ts` concretion and returns them keyed by kind (`copilot-openai`, `copilot-native`, `copilot-responses`, `custom-openai`, `custom-anthropic`).
- `composition/index.ts` exposes the **one function the route handlers call**:
  ```
  dispatch(c, ctx, payload, protocol): Promise<Response>
    = pickStrategy(protocol, payload.model, state, models)
    → either reject early or buildStrategy(...) + runner.execute(...)
  ```

Layering clarifications specific to the composition root (§3.7 is already consistent with these; repeated here for proximity to the handler example below):

- `composition/` is the only module allowed to import concretions from both `strategies/` and `upstream/`.
- `core/` does not depend on `strategies/` or `upstream/`.

Handler shape after refactor (Phase H) becomes:

```
routes.post("/", async (c) => {
  const ctx = buildContext(c, "anthropic")
  const payload = await c.req.json<AnthropicMessagesPayload>()
  return composition.dispatch(c, ctx, payload, "anthropic")
})
```

This keeps `routes/` thin, `core/` concretion-free, and still ships real strategy instances to the Runner. `composition/` is explicitly allowed to be "wide" because its job is wiring; each file is expected to stay under 80 lines (lookup tables, not logic).

---

## 4. Testing Strategy

### 4.1 Per-layer test matrix

| Layer | Test style | Primary targets | Suite |
|---|---|---|---|
| L1 Ingress | Hono request integration | route binding, auth middleware pass-through | existing `test/routes/*` |
| L2 Context | Pure unit | `deriveClientIdentity`, requestId generation | new `test/core/context.test.ts` |
| L3 Router | Table-driven | every `(protocol, model, providers, modelsCatalog)` → `StrategyDecision` (ok + reject cases) | new `test/core/router.test.ts` |
| L4 Preprocess | Pure unit | model rename, beta filter, payload sanitize, tool detect, OpenAI token-limit normalize | moved from `test/messages/preprocess.test.ts` |
| L5 Translate | Pure unit | request/response/chunk translation in both directions | moved from `test/messages/*-translation.test.ts` |
| L6 UpstreamClient | `fetch` mock | auth headers, SOCKS5 wiring, error envelope | new `test/upstream/*.test.ts` |
| L7 Runner | Fake strategy + fake async iter | TTFT math, error event emission, `finally` log path, metrics plumbing | new `test/core/runner.test.ts` |
| Integration | Fake UpstreamClient injected into real strategies | end-to-end per strategy, no real HTTP | new `test/integration/*.test.ts` |
| **E2E (refactor safety net)** | Real proxy + real upstreams | every strategy × 2–3 models × {stream, non-stream} × {tools, no-tools} | new `test/e2e/refactor/*.test.ts` |

### 4.2 Coverage targets

- L3, L4, L5: 100% branch coverage. These are the highest-value pure layers.
- L6: 95% statements; exclude unreachable SOCKS5 variations when dependency is unavailable.
- L7: 95% statements; the streaming `finally` branch must be covered by at least one thrown-mid-stream test per protocol.
- Overall proxy L1 suite target stays at 95% (current 95.6%).

### 4.3 E2E refactor safety net (replaces anti-ban during refactor)

The refactor deliberately trades anti-ban frugality for coverage. The rationale: behavioural regressions in this refactor are invisible to unit tests if the layer boundaries shift; only real upstreams catch drifts in SSE ordering, tool-call encoding, and token bookkeeping.

Scope — six strategies, 2–3 representative models each:

| Strategy | Models covered | Scenarios |
|---|---|---|
| `CopilotNative` | `claude-opus-4.6`, `claude-sonnet-4.6` | stream, non-stream, with tool_use, with server-side `web_search` |
| `CopilotTranslated` | one non-Claude Copilot model (e.g. `gpt-5`), one reasoning model | stream, non-stream, with tool_use, with `web_search` |
| `CopilotOpenAIDirect` | `gpt-5`, one secondary | stream, non-stream, `max_tokens` normalisation |
| `CopilotResponses` | `gpt-5` (or current default), one reasoning model | stream (event ordering: `response.created` → deltas → `response.completed`), non-stream, `response.failed` path |
| `CustomOpenAI` | 2 configured providers (one reasoning, one non-reasoning) | stream, non-stream, passthrough (OpenAI client) and translated (Anthropic client) |
| `CustomAnthropic` | 1 configured provider, 2 models | stream, non-stream, passthrough |

Execution rules during refactor:

- Run the full suite **before** and **after** each migration step; block the step if any scenario regresses.
- Fail-fast is optional. Retries are allowed. Rate-limit concerns are explicitly deferred.
- Each scenario asserts: HTTP status, token usage shape, event ordering (golden file), `request_end` log fields, and final assembled text/tool-call content.
- Golden files are captured once on `main` during Phase C and diffed on every run; any diff requires a justified review.

Execution rules after refactor merges:

- Re-enable anti-ban for the main `bun run test:e2e` target (revert to 1 request per test, fail-fast).
- Keep the refactor suite as an opt-in target (`bun run test:e2e:full`) for future architectural work.

### 4.4 Test-doubles policy

- Unit tests for strategies inject a fake `UpstreamClient` implementing the same interface.
- Runner tests inject a fake `Strategy` that yields a pre-baked async iterator.
- No real `fetch` in unit tests. The E2E suite is the only real-network path.

**State-singleton migration (honest version).** The current proxy test suite legitimately mutates `state` in many places (e.g. `test/routes/messages-handler.test.ts`, `test/routes/native-handler.test.ts`). Forbidding that in one sweep would force rewriting ~200 tests and is incompatible with Goal 4 (preserve behaviour, keep tests green). The realistic policy is:

1. **Existing tests keep mutating `state`.** They continue to work because `state` still exists after the refactor; strategies read from it at request start.
2. **New tests for new modules** (`core/router`, `core/runner`, `strategies/*`, `upstream/*`, `protocols/*`) must not mutate `state`. They construct fakes via the module's explicit parameters.
3. **When an existing test's target module is touched in a migration step, the test is migrated in the same PR** to the new injection-based style. This spreads the rewrite across 10+ PRs instead of one.
4. **After the refactor lands**, a follow-up (tracked in §7) sweeps the remaining `state` mutations out of the suite. Not a prerequisite for merging.

### 4.5 Coverage gate (per-commit, not just final)

Coverage is enforced **at every atomic commit**, not only at refactor end. The gate is intentionally stricter than the repo's 90% floor:

1. **Global floor.** Proxy L1 statement coverage must stay **≥ 95.0%** at every commit. Baseline recorded in `docs/20-baseline.json` (Phase A/C) is the numeric source of truth; no commit may regress it by more than 0.1 absolute percentage points without a §7 waiver.
2. **New-module floor.** Any file created under `core/`, `protocols/`, `strategies/`, `upstream/`, or `composition/` ships with **≥ 95% statement coverage and 100% branch coverage on public exports** in the same commit that introduces it. A new file without matching tests fails the commit.
3. **Pure-zone stricter floor.** `protocols/` and `core/router.ts` require **100% branch coverage**. These are pure, small, and high-value — there is no excuse for an uncovered branch.
4. **Runner streaming paths.** `core/runner.ts` must cover, at minimum: (a) JSON success, (b) stream success, (c) stream error thrown mid-flight (per protocol via fake strategy), (d) upstream rejection before stream open, (e) `finally` log emission on both success and error. Missing any of these fails the commit.
5. **Enforcement mechanism.** `scripts/check-coverage.ts` (added in A.1) runs at pre-commit as part of L1; it reads `docs/20-baseline.json`, compares current `bun run test --coverage` output, and blocks commits that regress the global floor or land new files without coverage. The same script runs in CI and at pre-push.
6. **Test-count floor.** Total proxy L1 test count must only decrease when the net change in the commit deletes code or merges duplicate tests; it may not decrease merely because tests were removed without replacement. Tests deleted as part of the state-mutation migration (§4.4) must be replaced by injection-based equivalents in the same commit.

The practical consequence: a commit like "extract Runner" (G.3) that does not also land `test/core/runner.test.ts` will not pass its own pre-commit hook. Every atomic commit is self-contained — its tests live with it.

---

## 5. Migration Plan

### 5.0 Atomic-commit convention

Each Phase below is not a single PR but a **numbered series of atomic commits** `<Phase>.N`. Rules:

- **Atomic.** Each commit is independently revertible. Reverting G.5 must not require reverting G.6.
- **Green on its own.** Each commit passes: `bun run test` (L1), `bun run typecheck`, `bun run lint`, `scripts/check-coverage.ts` (§4.5), and — for commits that touch handler/strategy/upstream/composition code — the refactor E2E safety net (§4.3).
- **Tests co-located.** A commit that adds a new module also adds its tests in the same commit. "Code in one commit, tests in the next" is forbidden.
- **Message prefix.** `refactor(<Phase>.N): <imperative summary>`. Body explains what the commit does, what it does not do, and which follow-up commit picks up deferred work.
- **PR grouping.** A Phase may land as one PR (all commits together) or as a sequence of small PRs; the commit chain within a PR must still be atomic and individually green.
- **No behaviour change without marker.** Non-mechanical commits carry `refactor(<Phase>.N)!:` (breaking-marker) and document the observable delta in the body.
- **Numbering gap policy.** If a commit is abandoned mid-Phase, keep the gap — do not renumber. Downstream references stay stable.

Every Phase that introduces behaviour-sensitive changes starts with a characterisation/fixture commit that locks pre-Phase behaviour before any production code moves. The final commit of any Phase that touches handler/strategy/upstream/composition code re-runs the §4.3 safety net and records the diff (expected: no diff) in the PR description.

### 5.0.1 Phase ordering rationale

The ordering deliberately differs from a naïve "top-of-stack → bottom-of-stack" migration:

1. **Fix known bugs first (Phase A), before any goldens are captured (Phase C).** Otherwise goldens would freeze the §2.2(7) model-normalisation bug into the safety net and every downstream step would have to re-bless fixtures after the fix lands.
2. **Move outer layers (protocols → upstream → router) before Runner.** Runner consumes the stable shape that the outer layers produce. Extracting Runner while those interfaces are still in motion doubles the diff and makes SSE-byte comparison impossible.
3. **Vertical slice before horizontal build-out in Phase H.** One strategy end-to-end (`copilot-openai-direct`) proves the 7-method interface + composition root wiring before the remaining strategies fill in. The hardest strategy (`copilot-translated`) is scheduled last.
4. **Grow dependency-cruiser rules incrementally (D.7, E.11, H.19, J.7).** Each layer locks the next-outer import boundary as soon as that boundary is real. Deferring all rules to the end makes violations hard to unwind.
5. **Split Runner's JSON path from its streaming path (G.3 → G.5).** The JSON path is easy to verify; the streaming path needs byte-for-byte SSE comparison against characterisation fixtures (G.1) and therefore deserves its own commit.
6. **Share one fixture format between goldens and strategy unit tests (B.5).** `{request, upstream_raw_chunks[], expected_client_events[], expected_end_log}` feeds both the E2E diff in Phase C and `adaptChunk` unit tests in Phase H — avoids building two parallel test-data sets.

### Phase A — Prep + fix the latent bug

Goal: coverage gate + dep-cruiser plumbing are live, and the §2.2(7) model-normalisation bug is fixed **before** any goldens are captured.

- **A.1** ✅ Add `scripts/check-coverage.ts` (§4.5 enforcement). Wire into pre-commit L1, pre-push, and CI. Gate passes at the current 95.6% floor.
- **A.2** ✅ Add `docs/20-baseline.json` skeleton (schema + field definitions + `$schema` validator), numeric values as placeholders; `check-coverage.ts` reads the file format but does not yet enforce real numbers.
- **A.3** ✅ Add `dependency-cruiser.config.cjs` skeleton with **zero active rules** plus `bun run gate:arch` script (passes vacuously). Establishes the plumbing; subsequent phases add rules.
- **A.4** ✅ Add a red test that reproduces the §2.2(7) bug: `/v1/chat/completions` matches provider on raw model while `/v1/messages` matches on normalised model; request with `claude-opus-4-6-YYYYMMDD` demonstrates the divergence.
- **A.5** ✅ Create `protocols/anthropic/preprocess.ts` as a **new pure helper module** containing `translateModelName` (and any co-located normalisation helpers needed by A.4). Leave `routes/messages/preprocess.ts` **in place as a thin re-export shim** that delegates to the new module — do not delete or rename it yet; D.1 handles that. Route the OpenAI entry through the new pure helper directly (not via the legacy file). After this commit the module has two paths: new canonical one under `protocols/anthropic/`, and a legacy shim under `routes/messages/`. A.4 turns green.
- **A.6** ✅ Change `/v1/messages` provider matching to use the normalised model (today uses raw). Add a characterisation test that pins the corrected behaviour; this test becomes one of the Router fixtures in Phase F.
- **A.7** ✅ (review follow-ups) Coverage gate hardened beyond the A.1 skeleton: (a) directory migration doesn't fire false regressions (`scripts/lib/coverage.ts`); (b) router match order fixed to raw-exact → norm-exact → raw-glob → norm-glob via `resolveProviderForModels`; (c) pre-push now runs `gate:security` + proxy L1 + `gate:arch`; (d) gate flags L1 test-count regressions and new src/ files absent from lcov, with `allowUntestedFiles` grandfather list in baseline; (e) stderr drain awaited before parsing test-count (avoids race dropping the check).

### Phase B — E2E safety-net skeleton

Goal: scenario matrix, helpers, and diff tooling exist and are usable, but no real requests are issued yet.

- **B.1** Add `test/e2e/refactor/` directory + `bun run test:e2e:full` script. Scenario matrix from §4.3 exists as `.skip` placeholders.
- **B.2** Add `helpers/capture-golden.ts`: deterministic serialisation (stable key ordering, timestamp clamping, requestId masking) so re-captures diff cleanly.
- **B.3** Add `helpers/golden-diff.ts`: reads golden file, compares against current output, prints minimal diff on failure.
- **B.4** ✅ Add `scenarios.json` data file encoding §4.3's table (strategy × models × scenario matrix). Empty `.skip` tests reference it.
- **B.5** ✅ Freeze the golden fixture format: `{request, upstream_raw_chunks[], expected_client_events[], expected_end_log}`. This shape is consumed by both Phase C (E2E diff) and Phase H (`adaptChunk` unit tests) — define once here.
- **B.6** ✅ Add `bun run capture-goldens <strategy>` script so each strategy's goldens can be re-captured independently (Copilot rate-limit robustness).

### Phase C — Capture goldens (one commit per strategy)

Goal: real baseline on `main`. Each commit is atomic; any single strategy can be re-captured without affecting the others.

- **C.1** `CopilotNative` goldens (2 models × {stream, non-stream, tool_use, web_search}) under `test/e2e/refactor/__golden__/copilot-native/`.
- **C.2** `CopilotTranslated` goldens.
- **C.3** `CopilotOpenAIDirect` goldens.
- **C.4** `CopilotResponses` goldens (including `response.failed`).
- **C.5** `CustomOpenAI` goldens (requires two configured test providers; covers both OpenAI-client passthrough and Anthropic-client translated modes).
- **C.6** `CustomAnthropic` goldens.
- **C.7** Populate `docs/20-baseline.json` with real numeric values: proxy L1 test count, proxy L1 statement coverage (global + per-directory), dashboard L1 test count. Flip `check-coverage.ts` to enforcement mode. All §4.3 scenarios green on `main`.
- Gate from this point forward: every commit in Phases D–J runs the relevant safety-net subset in its pipeline.

### Phase D — Relocate protocols + impure helpers (`git mv` only)

Goal: protocol code lives under `protocols/` (pure zone) and `strategies/support/` (impure zone). Import-only diffs.

- **D.1** ✅ Finish the `preprocess.ts` migration started in A.5: (a) `git mv` `routes/messages/anthropic-types.ts` → `protocols/anthropic/types.ts`; (b) **delete** the `routes/messages/preprocess.ts` shim introduced in A.5 and update importers to point at `protocols/anthropic/preprocess.ts` directly. Net effect for `preprocess.ts` across A.5 + D.1 is file-move-by-shim-bridge: no `git mv` is performed on `preprocess.ts` itself because the canonical file was born in A.5 at its final home. Any other sibling files still living under `routes/messages/` that belong in `protocols/anthropic/` (if present) are `git mv`-ed in this commit.
- **D.2** ✅ `git mv` `routes/messages/{non-stream-translation, stream-translation}.ts` → `protocols/translate/`. Rename `consumeStreamToResponse` file to `protocols/translate/consume-stream.ts`.
- **D.3** ✅ `git mv` `routes/messages/{effort-fallback, server-tools, model-capabilities}.ts` → `strategies/support/` (not `protocols/` — they read `state` and emit logs).
- **D.4** ✅ Extract `streamAnthropicResponse` into `strategies/support/anthropic-stream-writer.ts` with tests.
- **D.5** ✅ Extract Responses resolvedModel/usage parsers into `protocols/responses/stream-state.ts` with tests.
- **D.6** ✅ Update all importers (mechanical). Completed inline during D.1–D.5 — no residual stale imports remain (verified via grep for `routes/messages/{anthropic-types,preprocess,non-stream-translation,stream-translation,effort-fallback,server-tools,model-capabilities}`). `routes/messages/utils.ts` (one pure helper) intentionally stays until J.
- **D.7** ✅ **Activate dep-cruiser rule #1** (authoritative): forbid any import from `packages/proxy/src/protocols/**` to `packages/proxy/src/infra/state`, `packages/proxy/src/util/log-emitter`, or `hono/streaming`. A redundant text grep `grep -rE "from.*(infra/state|util/log-emitter|hono/streaming)" packages/proxy/src/protocols/` runs alongside in CI, but the dep-cruiser rule — path-aware and immune to relative-path aliasing (`../../infra/state`) — is the authority.
- Risk: low. Import-only, plus one locked purity rule.

### Phase E — Extract UpstreamClient

Goal: every outbound `fetch` flows through `upstream/*`. Strategies (next phase) can inject fakes.

- **E.1** ✅ Add `upstream/interface.ts` with `UpstreamClient<Req, Resp>` + contract tests.
- **E.2** ✅ Characterisation: record current request shapes (headers, body, URL, proxy) for every `services/copilot/*` and `services/upstream/*` call via MSW-style capture. Fixtures become the assertion target for E.3–E.8.
- **E.3** ✅ Port `services/copilot/create-chat-completions.ts` → `upstream/copilot-openai.ts` with constructor-injected config (token getter, baseURL, proxy resolver). Tests assert against E.2 fixtures.
- **E.4** ✅ Port `create-native-messages.ts` → `upstream/copilot-native.ts`. Legacy file becomes a thin shim delegating to the new client (deleted in E.10).
- **E.5** ✅ Port `create-responses.ts` → `upstream/copilot-responses.ts`. Legacy file becomes a shim re-exporting `hasVisionContent`/`hasAgentHistory` and delegating `createResponses` (deleted in E.10).
- **E.6** ✅ Port `create-embeddings.ts` → `upstream/copilot-embeddings.ts`. Legacy file becomes a shim re-exporting wire types and delegating `createEmbeddings` (deleted in E.10).
- **E.7** ✅ Port `services/upstream/send-openai.ts` → `upstream/custom-openai.ts`. Legacy file becomes a shim delegating `sendOpenAIDirect` (deleted in E.10).
- **E.8** ✅ Port `services/upstream/send-anthropic.ts` → `upstream/custom-anthropic.ts`. Legacy file becomes a shim delegating `sendAnthropicDirect` (deleted in E.10).
- **E.9** ✅ Add `composition/upstream-registry.ts` (upstream portion only; strategy portion lands in Phase H) + tests for every upstream kind.
- **E.10** ✅ Handlers switch to `upstream-registry`; legacy `services/copilot/create-*.ts` and `services/upstream/send-*.ts` shims deleted; type-only consumers (`lib/tokenizer.ts`, `protocols/translate/*`) repointed to `upstream/copilot-openai`; legacy test suites relocated to `test/upstream/legacy/` and re-pointed at the new clients (1350/1350 L1, gate ✅).
- **E.11** ✅ Activate the `fetch()` boundary check via `scripts/check-fetch-boundary.ts` (wired into `gate:arch` and the parallel pre-commit hook). The script asserts that no production source outside `packages/proxy/src/upstream/` calls `fetch(`, with an explicit allow-list for the legacy non-LLM call sites (GitHub auth, Tavily, provider probes, model catalog refresh, Hono server entrypoint); each entry is referenced once or the gate fails so the list cannot rot. The structural dep-cruiser rule #2 (locking `routes/` against importing `upstream/` directly) is deferred to H.19 per the original phasing — at this stage the handlers still call `buildUpstreamClient` directly, which is the intended composition path until §3.8 lands in Phase H.
- Risk: medium (every outbound call).

### Phase F — Extract Router

Goal: a single pure function answers "given this request, which strategy runs?", driven by recorded fixtures.

- **F.1** ✅ Insert temporary trace logging inside the three existing handlers: emit `(protocol, model, providers[], modelsCatalog) → decision` for every request.
- **F.2** ✅ Run L1 + Phase C E2E with the trace active; capture into `test/core/router.fixtures.json`.
- **F.3** ✅ Remove the temporary trace logging (fixtures frozen).
- **F.4** ✅ Add `core/router.ts::pickStrategy` with `StrategyDecision` type (§3.2). Add `test/core/router.test.ts` driven by `router.fixtures.json`; 100% branch coverage required (§4.5(3)).
- **F.5** ✅ Wire `routes/chat-completions/handler.ts` to call `pickStrategy` and switch on `decision.name`; preserve existing code paths.
- **F.6** ✅ Wire `routes/messages/handler.ts` to `pickStrategy`.
- **F.7** ✅ Wire `routes/responses/handler.ts` to `pickStrategy`.
- **F.8** ✅ Extend `pickStrategy` to reject `(OpenAI client, Anthropic provider)` and `(Responses client, custom provider)` with typed `StrategyDecision.reject`. Update the router test suite to cover both reject branches.
- **F.9** ✅ Add a central error mapper that converts `decision.reject` into a 400 response with the original message/type. Delete the inline 400 `if` branch from `routes/chat-completions/handler.ts`.
- Risk: medium.

### Phase G — Extract Runner

Goal: the 4 duplicated `streamSSE` templates collapse into one `core/runner.ts`. **JSON path first, stream path second**; each handler branch ported in its own commit.

- **G.1** ✅ Characterisation: for every streaming handler branch, snapshot the complete SSE byte stream + `request_end` field bag under `test/characterisation/`. These are the byte-level diff targets for G.6–G.12.
- **G.2** Add `core/context.ts::RequestContext` + `buildContext` + unit tests.
- **G.3** Add `core/runner.ts` skeleton — **JSON path only**. Fake-strategy tests cover §4.5(4) paths a (JSON success), d (upstream rejection), e (finally log emission).
- **G.4** Add `core/stream-runner.ts` SSE read/write helpers + unit tests. Not yet wired into Runner.
- **G.5** Runner gains streaming path (consumes `stream-runner` from G.4). Covers §4.5(4) paths b (stream success) and c (mid-flight error per protocol), via fake strategies that simulate OpenAI / Anthropic / Responses error shapes.
- **G.6** Port `routes/chat-completions` **non-streaming** default branch onto Runner via a local `Strategy`-shaped shim. Migrate affected tests to the injection style per §4.4(3).
- **G.7** Port `routes/chat-completions` **streaming** default branch onto Runner. Byte-level diff against G.1 fixtures required.
- **G.8** Port `routes/chat-completions` custom-upstream passthrough branch onto Runner.
- **G.9** Port `routes/messages` default Copilot branch onto Runner.
- **G.10** Port `routes/messages` custom OpenAI-upstream branch onto Runner.
- **G.11** Port `routes/messages` Anthropic passthrough branch onto Runner.
- **G.12** Port `routes/responses` onto Runner.
- **G.13** Delete now-dead duplicated streaming templates; rerun Phase C; record no-diff.
- Expected cumulative delta: −400 lines, +200 lines. No observable behaviour change.
- Risk: medium-high — SSE ordering is the single most regression-prone area; sub-commit granularity keeps each regression localised to one handler branch.

### Phase H — Strategy objects + composition root (vertical slice first)

Goal: collapse the duplicated per-protocol pipelines into 6 strategies. Prove the end-to-end pipeline with **one** strategy before filling in the rest.

- **H.1** Characterisation: extract `describeEndLog` field bags per protocol from Phase C goldens into `test/strategies/__fixtures__/`. `adaptChunk` unit tests in H.2–H.15 read the same fixture format defined in B.5.
- **H.2** Add `strategies/copilot-openai-direct.ts` (simplest — no translation). Full 7-method implementation + unit tests covering `describeEndLog`, `adaptStreamError`, `initStreamState`, `adaptChunk` via B.5 fixtures. ≥95% coverage.
- **H.3** Add `composition/strategy-registry.ts::buildStrategy` — **registers `copilot-openai-direct` only** + tests.
- **H.4** Add `composition/index.ts::dispatch` skeleton + integration tests against H.2's strategy.
- **H.5** Switch `routes/chat-completions/handler.ts`'s `copilot-openai-direct` branch to `composition.dispatch`. Other branches keep their G-phase shim.
- **H.6** **Vertical-slice verification**: run Phase C `CopilotOpenAIDirect` goldens. Zero diff required before H.7 starts. This commit pins the 7-method interface.
- **H.7** Add `strategies/copilot-native.ts` full 7-method + unit tests.
- **H.8** Register `copilot-native` in strategy-registry; switch `routes/messages` native branch to `composition.dispatch`; run C.1 goldens.
- **H.9** Add `strategies/copilot-responses.ts` + unit tests.
- **H.10** Register `copilot-responses`; switch `routes/responses` to `composition.dispatch`; run C.4 goldens.
- **H.11** Add `strategies/custom-openai.ts` (OpenAI-client passthrough + Anthropic-client translated modes) + unit tests.
- **H.12** Register `custom-openai`; switch relevant branches in both entries to `composition.dispatch`; run C.5 goldens.
- **H.13** Add `strategies/custom-anthropic.ts` + unit tests.
- **H.14** Register `custom-anthropic`; switch relevant branches to `composition.dispatch`; run C.6 goldens.
- **H.15** Add `strategies/copilot-translated.ts` (largest — translation via `protocols/translate/`) + unit tests. Scheduled last so the 7-method interface is battle-tested before the hardest strategy fills it in.
- **H.16** Register `copilot-translated`; switch the last remaining handler branch to `composition.dispatch`; run C.2 goldens.
- **H.17** Shrink `routes/*/handler.ts` to §3.8 shape (`buildContext → composition.dispatch`, ≤ 30 lines each). Targets: chat-completions ≤ 25 lines, messages ≤ 30 lines, responses ≤ 25 lines.
- **H.18** Delete the G-phase `Strategy` shims. Run the full Phase C matrix.
- **H.19** **Activate dep-cruiser rule #3**: `routes/` may not import `strategies/` or `upstream/`; `core/` may not import either concretion; `composition/` is the sole bridge.
- Risk: medium-high. This is where the old duplication actually dies.

### Phase I — Server-tool decorator

Goal: the `if (hasServerSideTools && webSearchEnabled)` block becomes composition over strategy.

- **I.1** Add `strategies/support/server-tools.ts::decorate(strategy, options)` + tests for enabled/disabled paths.
- **I.2** Replace the `if` branch in `strategies/copilot-translated.ts` with `decorate(...)`.
- **I.3** (If applicable) apply the same replacement in any other strategy that today performs server-tool interception.
- **I.4** Run existing server-tool unit tests; run Phase C `web_search` scenarios.

### Phase J — Cleanup + restore anti-ban

Goal: delete orphans, lock remaining dep rules, re-enable anti-ban for normal operations.

- **J.1** Delete `routes/messages/native-handler.ts` (folded into `strategies/copilot-native.ts`).
- **J.2** Delete `routes/*/handler.ts`-local helpers now duplicated by `protocols/` / `strategies/` / `core/`.
- **J.3** Remove `consumeStreamToResponse` re-exports; update consumers to `protocols/translate/consume-stream.ts`.
- **J.4** Revert `test/e2e/` to anti-ban rules (1 request per test, fail-fast).
- **J.5** Keep `test/e2e/refactor/` as the opt-in `bun run test:e2e:full` target (for future architectural work).
- **J.6** Update `CLAUDE.md` to reflect restored anti-ban rules and the new architecture (one-page navigation covering the seven layers, the six strategies, and the composition root).
- **J.7** **Activate dep-cruiser rule set (final)**: encode the full §3.7 + §3.8 contract — enforce the canonical state-access rule (`infra/state` importable only from `infra/`, `composition/`, `strategies/support/`, `util/`; forbidden in `routes/`, `protocols/`, `core/`, `strategies/*.ts`, `upstream/`); `core/` stays concretion-free; `composition/` is the only bridge between `routes/`, `strategies/`, and `upstream/`. Any rule not yet active from D.7 / E.11 / H.19 lands here.
- **J.8** Final Phase C run; record no-diff against the Phase C baseline in the closing PR description.

---

## 6. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Silent change to SSE event ordering | medium | high (breaks downstream clients) | Golden-file tests on chunk sequences per strategy before Phase H; diff after. |
| Token accounting drift during extraction | low | high (affects billing/usage UI) | Token/usage bookkeeping is held in `StreamState` and surfaced via `describeEndLog`; add unit tests for each strategy's `describeEndLog` seeded from recorded fixtures. |
| Global `state` refactor breaking SOCKS5 or token refresh | medium | medium | Phase E defers `state` reads to request start, not module load; keep the singleton's lifecycle unchanged. |
| Test-suite churn blocks merges | medium | medium | Each phase is independently mergeable; import-only edits in Phases D–F keep tests green. |
| E2E quota exhaustion from unrestricted retries | medium | low | Anti-ban is suspended, not ignored; keep scenario count bounded (section 4.3 table) and cache golden fixtures so reruns hit upstream only when code changes. |
| Hidden coupling on `state.optToolCallDebug` | low | low | Debug logging moves into Runner, driven by a flag in RequestContext. |

---

## 7. Out-of-Scope Follow-ups

These are explicitly deferred to keep the refactor pure:

- Unifying log field names across protocols (e.g. reconciling `model` vs. `originalModel` vs. `resolvedModel` in log `msg`).
- Adding OpenAI-side model rename (e.g. for provider aliases).
- Generalising `CompiledProvider` to support per-pattern strategy overrides.
- Dashboard-side changes to surface the new strategy name in request detail views.
- **Final state-singleton sweep.** Remove the remaining `state = ...` mutations from existing tests not touched by the refactor steps, replacing them with constructor-injected fakes. Tracked as a separate follow-up because it's orthogonal to the architectural work (§4.4).
- Bringing `embeddings`, `models`, `count_tokens` onto the pipeline. They are trivial today and the refactor gains little from including them.

---

## 8. Acceptance Criteria

The refactor is complete when:

1. `routes/messages/handler.ts`, `routes/chat-completions/handler.ts`, and `routes/responses/handler.ts` each import only from `core/`, `composition/`, and route-local parsing helpers (per §3.8), and each is under 60 lines.
2. Dep-cruiser (authoritative) enforces the canonical state-access rule from §3.7: `packages/proxy/src/infra/state` is importable only from `infra/`, `composition/`, `strategies/support/`, and `util/`. `routes/`, `protocols/`, `core/`, `strategies/*.ts` (concretions), and `upstream/` must all be clean. Relative-path imports (e.g. `../../infra/state`) are caught by the dep-cruiser path resolution — the rule is module-path based, not text-based.
3. Dep-cruiser (authoritative) enforces `packages/proxy/src/protocols/**` purity: it may not import `util/log-emitter`, `hono/streaming`, or `node:fetch`. The additional `\bfetch\(` call-site check remains a text grep over `packages/proxy/src/protocols/` since dep-cruiser does not see call sites.
4. `pickStrategy` has table-driven tests covering all six strategy names plus the two rejection paths (OpenAI-client × Anthropic-provider, Responses-client × custom-provider); each (protocol, provider-format, model-pattern) combination the repo ships with has at least one row.
5. Full L1 passes, with test count and statement coverage **at or above** the Phase C baseline recorded in `docs/20-baseline.json`. Reference point at the time of this doc: 1232 proxy tests, 95.6% statement coverage (repo floor 90%, refactor floor 95%). The per-commit gate in §4.5 — enforced by `scripts/check-coverage.ts` at pre-commit, pre-push, and in CI — must have passed on every commit that landed during the refactor (not only the final merge).
6. Refactor E2E safety net (§4.3) passes in full on the final commit; golden SSE/log fixtures show no unjustified diffs vs. the Phase C baseline.
7. Anti-ban protocol is re-enabled for `bun run test:e2e` in Phase J, and `CLAUDE.md` reflects the restored rules.
8. `bun run gate:security` and `bun run test:ui` pass unchanged.
9. The dependency-cruiser rule set from §3.7 passes in CI.
