# Retrospective

Accident narratives and original lessons. Historical instructions below describe their time; the current handbook and its local-isolation contract take precedence.

## 2026-09-23: Page width was the wrong level for form readability

The follow-up hierarchy pass consistently capped configuration pages at 80rem,
but left analytics and tables full width. User review rejected the resulting
change in heading and content edges between routes. Consistency within a page
family did not establish consistency across the application.

The revised composition uses one full-width shell for every Dashboard route.
Task cards, two-column container grids and field-level widths handle readability.
Single-card titles and actions stay inside their card, while optional details
expand in place. Regression checks now compare every page to the island's actual
available width, including ultrawide displays, instead of asserting two width
modes that encoded the rejected design.

## 2026-09-23: A local layout fix did not establish site-wide consistency

The first hierarchy pass capped Routing, General and only the Code tab in
Connect. Comparable Proxy, Server Tools and Account pages retained full-width
forms, and the Settings title disagreed with the sidebar's General label. User
review exposed that the page family had not been treated as one system.

The shell now derives navigation from sidebar groups and owns each page's width,
including loading/error states and every tab. Configuration sections share one
responsive grid. Verification covers every sidebar destination, not only the
originally named pages. New shell tests initially omitted the existing log-dock
provider; restoring the real provider composition fixed the test setup.

## 2026-09-23: Dashboard hierarchy verification caught a client-boundary error

Matching loading skeletons to the new analytics cards introduced compound Basalt
components into a server-rendered module. Type checking passed, but production
prerendering failed with an undefined element. The skeleton module now declares
its client boundary, like the interactive panels it mirrors. Compound exports
must be checked in a production render, not only through their TypeScript types.

The first full Dashboard test run overlapped the production build and reported
36 failures, predominantly five-second timeouts across changed and unchanged
components. A two-worker rerun still timed out under heavy host load. The two
affected files passed alone, followed by all 808 tests and all four coverage
thresholds with one worker. Verification separates builds from coverage and
limits workers when the host is busy. Test timeouts, assertions, coverage
thresholds and commit hooks remain unchanged; failed runs are not passing
evidence.

## 2026-09-22: Audit commands used the development checkout

Several delegated audit commands used the default development directory instead of the dedicated baseline worktree. One coverage run regenerated ignored reports and observed the coordinator's unfinished contract tests; those results were discarded as baseline evidence. All reported baseline checks were rerun at the pinned revision with an explicit working directory. No tracked production files were changed by the auditor.

Concurrent full hook probes and development checks also amplified machine contention and test timeouts. Heavy audit probes were stopped; the final development hook passed with two Vitest workers after moving two existing tests' module initialization outside their per-test timeout. Every future audit command must specify its working directory, and full-suite runs owned by the same task must be coordinated. Formal audit evidence remains in nmem.

## 2026-09-22: Dashboard verification used the wrong runtime

A targeted Dashboard test command invoked Vitest through Bun directly. Its jsdom workers failed during environment setup with an EventTarget error, so that run was discarded. Repeating the same checks under Node, as the Dashboard package script specifies, passed. Proxy tests require Bun for SQLite; Dashboard component tests require the package's Node runner. During route removal, a fresh TypeScript check also caught stale fixture types that an incremental invocation had not reported; final verification includes a fresh check and production build.

A UTC-only timestamp fix passed component tests but still failed Chrome hydration: the server's Intl formatter inserted "at" while Chrome inserted a comma. Monitor now uses a shared ISO-based UTC formatter. The final browser check uses a different time zone from the server and asserts that there are no hydration errors; matching time zones alone is insufficient verification.

The populated production fixture did not expose a development SSR failure: Monitor actions passed a server-component child into Basalt's Radix Slot, and fresh document requests through Caddy returned 500. Restarting Next did not fix it. Making the interactive Monitor panels an explicit client boundary restored document rendering. Local verification must include direct Caddy document loads as well as the production fixture and client navigation.

## 2026-09-22: Build credentials polluted isolated unit tests

The final protocol-repair verification harness reused its synthetic build credentials for Dashboard unit tests. Two tests failed because they intentionally omit `NEXTAUTH_SECRET` or `RAVEN_INTERNAL_KEY`, but inherited the harness values. The first run stopped after these failures; its results were not presented as a successful final verification. No real credentials, provider calls or daily development state were involved.

The harness now removes authentication keys from the Dashboard unit-test environment, while retaining isolated state paths and an unreachable proxy URL. Build commands keep their synthetic credentials. Production code, test assertions, coverage thresholds and timeout settings were unchanged. Verification environments must distinguish build inputs from variables that individual tests control, including missing-variable cases.

