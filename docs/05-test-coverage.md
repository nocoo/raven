# 05 — Proxy Test Coverage: Hot Path to Full Coverage

## Background

Raven proxy handles high-volume concurrent requests — every code path directly impacts throughput and correctness. Static analysis identifies three heat tiers:

| Tier | Description | Frequency |
|------|-------------|-----------|
| 🔥 HOT | Per-chunk — executes hundreds to thousands of times per streaming request | `sse.ts events()`, `stream-translation.ts`, JSON parse/stringify in handlers |
| 🟠 WARM | Per-request — executes once per API call | `middleware.ts`, handlers, `create-chat-completions.ts`, `rate-limit.ts`, `non-stream-translation.ts`, `log-emitter.ts`, `request-sink.ts` |
| 🧊 COLD | Startup or admin — executes once at boot or on manual action | `db/requests.ts initDatabase`, `db/keys.ts initApiKeys`, `services/github/*` |

### Current state (371 tests, 672 assertions) — ✅ COMPLETE

**All 40 source files at 95%+ line coverage. Overall: 99.56%.**

| Module | Heat | Line coverage | Status |
|--------|------|---------------|--------|
| `util/sse.ts` | 🔥 | 100% | ✅ Phase 1c |
| `routes/messages/stream-translation.ts` | 🔥 | 100% | ✅ Phase 1a |
| `routes/messages/non-stream-translation.ts` | 🟠 | 98.50% | ✅ Phase 1b |
| `middleware.ts` | 🟠 | 100% | ✅ Pre-existing |
| `util/log-emitter.ts` | 🟠 | 100% | ✅ Pre-existing |
| `db/request-sink.ts` | 🟠 | 100% | ✅ Pre-existing |
| `db/keys.ts` | 🧊 | 100% | ✅ Pre-existing |
| `db/requests.ts` | 🧊 | 99.38% | ✅ Phase 1d |
| `routes/chat-completions/handler.ts` | 🟠 | 100% | ✅ Phase 2g |
| `routes/messages/handler.ts` | 🟠 | 100% | ✅ Phase 2h |
| `lib/rate-limit.ts` | 🟠 | 100% | ✅ Phase 2b |
| `services/copilot/create-chat-completions.ts` | 🟠 | 100% | ✅ Phase 2d |
| `lib/tokenizer.ts` | 🟠 | 99.14% | ✅ Phase 2e |
| `routes/messages/count-tokens-handler.ts` | 🟠 | 100% | ✅ Phase 2f |
| `util/id.ts` | 🟠 | 100% | ✅ Phase 2c |
| `lib/utils.ts` | 🧊 | 100% | ✅ Phase 3b |
| `routes/copilot-info.ts` | 🧊 | 96.97% | ✅ Phase 3b |
| `routes/messages/utils.ts` | 🟠 | 100% | ✅ Phase 3b |
| `routes/messages/route.ts` | 🟠 | 100% | ✅ Phase 3b |
| `routes/chat-completions/route.ts` | 🟠 | 100% | ✅ Phase 3b |
| `routes/stats.ts` | 🧊 | 100% | ✅ Phase 3b |
| `routes/models/route.ts` | 🟠 | 100% | ✅ Phase 3a |
| `routes/embeddings/route.ts` | 🟠 | 100% | ✅ Phase 3a |
| `services/get-vscode-version.ts` | 🧊 | 95.83% | ✅ Phase 3a |
| `services/copilot/create-embeddings.ts` | 🧊 | 100% | ✅ Phase 3a |
| `services/copilot/get-models.ts` | 🧊 | 100% | ✅ Phase 3a |
| `services/github/get-copilot-usage.ts` | 🧊 | 100% | ✅ Phase 3a |
| `util/logger.ts` | 🟠 | 95.65% | ✅ Phase 3a |
| `util/params.ts` | 🟠 | 100% | ✅ Pre-existing |
| `lib/api-config.ts` | 🧊 | 100% | ✅ Pre-existing |
| `lib/error.ts` | 🟠 | 100% | ✅ Pre-existing |
| `lib/state.ts` | 🧊 | 100% | ✅ Pre-existing |
| `routes/keys.ts` | 🧊 | 100% | ✅ Pre-existing |
| `routes/requests.ts` | 🧊 | 97.44% | ✅ Pre-existing |
| `routes/connection-info.ts` | 🧊 | 100% | ✅ Pre-existing |
| `config.ts` | 🧊 | 100% | ✅ Pre-existing |
| `app.ts` | 🧊 | 100% | ✅ Pre-existing |
| `ws/logs.ts` | 🧊 | 100% | ✅ Pre-existing |
| `util/log-event.ts` | 🧊 | 100% | ✅ Pre-existing |

### Target

**95%+ line coverage on all proxy source files**, prioritized by heat tier.

---

## Strategy

**Phase 1 — Push existing hot-path tests to 95%+** (low risk, high value)
These modules already have 91–94% coverage. A few targeted tests close the gaps.

