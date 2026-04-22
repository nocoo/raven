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
- Anti-ban invariants (1 request per E2E test, fail-fast). **Suspended during the refactor** (§1.2) and **restored in Step 10**.
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

- `routes/` may import only `core/`, `infra/middleware`, and Hono.
- `strategies/` may import `protocols/`, `strategies/support/`, `upstream/`, `core/context`, `infra/state` (read-only), `util/log-emitter`.
- `strategies/support/` may import `protocols/`, `infra/state`, `util/log-emitter`, `lib/server-tools/*`. This is the only place in the post-refactor tree where "impure protocol helpers" live.
- `protocols/` is strictly pure. No `state` import. No `fetch`. No `logEmitter`. No `hono/streaming`. CI check: `grep -rE "from.*(lib/state|util/log-emitter|hono/streaming)" src/protocols/` must be empty.
- `upstream/` is the only layer allowed to call `fetch`. It accepts config via constructor, never touches `state` at call time.
- `core/` may not import `strategies/` or `upstream/` concretions — only interfaces.

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

Layering update (replaces the relevant bullet in §3.7):

- `routes/` may import `core/`, `composition/`, `infra/middleware`, and Hono. **Not** `strategies/` or `upstream/`.
- `composition/` is the only module allowed to import concretions from both `strategies/` and `upstream/`.
- `core/` still does not depend on `strategies/` or `upstream/`.

Handler shape after refactor (Step 5) becomes:

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
- Golden files are captured once on `main` before Step 1 and diffed on every run; any diff requires a justified review.

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

1. **Global floor.** Proxy L1 statement coverage must stay **≥ 95.0%** at every commit. Baseline recorded in `docs/20-baseline.json` (Step 0) is the numeric source of truth; no commit may regress it by more than 0.1 absolute percentage points without a §7 waiver.
2. **New-module floor.** Any file created under `core/`, `protocols/`, `strategies/`, `upstream/`, or `composition/` ships with **≥ 95% statement coverage and 100% branch coverage on public exports** in the same commit that introduces it. A new file without matching tests fails the commit.
3. **Pure-zone stricter floor.** `protocols/` and `core/router.ts` require **100% branch coverage**. These are pure, small, and high-value — there is no excuse for an uncovered branch.
4. **Runner streaming paths.** `core/runner.ts` must cover, at minimum: (a) JSON success, (b) stream success, (c) stream error thrown mid-flight (per protocol via fake strategy), (d) upstream rejection before stream open, (e) `finally` log emission on both success and error. Missing any of these fails the commit.
5. **Enforcement mechanism.** `scripts/check-coverage.ts` (added in commit 0.2) runs at pre-commit as part of L1; it reads `docs/20-baseline.json`, compares current `bun run test --coverage` output, and blocks commits that regress the global floor or land new files without coverage. The same script runs in CI and at pre-push.
6. **Test-count floor.** Total proxy L1 test count must only decrease when the net change in the commit deletes code or merges duplicate tests; it may not decrease merely because tests were removed without replacement. Tests deleted as part of the state-mutation migration (§4.4) must be replaced by injection-based equivalents in the same commit.

The practical consequence: a commit like "extract Runner" (1.2) that does not also land `test/core/runner.test.ts` will not pass its own pre-commit hook. Every atomic commit is self-contained — its tests live with it.

---

## 5. Migration Plan

### 5.0 Atomic-commit convention

Each Step below is not a single PR but a **numbered series of atomic commits** `N.1`, `N.2`, …. Rules:

- **Atomic.** Each commit is independently revertible. Reverting 3.4 must not require reverting 3.5.
- **Green on its own.** Each commit passes: `bun run test` (L1), `bun run typecheck`, `bun run lint`, `scripts/check-coverage.ts` (§4.5), and — for commits that touch handler/strategy/upstream/composition code — the refactor E2E safety net (§4.3).
- **Tests co-located.** A commit that adds a new module also adds its tests in the same commit. "Code in one commit, tests in the next" is forbidden.
- **Message prefix.** `refactor(N.M): <imperative summary>`. Body explains what the commit does, what it does not do, and which follow-up commit picks up deferred work.
- **PR grouping.** A Step may land as one PR (all commits together) or as a sequence of small PRs; the commit chain within a PR must still be atomic and individually green.
- **No behaviour change without marker.** Non-mechanical commits carry `refactor(N.M)!:` (breaking-marker) and document the observable delta in the body.
- **Numbering gap policy.** If a commit is abandoned mid-Step, keep the gap — do not renumber. Downstream references stay stable.