## 2026-09-22: Overlay contents rendered outside the viewport

The request drawer and setup dialog passed `relative` to Basalt content components, overriding their default `fixed` positioning through Tailwind class merging. The backdrop remained visible while the request drawer started below the viewport. Existing component tests found the error text in the DOM but could not detect its off-screen geometry. Removing the positioning overrides restores the library's viewport anchoring; fixed positioning also anchors the absolute close controls. Browser verification must check viewport bounds, scrolling and dismissal for overlays, not only text presence.

The first focused verification command combined a root-relative Vitest config with `--root`, resolving the package directory twice. It failed before running tests. Running the package's Node-based Vitest command from the package directory passed; no failed startup result was counted as test evidence.

## 2026-09-22: A local SOCKS test still had an external destination

During R3 coverage review, an inherited test named "exercises temp bridge handler with real SOCKS5 proxy" was found to forward its locally accepted tunnel to the public IP-echo endpoint chosen by production code. Earlier whole-suite runs included this test; the latency-only assertion did not establish whether the external lookup succeeded and cannot substantiate complete network isolation. No real model credentials were used by this test.

The test now rejects outbound fetch by default and uses a local fixture receiver plus deterministic HTTP results. Real socket assertions cover CONNECT 200, malformed-request 400, connection-failure 502 and tunnel closure. Final verification was rerun after this change. A local proxy listener does not imply a local destination; both ends of a test tunnel must be controlled.

## 2026-09-22: Routing component tests missed browser geometry

The time editor's End select rendered all 49 options, but the real browser could not click early options because the popup extended outside the viewport. Basalt already supplied the Popper positioning and scroll viewport; the integration lacked its available-height cap. The fix uses those existing facilities, with no force-click or custom scrolling implementation.

A second production-browser review found a 3,222-pixel mobile document with the application confined to its 844-pixel viewport. The Basalt Shell and ContentIsland lacked the positioning contexts required by the installed integration guide, allowing absolute screen-reader labels from long rule forms to contribute overflow outside the island. Adding `relative` to those containers confines their descendants; the mobile header now retains the page title while omitting ancestor breadcrumbs that overlapped it. Component regressions cover keyboard/focus and responsive draft preservation. The isolated browser runner additionally checks popup bounds, document/body height, island scrolling and screen-reader-label offset parents.

## 2026-09-22: Unified test execution used incompatible runtimes

The package suites passed, but `test:root` forced every Vitest project through Bun. Twenty-four Dashboard jsdom files then failed before their tests could start. The root command now reuses the existing package runners and separately runs the scripts project: Bun for Proxy/scripts and Node for Dashboard. The complete selection passed without changing exclusions or thresholds.

A subsequent normal pre-commit rejected a rule-deletion test that exceeded its existing five-second timeout under load. The test rendered a weekly timetable unrelated to deletion. It now uses a small all-day fixture while preserving cancel, reference-conflict, successful-delete and exact-request assertions; asynchronous UI assertions wait for completion. One focused check was mistakenly invoked through the full-scope coverage command: its 11 tests passed, but coverage correctly failed and was not counted as a passing gate. The unchanged complete commit gates remain the acceptance check.

## 2026-09-23: An internal status request reached the user

While coordinating browser verification, the coordinator sent a worker-status question through the user-input tool. The user was asked to supply information that belonged in the agent mailbox. No application state changed. The coordinator clarified that no response was needed and continued verification. Internal coordination must use the worker mailbox; user-input tools are reserved for missing user decisions or information.

## 2026-09-23: Local dates disagreed during hydration

The Routing acceptance runner now forces its isolated Next server to UTC while Chrome uses Asia/Shanghai. Its interactions passed, but a fresh Connect load reported React hydration error 418 because key dates were rendered directly in both environments and fell on different calendar days. Requests and Analytics already deferred local formatting until hydration; Connect and the account assignment date now use the same component. A regression checks server placeholders, a browser day rollover, the valid zero timestamp and zero recovery errors. The browser run must pass its error assertion as well as its interaction checks.

## 2026-09-23: Repeated full-gate UI timeouts under load

Repeated commits were rejected by five-second Dashboard interaction timeouts while
all other gates passed. Simplifying fixture setup alone did not solve repeated
accessible-name scans over 49 options. The keyboard test now caches option nodes
while preserving visibility, labels, focus, keyboard navigation and midnight
assertions. Another interaction timed out under concurrent load; limiting Vitest
workers to two passed the complete unchanged gate. Inspect fixture/query cost and
runner concurrency before repeating expensive checks; do not raise timeouts or
reduce assertions to obtain a commit.