**Phase 2 — Cover zero-coverage warm-path modules** (medium effort)
The handler layer, rate limiter, upstream service, and tokenizer need mocked unit tests.

**Phase 3 — Sweep remaining cold-path gaps to 95%** (cleanup)
Ensure `db/requests.ts` asc cursor, `utils.ts`, `id.ts`, etc. hit threshold.

If test infrastructure needs refactoring to support handler testing (e.g., a mock for `createChatCompletions`, shared test fixtures for `state`), do it as a dedicated commit before writing handler tests.

---

## Phase 1 — Hot Path Gaps (91–94% → 95%+)

### Commit 1a: `stream-translation.ts` → 95%+

**File:** `test/translate/stream.test.ts`

Missing coverage:
- `translateErrorToAnthropicErrorEvent()` — zero tests (lines 180–186)
- Tool → text transition: `isToolBlockOpen()` returns true, delta.content arrives, must close tool block then open text block (lines 60–68)
- Edge: chunk with `finish_reason` while a tool block is still open

Tests to add:
```
describe("translateErrorToAnthropicErrorEvent")
  - returns error event with overridden_response type
  - includes message and error type in payload

describe("tool → text interleaving")
  - tool block open, then delta.content arrives → close tool + open text
  - multiple tool→text→tool transitions in sequence

describe("finish while tool block open")
  - finish_reason arrives while tool_use block is open → close block + message_delta + message_stop
```

### Commit 1b: `non-stream-translation.ts` → 95%+

**File:** `test/translate/anthropic-to-openai.test.ts`

Missing coverage:
- `claude-opus-4-20260301` → `claude-opus-4` model name normalization (line 54)
- `content_filter` stop reason in translateToAnthropic (line ~280)
- `mapContent` when content is array of ContentPart (lines 209–211)

Tests to add:
```
describe("translateModelName")
  - claude-opus-4-20260301 → claude-opus-4
  - claude-opus-4 (no date suffix) → unchanged

describe("translateToAnthropic edge cases")
  - response with array-of-ContentPart content
```

### Commit 1c: `sse.ts` → 95%+

**File:** `test/util/sse.test.ts`

Missing coverage:
- `parseSSEStream`: remaining buffer processing when stream ends mid-event (lines 90–95)
- `events()`: unknown SSE field names are silently ignored (spec compliance)
- `events()`: data field with empty value `data:\n\n` → yields `{ data: "" }`

Tests to add:
```
describe("parseSSEStream edge cases")
  - stream ends with partial data in buffer (no trailing \n\n)

describe("events edge cases")
  - unknown field name is ignored
  - empty data value → { data: "" }
  - only-comments stream yields nothing
```

### Commit 1d: `db/requests.ts` → 95%+

**File:** `test/db/requests.test.ts`

Missing coverage:
- `queryRequests` with `order: "asc"` cursor pagination (lines 169–176)

Tests to add:
```
describe("queryRequests cursor pagination")
  - asc order with cursor returns correct next page
```

---

## Phase 2 — Zero-Coverage Warm Path

### Commit 2a: Test infrastructure — shared mocks and fixtures

**New file:** `test/helpers/mock-state.ts`

Create reusable test utilities:
- `mockState()` — returns a `State` object with valid test defaults
- `mockChatCompletionsResponse()` — returns a mock non-streaming response
- `mockChatCompletionsStream()` — returns a mock async generator of SSE events
- Helper to reset global `state` between tests

**New file:** `test/helpers/mock-fetch.ts`

- `mockFetch(responses)` — replaces `globalThis.fetch` with a mock that returns configured responses in order
- Auto-cleanup via `afterEach`

### Commit 2b: `lib/rate-limit.ts` — all 5 branches

**New file:** `test/lib/rate-limit.test.ts`

**Source:** `src/lib/rate-limit.ts` (40 lines, 5 branches)

Branches to cover:
```
1. rateLimitSeconds undefined → return immediately (no-op)
2. No lastRequestTimestamp → set timestamp, return
3. Elapsed > limit → update timestamp, return
4. Under limit + rateLimitWait=false → throw HTTPError 429
5. Under limit + rateLimitWait=true → sleep until limit, then continue
```

All branches are testable by constructing a `State` object with specific field values. Branch 5 requires mocking or short sleep durations (set `rateLimitSeconds` to 0.01).

### Commit 2c: `util/id.ts` — format, uniqueness, sortability

**New file:** `test/util/id.test.ts`

**Source:** `src/util/id.ts` (14 lines)

Tests:
```
- returns string of expected length
- format matches expected pattern (timestamp prefix + random suffix)
- two sequential calls produce different IDs
- IDs sort chronologically (earlier call < later call)
- generates 1000 IDs without collision
```

### Commit 2d: `services/copilot/create-chat-completions.ts`

**New file:** `test/services/create-chat-completions.test.ts`

**Source:** `src/services/copilot/create-chat-completions.ts` (45 lines of logic)

Requires mocking `globalThis.fetch` and setting `state.copilotToken`.