Every Step's first commit is a test/fixture-only commit (`N.0`) that locks the pre-Step behaviour with characterisation tests before any production code moves. The final commit of each Step (`N.last`) re-runs the full §4.3 safety net and records the diff (expected: no diff) in the PR description.

### Step 0 — Build the E2E safety net and record baseline

- **0.1** Add `test/e2e/refactor/` skeleton, `bun run test:e2e:full` script, and the scenario matrix from §4.3 as empty `.skip` tests. No real requests yet.
- **0.2** Add `scripts/check-coverage.ts` (§4.5 enforcement) and wire it into pre-commit L1; gate passes at current 95.6%.
- **0.3** Implement `CopilotNative` scenarios (2 models × {stream, non-stream, tool_use, web_search}); capture golden SSE traces and `request_end` fixtures under `test/e2e/refactor/__golden__/copilot-native/`.
- **0.4** Implement `CopilotTranslated` scenarios; capture goldens.
- **0.5** Implement `CopilotOpenAIDirect` scenarios; capture goldens.
- **0.6** Implement `CopilotResponses` scenarios (including `response.failed`); capture goldens.
- **0.7** Implement `CustomOpenAI` scenarios (requires two test providers configured); capture goldens.
- **0.8** Implement `CustomAnthropic` scenarios; capture goldens.
- **0.9** Commit `docs/20-baseline.json` with the measured proxy L1 test count, proxy L1 statement coverage (global + per-directory), and dashboard L1 test count. Ensure all §4.3 scenarios green on `main`.
- Gate: every subsequent commit in Steps 1–10 runs the full safety net in its PR pipeline.

### Step 1 — Extract Runner (mechanical)

- **1.0** Characterisation tests: capture current streaming behaviour of all three handlers as inline fixture tests so regressions surface locally even without E2E.
- **1.1** Introduce `core/runner.ts` skeleton with the `execute()` signature (§3.5), plus `test/core/runner.test.ts` covering the five paths enumerated in §4.5(4) against a fake strategy. New module ships with ≥95% coverage.
- **1.2** Introduce `core/stream-runner.ts` (SSE read/write helpers); add tests; no callers yet.
- **1.3** Port `routes/chat-completions/handler.ts` default branch onto Runner via a local `Strategy`-shaped shim. Migrate the affected tests to the injection style per §4.4(3).
- **1.4** Port `routes/chat-completions/handler.ts` custom-upstream passthrough branch onto Runner.
- **1.5** Port `routes/messages/handler.ts` default Copilot branch onto Runner.
- **1.6** Port `routes/messages/handler.ts` custom OpenAI-upstream branch onto Runner.
- **1.7** Port `routes/messages/handler.ts` Anthropic passthrough branch onto Runner.
- **1.8** Port `routes/responses/handler.ts` onto Runner.
- **1.9** Remove dead code paths that duplicated the streaming template; rerun §4.3 and record no-diff.
- Expected cumulative delta: −400 lines, +200 lines. No behaviour change.
- Risk: low. Each sub-commit regresses only one handler branch if broken.

### Step 2 — Relocate protocols and impure helpers (mechanical, import-only)

- **2.0** Characterisation: snapshot each file's public exports before the move (so `git mv` diffs are verifiable).
- **2.1** `git mv` `routes/messages/{preprocess, anthropic-types}.ts` → `protocols/anthropic/`.
- **2.2** `git mv` `routes/messages/{non-stream-translation, stream-translation}.ts` → `protocols/translate/`. Rename `consumeStreamToResponse` file to `protocols/translate/consume-stream.ts`.
- **2.3** `git mv` `routes/messages/{effort-fallback, server-tools, model-capabilities}.ts` → `strategies/support/` (not `protocols/` — they read `state` and emit logs).
- **2.4** Extract `streamAnthropicResponse` into `strategies/support/anthropic-stream-writer.ts` with tests.
- **2.5** Extract Responses resolvedModel/usage parsers into `protocols/responses/stream-state.ts` with tests.
- **2.6** Update all importers (mechanical). Verify `grep -rE "from.*(lib/state|util/log-emitter|hono/streaming)" src/protocols/` is empty.
- Risk: low. Import-only.