## 2026-09-23: Live acceptance needed a send guard and safe bootstrap

Inspecting telemetry after generation can detect an internal replay, but cannot
prevent the second network send. The bounded live runner now requires a temporary
sidecar that allows one upstream send per case and closes on the first HTTP or
transport failure. Production replay policy remains unchanged. Bootstrap reuses
the daily Proxy's effective version headers rather than performing fresh version
discovery; credentials enter the runner through private files or non-echoing stdin.
Two new stdin validation tests initially supplied array rows to a parameterized
test as a single array argument, which the runner expanded. Object rows fixed
the fixture; those failed runs were not counted as passing evidence.

The first sidecar launch assumed a documented local environment file existed;
inspection showed neither environment key was configured, and startup rejected
before HTTP. The sidecar now validates the supplied database key before network
access and protects its management plane with an ephemeral in-memory credential
when needed. Bun environment-file flags use the `--env-file=path` form; the
space-separated attempted invocation printed help without starting the script.
Check local configuration presence before treating example paths as real files.

A subsequent local-only launch exposed Bun SQLite's flag behavior: passing
`create: false` without `readwrite: true` provides no valid open mode. The sidecar
now explicitly opens the existing database read/write, with a regression proving
accounting writes remain possible while missing paths never create a database.
Startup failures identify their stage without dumping credentials or responses.

## 2026-09-23: Native SSE was rejected by a converted-envelope assertion

The live Gemini stream returned HTTP 200, the complete marker, usage, a stop
reason and `[DONE]`, but the harness rejected its absent `object` discriminator.
The v2.6.0 native strategy passed these upstream chunks through unchanged. The
JSON assertion already recognized this native behavior; the SSE assertion did
not. Both now allow only an absent native discriminator while rejecting wrong
values, missing converted discriminators, errors and incomplete streams. The
original failed report remains unchanged; saved captures can be reviewed offline
without spending another model request or normalizing production output.

The next batch passed seven cases before Claude's native Messages SSE hit a
related assumption: the harness tried to JSON-parse Copilot's final `[DONE]`
after a valid `message_stop`. The v2.6.0 native strategy also preserved this
sentinel. Native Messages validation now permits exactly one final eventless
sentinel only after semantic completion; translated streams, early or repeated
sentinels and data after completion remain rejected. The batch stopped after
eight actual sends and its original report is preserved for offline review.

## 2026-09-23: Live conversion exposed an incomplete Responses SSE contract

The first translated Gemini Responses stream returned complete text but omitted
`response.created`, output-item/content-part lifecycles, correlation indices and
the final response discriminator. Existing converter tests checked selected
events rather than a complete client stream. The real acceptance stopped after
two sends; its failed report was retained without relabeling it as a pass.

The shared Chat-to-Responses adapter now emits ordered, correlated lifecycle
events for text and tools, preserves incomplete finish reasons, and waits until
DONE or normal EOF to include a late usage trailer. The same adapter serves
Messages-backed conversion; native paths remain untouched. Offline regressions
cover mixed and interleaved output, metadata arriving after arguments, missing
tool metadata, truncation, late errors and single finalization. Responses usage
can remain null when the selected non-quota conversion did not request usage;
the acceptance policy still requires usage where that case promised it.

## 2026-09-23: Release installation hit missing mirror artifacts

The 3.0.0 release entry updated version metadata, then stopped before committing
or publishing because the Microsoft package mirror returned 404 for three locked
packages. A successful generic registry probe had not established availability
of those exact artifacts. Bun 1.4.2 also wrote mirror tarball URLs into the lock
despite using a temporary registry environment variable.

The recovery compared the entire lock with HEAD, confirmed dependency versions
and integrity values were unchanged, and removed only the generated mirror URLs.
The existing Tencent-scoped local cache then completed
`bun install --offline --frozen-lockfile` successfully, without network downloads
or hook bypass. Publication continued from the interrupted metadata stage with
normal checks. Future release preparation should check exact cached artifacts
and inspect the complete lock diff; a temporary registry is not proof that Bun
will leave resolution URLs unchanged. No application workaround was needed.

## 2026-09-23: Release runtime checks needed fresh development state

The 3.0.0 production build and 18 isolated browser checks passed, but restarting
the daily Dashboard reused old `.next/dev` state after dependency relinking and
failed to compile generated Google-font imports. Moving only that generated
development directory to a recoverable private temporary location and restarting
Dashboard fixed the error. The production build, application source and font
configuration were unchanged; both live components and the HTTPS General page
then reported 3.0.0. Inspect generated state before changing working source to
compensate for a local development-cache failure.

