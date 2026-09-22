# Retrospective

Accident narratives and original lessons. Historical instructions below describe their time; the current handbook and its local-isolation contract take precedence.

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

## Undated entries migrated from the previous handbook


- `eea1083` mixed model list fix (proxy feature) with e2e test model update (test) in one commit. Should have been two: one for `models.ts`, one for `proxy.e2e.test.ts`. Always split source changes and test changes into separate commits when they serve different purposes.
- `6ea7485` wrongly switched `copilot_internal/user` from GitHub OAuth token to Copilot JWT, causing 401. Root cause: assumed all copilot_internal endpoints use the same auth — they don't. Both `/copilot_internal/v2/token` and `/copilot_internal/user` on `api.github.com` require `token ${githubOAuth}`, not `Bearer ${copilotJwt}`. Always verify auth by curl-testing the real endpoint before committing auth changes.
- `f477dcc` stream translator emitted `input: ""` (empty string) instead of `input: {}` (empty object) in `content_block_start` for `tool_use` blocks. Anthropic protocol requires an object. Clients silently failed to render tool calls (e.g. AskUserQuestion). Root cause: wrote the literal without checking the Anthropic SSE spec. Always verify emitted event shapes against the protocol spec or a known-good reference implementation.
- `a7c6fcf` deleted `RAVEN_API_KEY` env var support and `multiKeyAuth` env path entirely, breaking backward compatibility and removing `/api/*` auth. Three compounding errors: (1) removed a design-doc-mandated backward compat path without consulting the doc, (2) widened dev mode to "DB empty = no auth" which is a security regression when env key is set but DB has no keys yet, (3) left `/api/*` management endpoints unauthenticated while they should share the same auth. Root cause: user said "remove RAVEN_API_KEY" and I complied without cross-checking the design doc's compatibility requirements. Always re-read the design doc before making protocol-level changes, even if the user requests them conversationally.
- `34ae0f7` dashboard 56 tests FAIL blocking pre-commit. Root cause: someone ran `pnpm install` inside `packages/dashboard/` after `bun install`, creating a `.pnpm/` store alongside bun's `.bun/` symlinks. `react` resolved from `.pnpm/` (pnpm copy) while `@testing-library/react` resolved from root `.bun/` (bun copy) — two physical React instances = "Invalid hook call" on all component/hook tests. Fix: `rm -rf packages/dashboard/node_modules && bun install`. Also added `turbopack.root` to next.config.ts since Turbopack lost workspace root inference after the reinstall. Rule: never mix package managers in a monorepo; this project uses bun exclusively.
- `d15e6e6` + `8b9aad1` added dot→hyphen model-ID translation (`claude-opus-4.8` → `claude-opus-4-8`) to Raven's `/v1/models` route, then native `adaptChunk`/`adaptJson` + `preprocess.ts` — both reverted same-day (`d0c647e`, `809c3c3`), net zero. Root cause: assumed the "Opus 4 instead of Opus 4.8" display glitch was Raven's to fix. It is **not** — Copilot upstream accepts both dot and hyphen forms; the display name is resolved client-side by `ccstatusline`'s `includes()` matching, which only recognizes the hyphen form. Correct fix lives in the **cc switch** client config (use `claude-opus-4-8`), and Raven stays a passthrough on model IDs. Rule: when a symptom only manifests in a client's display, confirm the upstream actually mishandles the value before adding translation logic to the proxy — don't make Raven compensate for a client-side resolver. The "fix + revert" pair is a closed investigation, not an open bug.
- v2.5.0 release: local pre-push reported L1 coverage ✅ while CI `check-coverage.ts` failed (protocols/ floor + untested new files + global regression vs `docs/20-baseline.json`). Root cause: `scripts/pre-push.ts` ran bare `bun run --filter @raven/proxy test` (vitest % thresholds only) and never invoked the §4.5 baseline gate that CI uses. Fix: pre-commit + pre-push both run `gate:coverage` → `scripts/check-coverage.ts`; unit test locks the wiring. Rule: any hook labeled "coverage" must call the same entrypoint as CI — never a weaker substitute.
