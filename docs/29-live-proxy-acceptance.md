# 29 · Live Proxy acceptance

This is a finite, reusable acceptance matrix for the running local Proxy and a
real Copilot account. It verifies the default rule through the public generation
endpoints. It is separate from mocked unit tests, isolated browser acceptance and
the legacy E2E suite. Live success is not isolated 6DQ evidence.

## Contract and scope

Use an active database API key bound to `builtin:copilot`. The rule must have
conversion enabled, all-day routing and one default target: the protected
Copilot upstream with `gpt-5.6-sol`. The runner reads the database without write
access and refuses a different contract. Normal Proxy authentication still
updates key usage, and generation writes ordinary request and quota records.

The selected catalog at design time declares:

| Model | Native upstream API | Chat input | Messages input | Responses input |
| --- | --- | --- | --- | --- |
| `gemini-3.8-flash` | Chat Completions | `copilot-openai-direct` | `copilot-translated` | `protocol-converted` |
| `grok-4.5` | Responses | `copilot-chat-via-responses` | `protocol-converted` | `copilot-responses` |
| `gpt-5.6-sol` | Responses | `copilot-chat-via-responses` | `protocol-converted` | `copilot-responses` |
| `claude-opus-5.5` | Messages and Chat Completions | `copilot-openai-direct` | `copilot-native` | `protocol-converted` (to Chat) |
| `auto` | Resolves to `gpt-5.6-sol` | `copilot-chat-via-responses` | `protocol-converted` | `copilot-responses` |

The machine-readable manifest is
[`scripts/lib/live-proxy-cases.ts`](../scripts/lib/live-proxy-cases.ts). It contains
66 cases with stable IDs:

| Scenario | Combinations | Cases | Required behavior |
| --- | --- | ---: | --- |
| Short text | 4 models × 3 client APIs × JSON/SSE | 24 | Preserve a case-specific marker and finish normally |
| Forced ordinary function call | 4 models × 3 client APIs × JSON/SSE | 24 | One `echo` call, nonempty call ID and exact assembled JSON arguments |
| Tool-result continuation | 4 models × 3 client APIs × JSON | 12 | Consume matched call/result history and return the tool-result marker without another tool call |
| Default `auto` | 3 client APIs × JSON/SSE | 6 | Keep incoming `auto` in telemetry while routing to `gpt-5.6-sol` |

Native text cases run first, then translated text, `auto`, tool calls and
continuations. A continuation carries synthetic prior assistant/tool turns in
one HTTP request; the harness never executes a tool or sends a hidden follow-up.
The ordinary `echo` tool has no external service or side effect. Each request has
a 1,024-token output budget and a 120-second timeout. No sampling or reasoning
override is added.

The current cached Claude model supports both Messages and Chat. The default
router preserves either native input and selects Chat for Responses conversion.
This matrix therefore verifies native Messages but not Chat → Messages or
Responses → Messages; it does not change the catalog to force those paths. Custom upstream
authentication, schedule changes, quota exhaustion, paid server tools,
multimodal input, long context, cancellation workloads and load testing are also
outside this matrix. Add separately authorized, bounded cases when those paths
need real-account evidence; mocked tests continue to cover their deterministic
contracts.

## Credentials and preparation

Start the daily Proxy separately. The runner never starts services, changes a
rule, creates/revokes a key, refreshes the catalog or changes account credentials.
An existing database stores only API-key hashes; it cannot reveal a raw key.
Obtain a known key from its private local file, or explicitly create a dedicated
key through Connect and save its one-time raw value privately.

The default credential file is `<RAVEN_CONFIG_DIR>/live-tests/key`, using Raven's
platform config directory when the override is absent. It must contain one raw
API key and have no group/other permissions (`0600` on this machine). Its parent
should be `0700`. Keep it outside the repository. Never put a raw key in a shell
argument, source, fixture or committed report. Do not use a management key or a
GitHub/Copilot token as the client API key.

The database path follows `RAVEN_DB_PATH` and Raven's platform defaults. An
explicit `--db` must identify the database used by the running Proxy. A unique
User-Agent connects each case to its persisted request; a mismatch fails the run
instead of accepting unrelated telemetry.

## Commands