Bun's HTTPS client did not trust the existing local certificate; system curl did.
Verification used curl without disabling TLS or changing certificates/Keychain.
The release database backup was created through SQLite's backup operation with
private permissions. Its initial read-only integrity probe could not initialize
the standalone WAL-mode file; opening the completed, inactive backup with
`immutable=1` passed `PRAGMA quick_check`. Never apply immutable mode to the
running database or confuse that local probe failure with an upstream API error.

## 2026-09-23: A combined schedule test exhausted the CI time budget

The documentation-only commit `119562e` failed Dashboard CI because one schedule
test exceeded its unchanged 5-second limit. The identical test had taken 4.695s
in the successful `2adba3a` release run, leaving only 305ms of headroom; the next
Ubuntu run took 5.624s. Its real-timer userEvent interactions already used
`delay: null`. The only asynchronous lookup waited for the opened Select option;
there were no fake timers or polling assertions in this scenario. The recent
keyboard-fixture optimization changed a different test.

Local step instrumentation showed steady progress through selection, copying,
navigation, cancellation and creation, including 417 computed-style calls. A
bounded CPU-quota probe (15ms runnable per 200ms, applied only to the owned test
process group) reproduced the original timeout at 5.245s around cancellation.
This establishes sensitivity to cumulative work and scheduling, not an observed
async deadlock. It is a controlled stress reproduction, not an exact Ubuntu
hardware reproduction. An initial probe throttled runner startup and was
discarded; the useful probe began at the test body. Its first completed failure
also exposed a diagnostic cleanup signal after runner shutdown; the harness
stopped throttling before shutdown for subsequent comparisons.

The fix keeps start-day editing, copying under fresh identities and inspecting
the copied period together, but tests cancellation and empty-weekday creation
independently from explicit fixtures. Queries inside the copy modal now use its
accessible dialog scope. Existing interactions remain covered, with stronger
assertions for copied values, cancellation without mutations and preservation
of existing periods. The new exact creation assertion was corrected against
`availableWindow`'s existing 60-minute default before verification; production
behavior was not changed to match a guessed fixture.

The 17-test editor file passed five consecutive complete runs. Three identical
quota runs passed all three affected scenarios; the longest case took
4.221–4.245s. The normal parallel `bun run test:all` passed all 835 Dashboard
and 2,614 Proxy tests with coverage enabled; full lint and typecheck also passed.
Temporary instrumentation stayed outside the final diff. No global
or local timeout, retry, fake timer, coverage scope or worker setting changed.
The 3.0.0 application code, version, tag and Release remain untouched. Treat
near-timeout green tests as a warning: isolate independent behaviors and measure
their work before increasing a timeout or blaming a race.

## 2026-09-23: Push docks need container-based page layouts

Restoring the Logs push dock exposed a layout assumption that was invisible at
full page width: Monitor and Routing still chose columns from viewport media
queries. With navigation and the dock open at 1280px, Routing's 330px content
island overflowed to 502px. Named page, panel and editor container queries now
choose layouts from the space actually available, including loading skeletons.
The isolated browser check opens Logs across every sidebar destination in both
themes, checks island overflow and verifies the stream/statistics column order.

The first auto-refresh browser assertion tried to locate a background control
while a modal request drawer correctly hid it from the accessibility tree. The
test now checks that the detail survives a real RSC refresh, then closes the
drawer before inspecting the preserved interval. Production behavior was not
changed to accommodate the mistaken assertion.

An initial full Dashboard run overlapped local compilation and machine-wide
load above 41, producing widespread five-second timeouts across existing files.
A complete two-worker coverage run passed without changing timeout, coverage,
assertions or CI configuration. Keep expensive local verification bounded on a
shared machine; require normal hooks and exact-release CI before publication is
considered verified.

The release script's `bun install` converted 517 empty registry fields to the
temporary corporate mirror, despite resolving no dependency changes. Publication
was stopped during pre-push; remote main remained at `28f9d5d` and no 3.0.1 tag
existed. The unpublished release commit was corrected only after comparing the
normalized lockfile byte-for-byte with the prior lockfile plus its workspace
version change. A temporary mirror environment is not proof of a portable
lockfile. Inspect the generated lockfile before a combined install/commit/push
pipeline can publish it, and finish interrupted release stages explicitly.

Exact-version browser verification also caught a 2.14px false header-alignment
failure: two sequential browser calls sampled the name field and save button
at different points in the shared entry animation. Read both rectangles in one
browser evaluation, preserving the original 1px alignment tolerance. Do not
weaken geometry assertions or add fixed sleeps to hide cross-frame sampling.