### Step 3 — Extract UpstreamClient

- **3.0** Characterisation tests: record current request shapes (headers, body, URL, proxy) for every upstream call via MSW-style capture.
- **3.1** Add `upstream/interface.ts` with `UpstreamClient<Req, Resp>`; add contract tests.
- **3.2** Port `services/copilot/create-chat-completions.ts` → `upstream/copilot-openai.ts` with constructor-injected config (token getter, baseURL, proxy resolver). Tests assert against captured fixtures from 3.0.
- **3.3** Port `services/copilot/create-native-messages.ts` → `upstream/copilot-native.ts`.
- **3.4** Port `services/copilot/create-responses.ts` → `upstream/copilot-responses.ts`.
- **3.5** Port `services/copilot/create-embeddings.ts` → `upstream/copilot-embeddings.ts`.
- **3.6** Port `services/upstream/send-openai.ts` → `upstream/custom-openai.ts`.
- **3.7** Port `services/upstream/send-anthropic.ts` → `upstream/custom-anthropic.ts`.
- **3.8** Introduce a minimal upstream factory that reads `state` once at request start; handlers switch to it. Delete the old `services/` shims once unreferenced.
- **3.9** Run §4.3. Manual L2 smoke per upstream type.
- Risk: medium (touches every outbound call).

### Step 4 — Extract Router

- **4.0** Add temporary trace logging inside existing handlers; capture every `(protocol, model, providers[], modelsCatalog) → decision` observed in L1 + §4.3 runs into `test/core/router.fixtures.json`.
- **4.1** Add `core/router.ts::pickStrategy` with `StrategyDecision` type (§3.2). Add `test/core/router.test.ts` driven by `router.fixtures.json`; require 100% branch coverage (§4.5(3)).
- **4.2** Wire `routes/chat-completions/handler.ts` to call `pickStrategy` and switch on `decision.name`; preserve existing code paths.
- **4.3** Wire `routes/messages/handler.ts` to `pickStrategy`.
- **4.4** Wire `routes/responses/handler.ts` to `pickStrategy`.
- **4.5** Remove the temporary trace logging from 4.0.
- Risk: medium.

### Step 5 — Introduce Strategy objects and composition root

- **5.0** Characterisation: capture `describeEndLog` field bags per protocol from live runs into `test/strategies/__fixtures__/`.
- **5.1** Add `composition/upstream-registry.ts`; tests cover every upstream kind.
- **5.2** Add `strategies/copilot-openai-direct.ts` (simplest — no translation). Full 7-method implementation + tests hitting `describeEndLog`, `adaptStreamError`, `initStreamState` against captured fixtures. ≥95% coverage.
- **5.3** Add `strategies/copilot-native.ts` + tests.
- **5.4** Add `strategies/copilot-translated.ts` + tests (this is the largest; translation lives in L5 `protocols/translate/`).
- **5.5** Add `strategies/copilot-responses.ts` + tests.
- **5.6** Add `strategies/custom-openai.ts` + tests (both OpenAI-client passthrough and Anthropic-client translated modes).
- **5.7** Add `strategies/custom-anthropic.ts` + tests.
- **5.8** Add `composition/strategy-registry.ts::buildStrategy` + tests covering all six ok branches and both reject branches.
- **5.9** Add `composition/index.ts::dispatch` + integration tests.
- **5.10** Switch `routes/chat-completions/handler.ts` to the `buildContext → composition.dispatch` shape (§3.8). Target handler size ≤ 25 lines.
- **5.11** Switch `routes/messages/handler.ts` to the composition shape. Target ≤ 30 lines.
- **5.12** Switch `routes/responses/handler.ts` to the composition shape. Target ≤ 25 lines.
- **5.13** Delete now-orphan `Strategy`-shim code introduced in Step 1. Run §4.3 with golden-file diff (expected: none).
- Risk: medium-high. This is where the old duplication actually dies.

### Step 6 — Server-tool decorator

- **6.1** Add `strategies/support/server-tools.ts::decorate(strategy, options)` + tests for enabled/disabled paths.
- **6.2** Replace the `if (serverToolContext.hasServerSideTools && webSearchEnabled)` branch in `strategies/copilot-translated.ts` (and any other affected strategy) with `decorate(...)`.
- **6.3** Run existing server-tool tests; run §4.3 `web_search` scenarios.