Branches:
```
- throws when copilotToken is missing
- sends correct headers (copilotHeaders + X-Initiator)
- X-Initiator: "user" when no assistant/tool messages
- X-Initiator: "agent" when assistant messages present
- copilot-vision-request header when image content present
- non-stream: returns parsed JSON response
- stream: returns async generator from events()
- throws HTTPError on non-ok response
```

### Commit 2e: `lib/tokenizer.ts` — core encoding and counting

**New file:** `test/lib/tokenizer.test.ts`

**Source:** `src/lib/tokenizer.ts` (348 lines)

Priority tests (cover main paths, skip exhaustive encoder variants):
```
describe("getTokenizerFromModel")
  - known model → returns correct encoder name
  - unknown model → returns fallback encoder
  - encoder is cached after first load

describe("getTokenCount")
  - simple text messages → returns token count > 0
  - messages with tool_calls → includes tool token overhead
  - messages with image_url → counts image at fixed rate
  - input/output split is correct (user/system = input, assistant = output)
  - empty messages array → returns 0

describe("numTokensForTools")
  - tools with properties → counts correctly
  - tools with enum parameters → counts enum values
  - no tools → returns 0
```

### Commit 2f: `routes/messages/count-tokens-handler.ts`

**New file:** `test/routes/count-tokens-handler.test.ts`

**Source:** `src/routes/messages/count-tokens-handler.ts` (68 lines)

Requires mocking `state.models` and the tokenizer.

Tests:
```
- known model → returns token count with model info
- unknown model → returns fallback count of 1
- Claude model → applies tool overhead (+346 tokens, ×1.15)
- Grok model → applies tool overhead (+480 tokens, ×1.03)
- MCP tool (mcp__ prefix) → skips tool overhead
- tokenizer throws → returns fallback count of 1
```

### Commit 2g: `routes/chat-completions/handler.ts`

**New file:** `test/routes/chat-completions-handler.test.ts`

**Source:** `src/routes/chat-completions/handler.ts` (150 lines)

Requires mock `createChatCompletions` (via module mock or DI refactor), mock `state`, and Hono test client.

Tests:
```
describe("non-streaming")
  - returns JSON response with correct shape
  - emits request_start and request_end log events
  - records latency in log event data
  - extracts usage metrics from response

describe("streaming")
  - returns SSE stream
  - forwards chunks from upstream
  - extracts model and usage from final chunk
  - emits request_end on stream completion

describe("error handling")
  - upstream error → emits upstream_error + request_end with error status
  - token count failure is non-fatal (swallowed)

describe("request enrichment")
  - fills max_tokens from model capabilities when not set
  - preserves max_tokens when explicitly set
```

### Commit 2h: `routes/messages/handler.ts`

**New file:** `test/routes/messages-handler.test.ts`

**Source:** `src/routes/messages/handler.ts` (160 lines)

Same testing approach as commit 2g, plus:
```
describe("protocol translation")
  - Anthropic request is translated to OpenAI format
  - non-streaming: OpenAI response translated back to Anthropic

describe("streaming")
  - OpenAI stream chunks translated to Anthropic SSE events
  - [DONE] marker terminates stream
  - skips empty data chunks

describe("logging")
  - request_start includes messageCount and toolCount
  - request_end includes translatedModel
```

---

## Phase 3 — Sweep to 95%

### Commit 3a: Remaining utility and service gaps

Files to cover:
- `lib/utils.ts` — `isNullish`, `sleep` (trivial but add for completeness)
- `routes/messages/utils.ts` — ensure `mapOpenAIStopReasonToAnthropic` is directly tested (currently indirect)
- `services/copilot/create-embeddings.ts` — mock test for embeddings call
- `services/get-vscode-version.ts` — mock test with fallback behavior

### Commit 3b: Coverage enforcement

- Add `--coverage` flag to `bun run test` script
- Verify all source files report ≥95% line coverage
- Document coverage thresholds in `CLAUDE.md`

---

## Test Infrastructure Notes

### Mocking strategy for handlers

The two handlers (`chat-completions/handler.ts`, `messages/handler.ts`) import `createChatCompletions` and `state` as module-level singletons. Testing options:

1. **Module-level mock** — Use `bun:test` `mock.module()` to replace `create-chat-completions` with a mock. This is the least invasive approach and doesn't require refactoring production code.
2. **Global state mutation** — Set `state.copilotToken`, `state.models` etc. directly in test setup. This is already the established pattern in `app.test.ts`.
3. **Hono test client** — Use `app.request()` from the Hono test utilities to send requests through the full middleware + handler chain.

Recommended: option 1 + 2 + 3 combined. This tests the real middleware chain while controlling upstream behavior.

### Performance test baseline

After Phase 1, re-run `bun run test:perf` and record baseline numbers in `CLAUDE.md` for regression detection:
- `parseSSELine` throughput (MB/s)
- `parseSSEStream` throughput (MB/s)
- Request translation latency (ms/op)
- Stream translation latency (ms/chunk)