## 2026-09-23 — Logs acceptance needs the real local stream

The new Native/Translated browser assertion failed because the isolated runner
served only Hono HTTP routes. Logs uses Bun WebSocket upgrades, bridged by the
Dashboard BFF to SSE; the panel had always remained disconnected in that runner.
Inspection of the failure snapshot and both transport handlers separated the
missing fixture capability from a production regression. Wire the existing
WebSocket handler into the isolated server with synthetic internal-key validation,
then assert rendered badges from real fixture request events. An empty panel can
prove shell geometry, but not populated card surfaces or live-log behavior.

## Undated entries migrated from the previous handbook


- `eea1083` mixed model list fix (proxy feature) with e2e test model update (test) in one commit. Should have been two: one for `models.ts`, one for `proxy.e2e.test.ts`. Always split source changes and test changes into separate commits when they serve different purposes.
- `6ea7485` wrongly switched `copilot_internal/user` from GitHub OAuth token to Copilot JWT, causing 401. Root cause: assumed all copilot_internal endpoints use the same auth — they don't. Both `/copilot_internal/v2/token` and `/copilot_internal/user` on `api.github.com` require `token ${githubOAuth}`, not `Bearer ${copilotJwt}`. Always verify auth by curl-testing the real endpoint before committing auth changes.
- `f477dcc` stream translator emitted `input: ""` (empty string) instead of `input: {}` (empty object) in `content_block_start` for `tool_use` blocks. Anthropic protocol requires an object. Clients silently failed to render tool calls (e.g. AskUserQuestion). Root cause: wrote the literal without checking the Anthropic SSE spec. Always verify emitted event shapes against the protocol spec or a known-good reference implementation.
- `a7c6fcf` deleted `RAVEN_API_KEY` env var support and `multiKeyAuth` env path entirely, breaking backward compatibility and removing `/api/*` auth. Three compounding errors: (1) removed a design-doc-mandated backward compat path without consulting the doc, (2) widened dev mode to "DB empty = no auth" which is a security regression when env key is set but DB has no keys yet, (3) left `/api/*` management endpoints unauthenticated while they should share the same auth. Root cause: user said "remove RAVEN_API_KEY" and I complied without cross-checking the design doc's compatibility requirements. Always re-read the design doc before making protocol-level changes, even if the user requests them conversationally.
- `34ae0f7` dashboard 56 tests FAIL blocking pre-commit. Root cause: someone ran `pnpm install` inside `packages/dashboard/` after `bun install`, creating a `.pnpm/` store alongside bun's `.bun/` symlinks. `react` resolved from `.pnpm/` (pnpm copy) while `@testing-library/react` resolved from root `.bun/` (bun copy) — two physical React instances = "Invalid hook call" on all component/hook tests. Fix: `rm -rf packages/dashboard/node_modules && bun install`. Also added `turbopack.root` to next.config.ts since Turbopack lost workspace root inference after the reinstall. Rule: never mix package managers in a monorepo; this project uses bun exclusively.
- `d15e6e6` + `8b9aad1` added dot→hyphen model-ID translation (`claude-opus-4.8` → `claude-opus-4-8`) to Raven's `/v1/models` route, then native `adaptChunk`/`adaptJson` + `preprocess.ts` — both reverted same-day (`d0c647e`, `809c3c3`), net zero. Root cause: assumed the "Opus 4 instead of Opus 4.8" display glitch was Raven's to fix. It is **not** — Copilot upstream accepts both dot and hyphen forms; the display name is resolved client-side by `ccstatusline`'s `includes()` matching, which only recognizes the hyphen form. Correct fix lives in the **cc switch** client config (use `claude-opus-4-8`), and Raven stays a passthrough on model IDs. Rule: when a symptom only manifests in a client's display, confirm the upstream actually mishandles the value before adding translation logic to the proxy — don't make Raven compensate for a client-side resolver. The "fix + revert" pair is a closed investigation, not an open bug.
- v2.5.0 release: local pre-push reported L1 coverage ✅ while CI `check-coverage.ts` failed (protocols/ floor + untested new files + global regression vs `docs/20-baseline.json`). Root cause: `scripts/pre-push.ts` ran bare `bun run --filter @raven/proxy test` (vitest % thresholds only) and never invoked the §4.5 baseline gate that CI uses. Fix: pre-commit + pre-push both run `gate:coverage` → `scripts/check-coverage.ts`; unit test locks the wiring. Rule: any hook labeled "coverage" must call the same entrypoint as CI — never a weaker substitute.
