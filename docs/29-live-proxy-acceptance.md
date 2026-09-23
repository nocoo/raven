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
GitHub/Copilot token as the client API key. Alternatively, pass `--key-stdin`
and supply the key through a non-echoing input pipe; no credential file is needed.
Do not combine it with `--key-file`.

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

After explicit live-test authorization and a clean committed checkout, start a
temporary guarded Proxy in a separate terminal. It reads the existing configuration,
keys and default rule, uses the same SQLite for normal request/quota accounting,
and obtains one Copilot credential. It does not migrate data, refresh the catalog,
start periodic authentication, or modify the daily server. The credential exchange
and cache-only preflight also count against the stated request budget. One local
management read obtains the daily Proxy's effective editor/plugin versions,
preserving its request headers without an external version lookup. That read also
counts against the budget, and requires the daily Proxy to be running.

```sh
bun run scripts/live-proxy-sidecar.ts --execute --limit 66
bun run test:live --execute --url 'http://127.0.0.1:PORT_PRINTED_ABOVE'
```

Both commands accept `--key-stdin` or `--key-file`. The sidecar validates the
existing database key before HTTP and uses its supported read-only management
access to obtain version headers. Database-key generation auth stays unchanged.
If environment keys are absent, a random in-memory management credential prevents
the temporary sidecar from entering no-key management mode. No key is persisted
or created in the database. If the daily server uses an environment file, load
that same file with Bun's `--env-file=/absolute/path` flag.

Stop the sidecar with Ctrl-C after the run. The live runner refuses generation
against a server without the guard header or with a different source revision.
The sidecar bounds actual sends per incoming request and per run, refuses token
refresh/discovery/other-upstream calls during generation, and closes its outbound
guard at the first HTTP or transport error. Normal authentication, default-rule
selection, protocol processing and accounting still execute. Replay behavior is
deliberately excluded from live acceptance and remains covered offline.

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
invocation or automatic golden replacement. The sidecar blocks a second upstream
send before it reaches the network. The runner additionally rejects multiple
accounted attempts and never sends the next case after a failure.

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
  Native Chat JSON and SSE may omit `object`, matching the v2.6.0 passthrough contract;
  incorrect discriminators and missing converted discriminators still fail.
  Native Messages may end with one eventless `[DONE]` after `message_stop`, as
  Copilot's native stream does. It cannot replace message completion, appear
  early, repeat, hide an error event or allow subsequent data.
  Converted Responses streams emit the creation, output-item, content/tool and
  completion lifecycle with stable IDs, indices and sequence numbers, following
  the [official streaming contract](https://developers.openai.com/api/reference/resources/responses).
  Completion waits for DONE or normal EOF so usage trailers remain available;
  missing finish reasons fail and length/filter stops stay explicitly incomplete.
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
  Converted streaming Chat without a usage request and without a quota window
  may have no observed usage; its settlement must explicitly remain incomplete.

Reports include a sanitized `native_evidence` list only for successful native
text cases with one accounted attempt. Converted successes, `auto`, tools and
failed/unrun cases cannot certify native protocol support. Review that list before
updating `packages/proxy/src/core/protocol-evidence.ts`; preserve the raw private
report. JSON evidence never certifies SSE and text evidence never certifies tools.

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

## Native evidence captured on 2026-09-23

The shipped mapping contains ten native text observations: JSON and SSE for
Gemini Chat, Grok Responses, GPT Responses, and Claude Chat and Messages. It does
not certify translated paths or tool calls. Adding these observations preserves
the selected routes for the captured catalog in both streaming modes.

Private source reports under the runs directory are preserved unchanged:

- `2026-09-23T01-55-57-825Z-31zYE3/report.json`, SHA-256
  `0481f5b0a3b9693f91da2d90c94a77dd9bdc2abfb0913c99f78b871590ef16b3`.
  Gemini JSON passed originally. Gemini SSE passed an offline capture review
  with validator `0fa3077b7bf2d0518777cfd715198ae42bbf2e5c` after correcting the
  missing native discriminator assumption.
- `2026-09-23T02-02-25-381Z-q6btXX/report.json`, SHA-256
  `c14bcf4f1986b3fcb9fcf84a262cfeff673e03746d552dd258e6063f6abaf07b`.
  Seven cases passed originally. Claude Messages SSE passed an offline capture
  review with validator `187944196203f0a0b7417e3dec528da7368a147c` after accepting
  its established native terminal sentinel.

Each report's adjacent `offline-review.json` records the review separately from
the original result. Both reviews checked complete output, termination, routing,
usage/accounting and exactly one actual attempt. No review made a new HTTP call;
mapping revisions and timestamps identify the actual generation, not the review.

## Release acceptance checkpoint: upstream rejection

At revision `147d322309fe8247de3bf3d01d6e199bff3d76d5`, 48 of 66 unique
scenarios have passed, including the two explicitly documented native capture
reviews above. All 30 text/auto scenarios and all 18 Gemini/Grok/GPT forced-tool
scenarios passed. The repaired Gemini Responses SSE case was verified once on
the new implementation; the earlier failed conversion report remains unchanged.

Run `2026-09-23T02-14-33-974Z-G1Z74t/report.json` passed 37 cases, then stopped
at `claude-opus-5.5.chat.tool.json`. Copilot returned HTTP 400 with
`tool_choice: type "tool" and "any" are not supported for this model.`
The request used `copilot-openai-direct`, recorded exactly one upstream attempt,
and retained the default rule. The sidecar stopped after 38 actual model sends;
no request followed the upstream rejection.

Seventeen scenarios remain unrun: five other Claude forced-tool cases and twelve
tool-result continuations. The complete task budget consumed 64 of 100 requests,
including bootstrap and cache-only preflights. Passing text-protocol evidence
does not imply support for forced tool choice.

Source comparison with v2.6.0 shows that native Chat preparation preserved the
payload and serialized `tool_choice` unchanged. The current non-streaming native
path does the same. This is not a live v2.6.0 execution or proof of historical
upstream support. Raven must not silently drop or change the client's explicit
tool choice to conceal the rejection. Changing Claude's acceptance request to
automatic tool choice requires an explicit test-contract decision; it is not a
production fallback. Version 3.0.0 remains unpublished pending that decision and
completion of the remaining acceptance.