Run from the repository root with Bun. Plan mode is the default and performs no
network or credential/database access:

```sh
bun run test:live
bun run test:live --case grok-4.5.messages.tool.sse
```

Check the private key, its default-rule binding, cached capabilities and the
authenticated cache-only `/v1/models` response without generating tokens:

```sh
bun run test:live --preflight
```

After explicit live-test authorization, execute the matrix:

```sh
bun run test:live --execute
```

Alternative local paths and ports can be supplied without exposing the secret:

```sh
bun run test:live --preflight \
  --key-file '/absolute/private/key-file' \
  --db '/absolute/private/raven.db' \
  --url 'http://127.0.0.1:7024'
```

The URL must be a loopback origin. Generation and preflight reject HTTP redirects.
These service calls are internal; use `https://raven.dev.hexly.ai` for the human
Dashboard preview.

## Failure handling and authorized reruns

Each invocation sends at most one Proxy generation request per selected case,
sequentially, and stops on the first HTTP, stream, output or telemetry failure.
Later cases remain `not_run`. There is no harness retry, broad legacy-suite
invocation or automatic golden replacement. Normal Proxy behavior, including
existing same-provider credential replay, is exercised unchanged; every observed
upstream attempt is recorded in the result.
The runner stops after observing more than one upstream attempt even when the
Proxy's final response succeeds. It never sends the next case after a replay.

Preserve the initial report. Inspect the failed response and correlated request,
add an offline regression for a production defect, and fix its shared cause.
When reruns are authorized, select the failed case explicitly:

```sh
bun run test:live --execute --case grok-4.5.messages.tool.sse
```

Repeat `--case` to select a finite subset. Duplicate IDs are sent only once, in
manifest order. Each invocation creates a new report directory, so a later pass
cannot overwrite an earlier failure. In the 2026-09-22 routing-refactor task the
owner explicitly authorized retries; this does not change the repository's
default live-diagnostic policy for future tasks.

## Evidence and assertions

Reports live under `<RAVEN_DATA_DIR>/live-tests/runs/`, with platform defaults when
the override is absent. Each run has a private directory (`0700`) and atomically
checkpointed `report.json` (`0600`), including a `running` entry before each send.
Interrupted work therefore cannot be confused with a completed pass.

The report contains the Git revision and dirty flag, runtime, public key identity,
rule/cached-endpoint snapshot, exact synthetic requests, response bodies or SSE
frames, timing, failures and explicitly unrun cases. It excludes request
authentication headers and raw keys; the supplied key is also redacted from
serialized errors and response text.

Each successful case checks:

- The correct JSON/SSE content type, protocol envelope, text/tool marker and
  terminal reason. Chat requires `[DONE]` after a finish reason; Messages requires
  ordered message/block lifecycle events; Responses requires creation and a
  successful completed response matching the accumulated text/tool deltas.
- Tool-call IDs, function names and complete JSON arguments after chunk assembly.
  Continuation request histories preserve the matching call/result ID.
- Exactly one persisted Proxy request with the case's unique User-Agent, expected
  key, inbound model/protocol, strategy and upstream protocol.
- The expected protected rule/upstream and admitted model. The upstream's echoed
  response model is retained separately and need not equal the selected raw ID.
- Consecutive actual upstream attempt ordinals, one captured window/time/multiplier,
  observed usage, healthy settlement and agreement between token buckets, weighted
  attempt debits and the request's routing total. Missing usage buckets remain
  nullable; incomplete usage is reported honestly rather than silently coerced
  to zero or rejected merely for being partial.

The runner's own offline suite uses per-test temporary SQLite, synthetic keys and
mocked or loopback fixture HTTP. It exercises protocol errors, truncated streams,
fail-fast behavior, redirect refusal, stalled-body cancellation, late telemetry
and private CLI artifacts. It never loads a real account or calls Copilot:

```sh
VITEST_MAX_WORKERS=2 bunx --bun vitest run --project scripts \
  scripts/lib/__tests__/live-proxy-wire.test.ts \
  scripts/lib/__tests__/live-proxy-runner.test.ts
```

Keep the normal coverage, type, lint and commit gates unchanged. Neither a plan
nor a preflight is evidence of a successful real generation request.