### Step 7 — Remove dead path

- **7.1** Extend `pickStrategy` to reject `(OpenAI client, Anthropic provider)` and `(Responses client, custom provider)` with typed `StrategyDecision.reject`. Update `test/core/router.test.ts`.
- **7.2** Add a central error mapper that converts `decision.reject` into a 400 response with the original message/type.
- **7.3** Delete the inline 400 branch from `routes/chat-completions/handler.ts`.

### Step 8 — Symmetric model preprocessing

- **8.1** Move `translateModelName` into L4 (`protocols/anthropic/preprocess.ts` already holds it after Step 2; this commit ensures it runs **before** `pickStrategy` for both entries).
- **8.2** Route OpenAI entry through the same preprocess step (no-op today; placeholder for future aliases).
- **8.3** Update `pickStrategy` callers to use the normalised `ctx.model`. Add a router test that pins the fix for the §2.2(7) latent bug.

### Step 9 — Enforce layering

- **9.1** Add `dependency-cruiser.config.cjs` encoding the §3.7 + §3.8 rules.
- **9.2** Add `bun run gate:arch` script; hook into pre-push (G1 tier).
- **9.3** Add grep-based CI check for `protocols/` purity (§3.7).

### Step 10 — Cleanup and restore anti-ban

- **10.1** Delete `routes/messages/native-handler.ts` (folded into `strategies/copilot-native.ts`).
- **10.2** Delete `routes/*/handler.ts`-local helpers now duplicated by `protocols/` / `strategies/` / `core/`.
- **10.3** Remove `consumeStreamToResponse` re-exports; update consumers to `protocols/translate/consume-stream.ts`.
- **10.4** Revert `test/e2e/` back to anti-ban rules (1 request per test, fail-fast); keep `test/e2e/refactor/` as the opt-in `bun run test:e2e:full` target.
- **10.5** Update `CLAUDE.md` to reflect restored anti-ban rules and the new architecture.
- **10.6** Final §4.3 run; record no-diff against Step 0 baseline in the closing PR description.

---

## 6. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Silent change to SSE event ordering | medium | high (breaks downstream clients) | Golden-file tests on chunk sequences per strategy before Step 5; diff after. |
| Token accounting drift during extraction | low | high (affects billing/usage UI) | Token/usage bookkeeping is held in `StreamState` and surfaced via `describeEndLog`; add unit tests for each strategy's `describeEndLog` seeded from recorded fixtures. |
| Global `state` refactor breaking SOCKS5 or token refresh | medium | medium | Step 3 defers `state` reads to request start, not module load; keep the singleton's lifecycle unchanged. |
| Test-suite churn blocks merges | medium | medium | Each step is independently mergeable; import-only edits in Steps 1–3 keep tests green. |
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
2. Grepping `import.*from.*lib/state` outside `infra/`, `strategies/support/`, `strategies/*.ts` (read-only), and `util/` yields zero hits in `routes/`, `protocols/`, `core/`, and `upstream/`.
3. Grepping `from.*util/log-emitter|from.*hono/streaming|from.*node:fetch|\\bfetch\\(` inside `src/protocols/` yields zero hits.
4. `pickStrategy` has table-driven tests covering all six strategy names plus the two rejection paths (OpenAI-client × Anthropic-provider, Responses-client × custom-provider); each (protocol, provider-format, model-pattern) combination the repo ships with has at least one row.
5. Full L1 passes, with test count and statement coverage **at or above** the Step 0 baseline recorded in `docs/20-baseline.json`. Reference point at the time of this doc: 1232 proxy tests, 95.6% statement coverage (repo floor 90%, refactor floor 95%). The per-commit gate in §4.5 — enforced by `scripts/check-coverage.ts` at pre-commit, pre-push, and in CI — must have passed on every commit that landed during the refactor (not only the final merge).
6. Refactor E2E safety net (§4.3) passes in full on the final commit; golden SSE/log fixtures show no unjustified diffs vs. the Step 0 baseline.
7. Anti-ban protocol is re-enabled for `bun run test:e2e` in Step 10, and `CLAUDE.md` reflects the restored rules.
8. `bun run gate:security` and `bun run test:ui` pass unchanged.
9. The dependency-cruiser rule set from §3.7 passes in CI.
