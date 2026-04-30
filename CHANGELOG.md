# Changelog

## v2.2.3

### Added
- Align Copilot upstream headers with current VSCode client

### Changed
- Fix HTML title language to match UI (raven - Copilot Proxy Dashboard)
- Unify HTML title to "raven - Copilot 代理面板"
- Upgrade vite to 8.0.10
- Upgrade next to 16.2.4

### Fixed
- Also strip `strict` on Copilot native tool sanitizer
- Strip Anthropic-only fields on Copilot native messages path
- Limit thinking block stripping to claude-opus-4.5 only
- Strip thinking blocks from assistant messages in Copilot requests
- Normalize model name to lowercase for custom Anthropic upstreams
- Add postcss override and clean unused osv ignore

### Removed
- Remove stale picomatch osv ignores

## v2.2.2

### Changed
- Clarify openai-reasoning scope and add gpt-5.4 edge cases

### Fixed
- Rewrite max_tokens → max_completion_tokens for Copilot gpt-5.4 (#27)
- Replace bg-muted with B05 background tokens in table
- Align routes/ baseline to CI-measured 99.18%

## v2.2.1

### Changed
- Parallelize pre-push gates and split arch/coverage into own CI jobs
- Add per-page smoke covering all 12 routes
- Raise global floor to 98% and refresh per-dir baseline
- Cover remaining branches in logger/terminal-format/detect-local-versions

## v2.2.0

### Changed
- Session metadata for runs 76-96
- Hoist STOP_REASON_MAP to module level (skip per-call alloc)
- Cache translateModelName results in a Map
- Single object literal in translateToOpenAI (stable hidden class)
- Normalize Message property order for hidden class sharing
- Cache usage lookup chain in translateToAnthropic
- Skip join() for single text/thinking part in assistant message
- Skip join() for single-text-block case
- Inline mapContent for string content in append* fast paths
- Zero-alloc beta scanning
- Stream translation: cache usage refs, indexed for over tool_calls
- Pre-allocated indexed loop in translateAnthropicToolsToOpenAI
- Append* pattern, no spreads/intermediate arrays, indexed loops
- Indexed for-loops in mapContent + slow path
- Indexed for-loop in translateAnthropicMessagesToOpenAI outer loop
- Indexed for-loop in append* hot loops; cache content array
- Fuse filterContentBlocks into appendAssistantMessage categorization loop
- Fuse filterContentBlocks into appendUserMessage fast path
- AppendUserMessage fast path: direct push when no tool-result flags
- AppendUserMessage/appendAssistantMessage push directly to shared result; assistant returns ids inline
- Single-pass extractToolUseIds; avoid systemMessages spread
- Eliminate object/array double-spreads in translateToOpenAI &amp; handleAssistantMessage

### Fixed
- Drop node:fs mock entirely in live.test
- Passthrough non-package.json reads in live.test mock
- Remove leaking mockImplementationOnce in live.test

### Removed
- Drop filteredContent in appendAssistantMessage; reuse mapContent's switch filtering in fallback
- AppendSystemPrompt pushes into shared result; remove systemMessages spread

## v2.1.0

### Added
- Emit strategy name in request_end and show colored pill in Dashboard
- Add test-count regression + new-file-without-test checks (§4.5)

### Changed
- Color pills by model family; translate/resolve share family color
- Make strategy pills visually distinct (native=green, translated=red)
- Strip stale phase markers from core, composition, upstream headers
- Strip stale Phase H/I/J markers from comments
- Record final Phase C E2E run — 41/41 pass, no diff vs baseline
- Mark anti-ban/opt-in-full e2e checks as verified
- Activate final dep-cruiser rule set
- Add proxy architecture navigation to CLAUDE.md
- Audit route-local helpers, no duplicates found
- Native server-tools branch → decorate()
- Translated server-tools branch → decorate()
- Add decorate() helper to strategies/support/server-tools
- Activate dep-cruiser rules for core/ + strategies/
- Add strategies/copilot-translated.ts (factory, no state)
- Add strategies/custom-anthropic.ts (factory, no state)
- Add strategies/custom-openai.ts (factory, no state)
- Copilot-responses via dispatch; shrink responses route
- Add strategies/copilot-responses.ts (factory, no state)
- Copilot-native strategy via dispatch
- Chat-completions copilot-openai-direct via dispatch
- Composition/index.ts dispatch entry point
- Composition/strategy-registry.ts (copilot-openai-direct only)
- Add strategies/copilot-openai-direct.ts (factory, no state)
- Seed test/strategies/__fixtures__/ from C goldens
- Record no-diff completion for Phase G
- Port responses → Runner
- Port messages anthropic passthrough → Runner
- Port messages custom-openai upstream → Runner
- Port messages default Copilot → Runner
- Port chat-completions custom-upstream → Runner
- Port chat-completions streaming default → Runner
- Port chat-completions non-streaming default → Runner
- Add Runner streaming path
- Add core/stream-runner.ts SSE helpers
- Add core/runner.ts JSON path + Strategy interface
- Add core/context.ts RequestContext + buildContext
- Characterise streaming handler branches
- Guard messages handler against future router rejects
- Central reject→400 error mapper
- Explicit reject-branch tests for pickStrategy
- Wire responses handler to pickStrategy
- Wire messages handler to pickStrategy
- Wire chat-completions handler to pickStrategy
- Add core/router.ts::pickStrategy + fixture-driven tests
- Freeze router fixtures from §4.3 scenario matrix
- Add temporary router trace in 3 handlers
- Activate fetch() boundary guard
- Add composition/upstream-registry
- Port custom Anthropic to upstream/custom-anthropic
- Port custom OpenAI to upstream/custom-openai
- Port embeddings to upstream/copilot-embeddings
- Port responses to upstream/copilot-responses
- Port native-messages to upstream/copilot-native
- Port chat-completions to upstream/copilot-openai
- Characterise outbound request shapes
- Add UpstreamClient interface + contract tests
- Move mapOpenAIStopReasonToAnthropic into protocols/translate
- Activate dep-cruiser rule #1 (protocols purity)
- Note importer sweep done inline
- Extract responses/stream-state parsers
- Extract streamAnthropicResponse to strategies/support
- Relocate impure helpers to strategies/support
- Relocate translate code to protocols/translate
- Finalise preprocess migration to protocols/anthropic
- Populate baseline + flip coverage gate to enforce
- Capture CopilotResponses golden fixtures
- Capture CopilotOpenAIDirect golden fixtures
- Capture CopilotTranslated golden fixtures
- Capture CopilotNative golden fixtures
- Wire scenarios.test.ts to real capture/diff driver
- Add buildScenarioRequest
- Add captureOrDiffFixture harness
- Emit upstream_raw_sse for fixture capture
- Add per-strategy capture-goldens script
- Freeze §4.3 golden fixture format
- Encode §4.3 scenario matrix as scenarios.json
- Mark Phase A complete with A.7 review follow-ups
- Normalise model before provider resolution in /v1/messages
- Seed protocols/anthropic/preprocess as canonical module
- Red test for §2.2(7) model-normalisation divergence
- Add dependency-cruiser skeleton with zero active rules
- Baseline-driven coverage gate with violation evaluator
- Add baseline skeleton for coverage gate
- Add E2E safety-net skeleton for architecture refactor

### Fixed
- Translated mode must propagate JSON parse errors
- CopilotOpenAIDirectShim.describeEndLog adds error arm with model
- Propagate stream flag through RequestContext for pre-stream errors
- Guard Runner adaptJson() exception → emit request_end
- Drop util/logger from protocols/ (indirect purity breach)
- Thread OPT-* flags through count_tokens route
- Await stderr drain before parsing bun test summary
- Flag brand-new src files absent from lcov (§4.5)
- Order provider match raw-exact → norm-exact → raw-glob → norm-glob
- Wire coverage + arch gates into pre-push
- Try raw-model provider match before falling back to normalised
- Treat missing-dir in report as migration, not regression
- Restore border utility for conditional border-color classes
- Align bg-card usage to B05 luminance spec

### Removed
- Delete native-handler.ts, drop re-exports
- Remove dead StrategyNotRegisteredError + stale phase comments
- Copilot-translated via dispatch; remove G.9 shim
- Custom-anthropic via dispatch; remove G.11 shim
- Custom-openai via dispatch; remove G.8/G.10 shims
- Remove temporary router trace
- Handlers switch to upstream-registry; delete legacy shims

## v2.0.1

### Changed
- Widen detect-local-versions copilot timeouts to 30s
- Sync test counts and document new features

### Fixed
- Normalize thinking and token limit params

## v2.0.0

### Added
- Parallel pre-commit with gitleaks, upgrade CI
- Add warning logs and API field for invalid provider model_patterns
- Add reasoning effort fallback utilities
- Add output_config type definition for reasoning effort
- Add native Copilot handler for /v1/messages routing
- Add model capabilities utilities for native routing
- Add native Anthropic messages service for Copilot
- Add unified server-side tools interception layer
- Extend Models API with Copilot endpoint and capability fields
- Add preprocessing layer for Anthropic messages

### Changed
- Use production database instead of isolated test DB
- Fix logging side effects and expose raw_model_patterns
- Phase 1 - Provider Compilation for runtime optimization
- Update E2E tests and implementation doc
- Add comprehensive E2E tests for native and OpenAI paths
- Unify server-side tool handling across paths
- Update implementation plan with bug fix commits
- Update implementation plan with completion status
- Fix stale variable name canonicalModel → copilotModel
- Fix design issues in native Anthropic messages passthrough
- Add design doc for native Anthropic messages passthrough
- Add e2e test for 1M context window validation

### Fixed
- Make reasoning fallback E2E test actually verify fallback
- Unify null field cleanup for Anthropic upstreams
- Clean null fields before sending to Anthropic API
- Rewrite tool_choice when it targets a server-side tool
- Apply reasoning effort fallback on native /v1/messages path

## v1.8.1

### Added
- Upgrade /api/live to surety standard (#22)

### Changed
- New baseline with per-op latency metrics (ns). Includes all prior optimizations.
- Fix parseSSEStream benchmark: use actual chunkCount instead of lineCount
- Fix METRIC output: use per-op latency (ns) instead of total time
- Fix regressions: logger bus, text/thinking order, filterContentBlocks immutability
- Final validation: ~10% improvement confirmed
- Pre-compile model name translation regexes
- FilterContentBlocks fast path: avoid array allocation when no filtering needed
- Avoid array allocation in tool sanitization
- Optimize isToolBlockOpen: for-in loop instead of Object.values().some()
- Single-pass mapContent: detect image and collect text together
- Single-pass categorization in handleUserMessage
- Single-pass categorization in handleAssistantMessage
- Skip event creation when level check fails
- Add METRIC output to perf benchmarks
- Expand settings-socks5 coverage
- Expand socks5-bridge coverage
- Add detect-local-versions coverage
- Expand app-dirs coverage
- Add live route tests
- Expand keepalive coverage
- Expand sound route coverage
- Retrigger

### Fixed
- Remove useless initial assignments in live route handlers
- Use translated model name for token counting
- Resolve model variant (1m, fast) from anthropic-beta header

## v1.8.0

### Added
- Add automated release script
- Add GET /api/live health-check endpoint
- Add SOCKS5 proxy settings UI
- Add SOCKS5 bridge lifecycle management
- Inject SOCKS5 proxy into all 17 upstream fetch calls
- Add SOCKS5 settings API routes
- Add cacheSocks5Settings for DB → state hydration
- Add socks5-bridge module with HTTP CONNECT → SOCKS5 tunneling
- Add success/warning badge variants

### Changed
- Extract SOCKS5 Proxy into dedicated settings page
- Ignore GHSA-458j-xx4x-4375 hono medium CVE
- Add socks5 API route tests + include design doc
- Add nginx proxy timeout settings to prevent 504s

### Fixed
- Add save success/error feedback on Proxy settings page
- Preserve structured errors in PUT BFF + verify egress IP in test
- Improve Copilot Models table column widths and responsive breakpoints
- Address 4 review issues in SOCKS5 proxy relay
- Upgrade hono to fix GHSA-458j-xx4x-4375
- Remove bg-input/border-input anti-patterns from button, tabs, switch (#15)
- Badge warning token text-warning + reorder variants
- Migrate L3 Input/Select from bg-input to bg-secondary

## v1.7.7 (2026-04-13)

Runtime auth config detection for VPS deployments.

### Dashboard

- **Runtime auth detection** — Replaced build-time `NEXT_PUBLIC_AUTH_ENABLED` env var with runtime `/api/auth/config` endpoint, fixing a deployment footgun where building without OAuth env vars then running with them caused a redirect loop
- **Fail-closed auth loading** — Auth config loading or fetch errors now assume auth mode (fail closed) instead of incorrectly showing "Local mode"
- **Cold start handling** — Sidebar waits for both auth config and session status before determining display mode, preventing "Local mode" flash on first paint

## v1.7.3 (2026-04-10)

Security hardening, platform-aware data directories, and model name fix.

### Features

- **Platform-aware directories** — Runtime data (SQLite DB, GitHub token) now stored in platform-standard locations (`~/Library/Application Support/raven/` on macOS, `~/.config/raven/` + `~/.local/share/raven/` on Linux) with automatic migration from legacy `./data/` directory
- **IP whitelist** — Restrict API access to known client IPs via Dashboard Settings for defense-in-depth against key leakage
- **Non-macOS sound disable** — Sound notification feature gracefully disabled on non-macOS platforms

### Security

- **IP whitelist spoofing hardening** — Harden IP whitelist against `X-Forwarded-For` spoofing and bypass attacks
- **hono 4.12.8 → 4.12.12** — Fix 5 medium-severity vulnerabilities

### Proxy

- **Preserve original model name** — Client-requested model name (e.g. `claude-opus-4-6-20250820`) is now returned in Anthropic responses instead of upstream's truncated name (e.g. `claude-opus-4`)
- **Model name translation fix** — Correct model name translation for versioned Claude models
- **WAL migration** — Migrate SQLite WAL files (`-wal`, `-shm`) along with main database during directory migration
- **JSON error extraction** — Extract meaningful message from JSON error responses in terminal logs

### Docs

- **VPS deployment guide** — Generalized Azure VM deployment guide to any VPS with security requirements

## v1.7.2 (2026-04-05)

Accessibility improvements and design system refinements.

### Dashboard

- **WCAG touch targets** — Expanded interactive elements to 44×44px minimum touch target size for accessibility compliance
- **Chart accessibility** — Added ARIA labels to all Recharts components (area chart, bar chart, pie chart, sparkline)
- **Log timeline accessibility** — Added ARIA labels, roles, and keyboard focus indicators to timeline nodes
- **Sparkline SVG fix** — Fixed gradient ID collision causing fill issues when multiple sparklines rendered on same page
- **Secondary background tint** — Changed L2 `--secondary` from pure white to subtle warm tint (220 14% 99%) for better visual hierarchy
- **Login page refactor** — Extracted inline styles to design system utilities (`login-glow`, `login-card-shadow`, `login-punch-hole`)

## v1.7.1 (2026-04-04)

Connect page UX improvements and B-5 compliance fix.

### Dashboard

- **Click-to-copy models** — Model IDs in the Models tab are now clickable to copy directly to clipboard
- **B-5 dark mode fix** — Corrected `--input` lightness from 12% to 18% per Basalt B-5 color brightness system spec; L3 interactive controls now have proper visual distinction from L2 containers

## v1.6.1 (2026-04-03)

Sound notifications for error alerts.

### Features

- **Sound notifications** — Play macOS system sounds when proxy encounters errors; configurable via Settings page with 14 built-in sounds (Basso, Glass, Ping, etc.) and preview button

### Dashboard

- **Sound settings UI** — New "Sound Notifications" section in Settings with enable toggle, sound selector dropdown, and preview button
- **Sound preview API** — `POST /api/sound/preview` route to trigger sound playback via proxy

### Proxy

- **Sound settings persistence** — `sound_enabled` and `sound_name` keys in settings DB
- **Sound playback service** — `playSound()` function using macOS `afplay` command (non-blocking)
- **Sound preview endpoint** — `POST /api/sound/preview` accepts sound name and plays via afplay

## v1.6.0 (2026-04-02)

Extended thinking support and message sanitization for Claude Code compatibility.

### Features

- **Extended thinking support** — Added `supports_reasoning` capability to providers; translates Anthropic `thinking.budget_tokens` to OpenAI `reasoning_effort` for reasoning-capable upstreams (o1/o3 models)
- **Message sanitization pipeline** — Filters Anthropic-only content blocks (server_tool_use, mcp_tool_use, tool_reference, redacted_thinking, etc.) when routing to Copilot, preventing 400 errors from incompatible fields
- **Dashboard Supports Reasoning toggle** — New toggle in upstreams form to mark providers that support reasoning_effort parameter

### Improvements

- **Proxy port migration** — Changed default ports from 7032/7033 to 7023/7024 for consistency
- **Terminal log clarity** — Thinking-dropped warnings now use `type: "system"` for correct display; demoted to debug level to reduce noise for Copilot-only users
- **Models endpoint logging** — `/v1/models` now shows "models" instead of "unknown" in terminal logs

### Technical

- 37 new sanitization tests with 92.5% coverage
- Tool schema cleaning: strips `cache_control`, `defer_loading`, `strict`, `eager_input_streaming`
- Block metadata cleaning: strips `cache_control`, `citations` from content blocks
- Empty assistant messages (all content filtered) are now dropped entirely

## v1.5.2 (2026-03-30)

HTTPError enrichment refactor and basalt spec compliance fixes.

### Improvements

- **HTTPError enrichment** — extended HTTPError with response body and status via new `fromResponse` factory; replaced all upstream service throw sites to use enriched errors
- **Dashboard animation** — added `fade-up` entrance animation with staggered delays to stat cards on the home page
- **Sidebar transition polish** — increased transition duration from 150ms to 200–300ms for smoother collapse/expand and group toggle

### Fixes

- **Login page layout** — restructured to `flex-col` with centered content area and footer; added `aria-hidden` to decorative Google SVG icon
- **Sidebar active state** — switched from exact match to `startsWith` for sub-route highlighting (home/dashboard excepted)
- **Request table accessibility** — added `aria-sort` attributes to sortable columns
- **Skeleton color** — changed from `bg-accent` to `bg-muted` for better visual hierarchy
- **App shell border radius** — replaced `rounded-island` token with explicit `rounded-[16px]`/`rounded-[20px]`
- **Docker ignore** — added `.dockerignore` excluding `logo.png` and `*.md` from Docker builds

## v1.5.1 (2026-03-28)

Dashboard polish — settings layout, API key UX, sidebar stability, version display.

### Improvements

- **Settings layout overhaul** — extracted Server Tools and Upstreams into separate top-level nav groups with dedicated pages, replacing the single crowded settings page
- **Sidebar version badge** — display `vX.Y.Z` next to app name in expanded sidebar, sourced from root package.json via `NEXT_PUBLIC_APP_VERSION`
- **Sidebar logo stability** — fixed 4px jitter on collapse/expand by aligning padding (`pl-5` → `pl-6`) to match the expanded state's `px-3 + px-3`

### Fixes

- **API key button consistency** — unified Delete/Revoke button widths (`w-[72px]`) and added loading spinner to the Delete button (previously had no visual feedback)
- **Auth origin restored** — re-added `raven.dev.hexly.ai` to `allowedDevOrigins` after accidental removal broke the entire dashboard via Caddy reverse proxy (session cookies, API routes, and log streaming all failed)
- **Removed leaked hostname** — stripped hardcoded `raven.dev.hexly.ai` from README (public repo)

## v1.5.0 (2026-03-27)

Server-side tool interception — web_search via Tavily, tool call debug logging, dashboard settings.

### Features

- **Server-side web_search interception** — Claude Code's `web_search` (type: `web_search_20250305`) is intercepted by the proxy and executed via Tavily Search API instead of forwarding to Copilot (which returns 502)
- **Anthropic-native response format** — Returns `server_tool_use` + `web_search_tool_result` + `text` content blocks matching the official Anthropic streaming SSE format, with `encrypted_content` (base64), `page_age`, and `server_tool_use` usage tracking
- **Tool call debug logging** — `optToolCallDebug` toggle emits debug-level events for tool definitions, tool call starts, stop reasons, and tool counts; visible in dashboard Logs page with debug filter
- **Dashboard Server Tools settings** — Settings page now has a "Server Tools" section to enable web search and configure the Tavily API key

### Architecture

- **Pure mode** — when all tools are server-side (e.g., Claude Code's WebSearch sub-agent), the proxy calls Tavily directly, injects results for synthesis, and returns an Anthropic-native response
- **Mixed mode** — when both client and server-side tools are present, server-side tool definitions are stripped before forwarding to Copilot; server-side tool calls are intercepted and executed via Tavily in a loop (max 5 iterations)

### Docs

- **13-server-tools.md** — design document for server-side tool interception architecture

## v1.4.1 (2026-03-27)

Maintenance — remove GitHub Actions CI, fix test stability, and clean up import paths.

### Removed

- **GitHub Actions CI** — removed `.github/workflows/ci.yml` and all workflow runs; quality gates remain enforced via local hooks (pre-commit: L1+G1, pre-push: G2)

### Proxy — test stability

- **Mock isolation** — eliminated `mock.module` cross-test pollution; restored mocks at module load time in count-tokens-handler and messages-route tests
- **Flaky test removal** — removed sleep timing test that was non-deterministic across environments
- **Lockfile tracking** — committed `bun.lock` changes for reproducible dependency resolution

### Proxy — refactoring

- **Relative imports** — replaced `~/` path aliases with relative imports across all proxy source and test files; removed `baseUrl` from tsconfig to suppress TypeScript 7.0 deprecation warning

### Docs

- **CLAUDE.md** — removed CI section, updated L3 from "CI" to "manual only"
- **Design doc** — removed Phase 2 (CI) from `docs/12-quality-system-upgrade.md`
- **Hook comments** — updated pre-push L3 annotation from "CI-only" to "manual-only"

## v1.4.0 (2026-03-27)

Quality system upgrade from A- to S tier — D1 test isolation and documentation sync.

### Quality system — S tier

- **D1: Test DB isolation** — `RAVEN_DB_PATH` env var controls SQLite database location; E2E and Playwright runners use isolated `data/raven-test.db`, never touching production `data/raven.db`
- **D1: WAL/SHM cleanup** — test runners delete `.db-wal` and `.db-shm` sidecar files for complete isolation
- **D1: Proxy reuse guard** — test runners reject if proxy already running (cannot guarantee DB isolation without fresh start)
- **D1: finally cleanup fix** — refactored test runners to return exit code instead of `process.exit()` inside try block, ensuring `finally` cleanup always runs
- **CI: osv-scanner config** — added `osv-scanner.toml` to ignore transitive picomatch vulnerabilities in dev-only dependencies

### Linear issues

- **MY-33** — closed as Won't Fix; L2 manual-only is the correct design (anti-ban protocol)
- **MY-34** — closed as Done; D1 SQLite isolation via `RAVEN_DB_PATH`

### Tests

- **584 proxy tests** (was 583) — added `RAVEN_DB_PATH` config tests

### Docs

- **CLAUDE.md** — updated test counts, added CI section, corrected L3 from "7 smoke tests" to "25 tests across 5 specs"
- **Hook comments** — added quality dimension annotations (L1/G1, G2)
- **Design doc** — added `docs/12-quality-system-upgrade.md` with full implementation plan

## v1.3.0 (2026-03-27)

Custom upstream routing — route specific models to external providers (e.g. Zhipu GLM → Anthropic-compatible API) while everything else continues through GitHub Copilot.

### Proxy — custom upstream routing

- **Provider database** — new `providers` SQLite table with full CRUD for upstream provider configurations (name, base URL, format, API key, model patterns, enabled state)
- **Model routing** — `resolveUpstream(model)` matches exact patterns first, then glob patterns (`glm-*`) as fallbacks; unmatched models fall through to Copilot
- **Anthropic passthrough** — Anthropic-format upstream providers receive the raw payload without translation, streaming and non-streaming
- **OpenAI upstream** — OpenAI-format upstream providers receive translated payloads via existing Anthropic→OpenAI translation
- **Provider models in /v1/models** — exact (non-glob) model patterns from enabled providers are injected into the model list response, deduplicated against Copilot models
- **Management API** — `GET/POST /api/upstreams`, `GET/PUT/DELETE /api/upstreams/:id` with Zod validation, model conflict detection (exact-only, globs allowed as fallbacks), and automatic state cache refresh
- **Conflict guards** — provider creation returns 503 when Copilot models aren't loaded (conflict detection would be incomplete); provider update returns 503 only when model_patterns are being changed

### Dashboard — upstreams management

- **Upstreams settings page** — table listing all providers with name, format, base URL, model patterns (tags), masked API key, enabled status
- **Create/Edit dialogs** — form with name, format (Anthropic/OpenAI), base URL, API key (password field, leave empty to keep existing on edit), comma-separated model patterns, enabled switch
- **Delete confirmation** — destructive action dialog with provider name display
- **Sidebar navigation** — added Upstreams link in Settings nav group

### Quality gates

- **Security gate** — added `osv-scanner.toml` to ignore transitive picomatch vulnerabilities (GHSA-3v7f-55p6-f55p, GHSA-c2c7-rcm5-vvqj) in dev-only dependencies

### Tests

- **583 proxy tests** (was 495) — added 88 tests: providers DB CRUD, upstream router (exact/glob matching, priority, disabled providers), Anthropic/OpenAI fetch services (streaming/non-streaming, error handling), handler integration (routing, passthrough, fallback), upstreams API routes (CRUD, validation, conflict detection, 503 guards), models route (provider model injection)
- **236 dashboard tests** (was 224) — added 12 tests: upstreams API routes (proxy pass-through, error handling), sidebar navigation items

### Docs

- **Design doc** — added `docs/11-custom-upstream-routing.md` with architecture, routing logic, API schema, and implementation plan

## v1.2.3 (2026-03-23)

Claude Code compatibility — proxy now accepts `x-api-key` header for authentication, matching Claude Code's behavior when `ANTHROPIC_BASE_URL` points to a non-Anthropic host.

### Proxy — x-api-key support

- **`x-api-key` header authentication** — accepts API tokens via `x-api-key` header alongside existing `Authorization: Bearer`; `Bearer` takes precedence when both are present
- **Generic error message** — auth failure message changed from "Missing or malformed Authorization header" to "Missing or invalid authentication credentials" to avoid confusing `x-api-key` users
- **Internal rename** — `validateBearerToken` → `validateRequestToken` to reflect dual-header support; updated JSDoc on `apiKeyAuth` and `dashboardAuth`

### Docs

- **Claude Code setup** — replaced obsolete `claude config set --global apiUrl` with `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` environment variables; added interactive mode API key approval instructions

### Tests

- **495 proxy tests** (was 488) — added 7 x-api-key tests: env key, DB key (rk- prefix), wrong token rejection, Bearer precedence, dashboardAuth acceptance, internal key rejection via x-api-key

## v1.2.2 (2026-03-21)

Code cleanup — removed dead code that added unnecessary CPU overhead per request.

### Proxy — performance cleanup

- **Removed unused `getTokenCount` call** — the chat-completions handler was calling `getTokenCount()` on every request but discarding the result; dashboard token stats come from upstream `usage` fields, not local tokenizer calculation
- **Removed `requestContext` middleware** — the `startTime` was injected but never read; all handlers use their own local `performance.now()` calls

### Tests

- **486 proxy tests** (was 488) — removed 2 obsolete `requestContext` middleware tests

## v1.2.1 (2026-03-18)

Configurable request optimizations — three protocol-level fixes for upstream Copilot API compatibility issues, individually toggleable from the Settings page.

### Proxy — request optimizations

- **OPT-1: Sanitize orphaned tool results** — drops `tool_result` blocks that reference non-existent `tool_use` IDs after client-side compaction (e.g. Claude Code auto-compaction deleting assistant messages); prevents upstream 400 errors
- **OPT-2: Reorder tool results** — reorders parallel `tool_result` blocks to match the `tool_calls` array order expected by upstream, preventing 400 or result mismatch
- **OPT-3: Filter whitespace-only chunks** — skips streaming chunks with whitespace-only `delta.content` that cause blank lines in some clients (e.g. VS Code Copilot extension)
- **Optimization settings API** — `GET /api/settings` returns `optimizations` object; `PUT /api/settings` accepts `opt_*` boolean keys; all default to OFF
- **Contextual translation loop** — refactored `translateAnthropicMessagesToOpenAI()` from `flatMap` to explicit `for` loop with `pendingToolCallIds` context tracking across assistant→user turn boundaries

### Dashboard — setup wizard & settings

- **First-run setup wizard** — 3-step onboarding flow (GitHub auth → API key → client config) shown on first visit, dismissible, with session-scoped re-show prevention
- **Optimizations settings UI** — new "Optimizations" section in Settings page with Switch toggles for each optimization item, immediate PUT on toggle, description and status display

### Bug fixes

- **OPT-1 empty-array guard** — removed `pendingToolCallIds.length > 0` guard that caused the filter to skip when the assistant message was entirely deleted by compaction (the primary scenario OPT-1 was designed to fix)

### Tests

- **487 proxy tests** (was 467) — added 20 optimization tests covering all 3 OPTs, regression for contextual loop refactor, combined OPT-1+OPT-2 scenario, and assistant-deleted compaction edge case

### Docs

- **Design doc** — added `docs/10-request-optimizations.md` with research findings, optimization item definitions, API schema, UI mockup, and atomic commit plan

## v1.2.0 (2026-03-17)

Unified auth architecture and zero-config local mode — dashboard works out of the box, AI API routes always require authentication.

### Dashboard — local mode

- **Zero-config dashboard** — when Google OAuth env vars are missing, dashboard runs in local mode: all pages accessible without login, sidebar shows "Local" / "Local mode", `/login` redirects to home
- **Auth mode detection** — new `auth-mode.ts` server helper + `NEXT_PUBLIC_AUTH_ENABLED` client flag via `next.config.ts`
- **Conditional NextAuth init** — `auth.ts` always exports compatible stubs (`handlers`, `signIn`, `signOut`, `auth`); in local mode returns `null` session for correct "unauthenticated" status
- **Login redirect** — `/login` page redirects to `/` in local mode
- **Sidebar local display** — shows "Local" / "Local mode" with no sign-out button

### Proxy — unified auth

- **Split auth middleware** — replaced single `multiKeyAuth` with `apiKeyAuth` (strict, no dev mode) for AI routes and `dashboardAuth` (dev mode when no env keys) for management routes
- **AI routes always require auth** — `/v1/*`, `/chat/*`, `/embeddings` return 401 without valid API key, even with zero configuration
- **Dashboard routes independent of DB keys** — `/api/*` dev mode only depends on env keys (`RAVEN_API_KEY`, `RAVEN_INTERNAL_KEY`), creating/revoking DB keys never breaks dashboard access
- **`RAVEN_INTERNAL_KEY`** — proxy natively reads this as a dashboard management credential; accepted by `/api/*` and `/ws/logs`, rejected by AI API routes
- **Route aliases restored** — `/chat/completions` and `/embeddings` re-added with proper `apiKeyAuth` coverage via `/chat/*` and `/embeddings` middleware patterns
- **`getActiveKeyCount()`** — counts only non-revoked keys (excludes revoked) for potential future use

### Bug fixes

- **Session stub truthiness** — local mode session response changed from `{}` (truthy → "authenticated") to `null` (falsy → "unauthenticated")
- **Revoke cache invalidation** — `POST /api/keys/:id/revoke` now clears key count cache immediately
- **`connection-info` base URL** — `RAVEN_BASE_URL` now correctly propagated to `/api/connection-info` response
- **Route alias auth bypass** — `/chat/completions` and `/embeddings` previously bypassed auth middleware patterns; now properly covered

### Docs

- **README rewrite** — step-by-step first-run guide (clone → configure API key → start → GitHub auth → configure client), auto-init table, client config examples, dashboard auth mode section
- **Design docs** — added `docs/08-dev-auth-mode.md` (dashboard local mode) and `docs/09-unified-auth.md` (proxy auth architecture)
- **Doc sync** — updated `docs/02-key-management.md` and `docs/03-unified-logging.md` to reference new `apiKeyAuth`/`dashboardAuth` semantics

### Tests

- **467 proxy tests** (was 456) — added `apiKeyAuth` strict tests (no dev mode, INTERNAL_KEY rejection), `dashboardAuth` dev mode tests (env-key-only condition, DB key independence), route alias auth coverage
- **Dashboard tests** — added sidebar local mode unit tests, login redirect tests, auth module tests with `null` session assertions

## v1.1.1 (2026-03-17)

Code review fixes — data accuracy, chart consistency, and test coverage.

### Bug fixes

- **Non-streaming TTFT** — non-streaming requests were emitting `ttftMs: latencyMs` and `processingMs: 0`, polluting dashboard TTFT averages; now emit `null` so the `!== null` filter correctly excludes them
- **Model chart aggregation** — pie chart (by count) and bar chart (by tokens) each computed independent top-N, causing different models in "Others"; unified into a single top-N set (union of both dimensions) in the parent component
- **Clear filters nuked sort** — `clearFilters()` used `router.push("/")` which wiped sort/order params; now only removes filter-specific params (model, status, format, cursor, offset)
- **shortenSession :: format** — terminal session abbreviation didn't handle `"user::Claude Code::default"` separator; now takes first segment before `::` (first 6 chars)

### Improvements

- **test:all script** — added `test:all` to run tests across all workspace packages (proxy + dashboard)

### Tests

- **456 proxy tests** (was 451) — added session field round-trip tests for request-sink (session_id, client_name, client_version), shortenSession `::` format and UUID tests
- **unifyTopN unit tests** — 7 pure-logic vitest tests for the unified model aggregation function (union top-N, Others bucket, input order, edge cases)

## v1.1.0 (2026-03-17)

Session tracking, pretty terminal logs, and dashboard analytics polish.

### Proxy — features

- **Pretty terminal logs** — replaced raw JSON lines with colorized one-liner summaries (model, status, duration, TTFT, tokens), respects `NO_COLOR`
- **TTFT and processing time** — request handlers now capture time-to-first-token and processing duration in `request_end` events
- **Session tracking** — extract session identity (sessionId, clientName, clientVersion) from request headers via client identity parser, stored in new DB columns

### Dashboard — features

- **Session tracking UI** — logs sidebar shows live session info (client name, version, session ID) with stats panel
- **Sparkline trends** — StatCard now supports inline sparkline charts for trend visualization
- **Clickable timeline** — timeline nodes open phase detail on click
- **Model aggregation** — charts group low-traffic models into "Others" bucket for cleaner visualization

### Dashboard — UI improvements

- **Logs sidebar redesign** — restructured into 3 sections with timing breakdown (latency, TTFT, processing)
- **Skeleton loaders** — replaced empty loading states with skeleton placeholders for charts
- **Faster animations** — sped up all UI animations and transitions
- **Select component** — replaced native selects with shadcn Select across the app
- **Font consistency** — applied DM Sans font-display to all page headings

### Dashboard — refactoring

- **Design tokens** — extracted floating island radius, timeline colors, chart heights, and settings source badge styles into semantic design tokens
- **StatCard unification** — merged duplicate StatCard variants into single shared component
- **Chart utilities** — extracted `formatBucketTime` to shared `chart-config.ts`

### Bug fixes

- **Dedup request_end events** — fixed duplicate `request_end` events in stats hooks and concurrency timeline
- **Empty model filter** — filtered out empty model names from Select options

### Tests

- **451 proxy tests** (was 428) — added client identity unit tests, session tracking pure function tests, terminal-format tests

### Docs

- **Session tracking design doc** — added `docs/07-session-tracking.md`

## v1.0.0 (2026-03-16)

First stable release — version settings system, multi-platform local detection, dashboard polish, and brand unification to lowercase raven.

### Proxy — features

- **Settings persistence** — new `settings` SQLite table with key-value CRUD for version overrides
- **Local version detection** — auto-detect VS Code and Copilot Chat versions from local installations (VS Code, Cursor, Insiders, VSCodium) across macOS, Linux, and Windows
- **Dynamic Copilot version** — replaced hardcoded `COPILOT_VERSION = "0.26.7"` with `state.copilotChatVersion`, resolved at startup via priority chain: DB override → local detection → AUR fetch → fallback
- **Settings API** — `GET/PUT/DELETE /api/settings` with semver validation, effective value + source tracking, and live state update
- **Version source tracking** — state tracks whether each version came from override, local, aur, or fallback

### Dashboard — features

- **Settings page** — view effective versions with source badges (Override / Local / AUR / Fallback), input override values, save and reset controls with inline error feedback
- **Per-page tab titles** — Next.js metadata template `"%s — raven"` with unique titles per page (e.g. "Logs — raven", "Copilot Models — raven")
- **Copilot models table** — unified column widths across vendor tables via `table-fixed` layout with percentage-based columns

### Dashboard — UI improvements

- **Logs page** — redesigned with left-right split layout, card-based request cards with timeline visualization, real-time session stats panel, reverse chronological order, scroll-to-top FAB, copy button
- **Home page** — merged Overview and Requests into single page with stat cards + charts + embedded request log

### Bug fixes

- **Semver validation** — settings API rejects non-semver values with 400 to prevent corrupting upstream request headers
- **Error feedback** — settings save/reset shows inline error message on proxy 4xx/5xx or network failure
- **Copilot models table** — fixed duplicate React keys
- **TypeScript** — resolved strict type errors in settings-content component

### Brand & docs

- **Brand unification** — standardized to lowercase `raven` across metadata titles, sidebar, docs
- **README rewrite** — updated per project standards: lowercase brand, 404 test count, full docs index, new features documented
- **docs/README.md** — added entries for docs 02–06

## v0.3.0 (2026-03-16)

Major infrastructure release — complete proxy rewrite, real-time logging system, API key management, and dashboard test suite from zero to 145 tests with 5 bug fixes.

### Proxy — rewrite

- **Full proxy rewrite** — rebuilt from copilot-api reference into clean Hono architecture with DI, request sinks, and structured routes
- **Structured logging** — `LogEmitter` event bus with ring buffer, WebSocket `/ws/logs` endpoint with auth and backfill, terminal JSON sink, and DB sink for request persistence
- **Request instrumentation** — all routes emit structured log events (`request_start`, `request_end`, `sse_chunk`, `upstream_error`) with ULID `requestId` linking
- **SSE improvements** — unified SSE module replacing fetch-event-stream, keepalive heartbeat to prevent idle timeout disconnects, error events forwarded to client on upstream failure
- **Token refresh** — rewritten as retry chain with exponential backoff (capped at MAX_BACKOFF_MS), injected timer factory for testability

### Proxy — bug fixes

- **Copilot token refresh** — added exponential backoff to prevent hammering upstream on transient failures
- **Upstream stream failure** — now sends error events to client instead of silently dropping
- **ALLOWED_EMAILS trap** — prevented silent rejection of all logins when env var is malformed
- **Backward pagination** — enabled cursor-based backward navigation in timestamp sort mode
- **Model deduplication** — deduplicate model IDs in connection-info response
- **Route mount paths** — corrected to match copilot-api conventions
- **useLogStream** — fixed stale paused closure and duplicate reconnect on both "disconnected" and "error" events

### Dashboard — features

- **Real-time log viewer** — `/logs` page with live SSE stream, level filtering, pause/resume, request ID isolation
- **SSE bridge route** — `/api/logs/stream` bridges upstream WebSocket to SSE for browser consumption
- **Connect page** — API key management dashboard with create/revoke/delete flows, connection info, code examples
- **API key management routes** — full CRUD: GET/POST `/api/keys`, DELETE `/api/keys/[id]`, POST `/api/keys/[id]/revoke`
- **Multi-key auth middleware** — replaced single-key auth with DB-backed multi-key system
- **Key-based attribution** — requests tagged with the API key used for authentication
- **Sidebar redesign** — collapsible nav groups for better organization

### Dashboard — bug fixes

- **handleAction error handling** — API key revoke/delete now catches fetch failures and shows error feedback (was unhandled)
- **Error message format** — CreateKeyDialog now handles both `{ error: "string" }` and `{ error: { message: "string" } }` response formats
- **handleRefresh error handling** — AccountContent and CopilotModelsContent now catch fetch failures and show error feedback (was silently swallowed in `finally`)
- **Clipboard writeText** — CopyButton (shared and inline) now handles `navigator.clipboard.writeText` rejection gracefully

### Tests

- **Proxy** — 403 unit tests (was 184), pushed all source files to 95%+ line coverage; added tests for GitHub services, poll-access-token, token.ts lifecycle, keepalive, paths, connection-info, and VSCode version
- **Dashboard** — 145 tests across 11 files (was 0); covers lib/proxy, all BFF routes, SSE bridge, useLogStream hook, 3 component interaction suites, proxy auth enforcement, and NextAuth config/signIn callback
- **Test infrastructure** — Vitest with node default environment, jsdom opt-in for component tests, vi.resetModules + vi.stubEnv pattern for env-dependent modules

## v0.2.2 (2026-03-15)

Copilot API parity — closed functional gaps against the copilot-api reference project so the proxy works end-to-end with Claude Code, Cursor, and Continue.

### Proxy — bug fixes

- **tool_choice "none"** — was silently mapped to "auto", causing models to invoke tools when they shouldn't
- **Empty choices crash** — Copilot returns `choices: []` for `tool_choice: "none"` with tools; `translateResponse` now handles this gracefully
- **content_filter finish_reason** — now maps to `end_turn` instead of `null`
- **Streaming usage incomplete** — `message_delta` now includes `input_tokens` and `cache_read_input_tokens`, not just `output_tokens`

### Proxy — new features

- **Vision header** — auto-detects `image_url` content parts and sets `copilot-vision-request: true` header for screenshot analysis
- **X-Initiator header** — detects agent conversations (assistant/tool roles) and sets `x-initiator: agent` for correct rate-limit tier
- **max_tokens auto-fill** — defaults to 16384 when clients omit `max_tokens` on the OpenAI route
- **`/v1/messages/count_tokens`** — character-based token estimation with Claude correction factor (×1.15), tool overhead (+346), MCP detection; zero new dependencies
- **`/v1/embeddings`** — forwards to Copilot embeddings API
- **No-prefix routes** — `/chat/completions` and `/embeddings` aliases for backward compatibility
- **Dynamic model list** — `/v1/models` now fetches from upstream Copilot API with caching, instead of a hardcoded list

### Tests

- 184 unit tests passing (was 182)
- 9 E2E tests across 4 orthogonal layers: protocol conformance, streaming translation, feature parity, regression guard

### Dashboard

- **Recharts hydration fix** — resolved SSR/CSR mismatch

## v0.2.1 (2026-03-15)

Copilot upstream visibility — fetch real model list and subscription info from GitHub APIs, display in two new dashboard pages.

### Proxy

- **Copilot models endpoint** — `GET /api/copilot/models` fetches available models from `api.githubcopilot.com/models`, cached in memory with `?refresh=true` support
- **Copilot user endpoint** — `GET /api/copilot/user` fetches subscription/entitlement info from `api.github.com/copilot_internal/user`, same caching strategy
- **CopilotClient.fetchModels()** — new method on the client interface for upstream model discovery

### Dashboard

- **Copilot Models page** — table grouped by vendor (Anthropic, Azure OpenAI, Google, OpenAI), sorted by max prompt tokens descending, inline copy-to-clipboard on model IDs
- **Copilot Account page** — subscription overview cards, SVG circular progress rings for quota (percentage center label, ∞ icon for unlimited), feature toggles list, endpoints table, catch-all for unknown API fields with JSON pretty-print
- **Sidebar** — added Copilot Models and Account navigation items

## v0.2.0 (2026-03-15)

First feature-complete release — proxy + dashboard MVP.

### Proxy

- **GitHub Copilot auth** — Device flow login with token persistence, dual-layer token manager (GitHub OAuth + Copilot JWT) with auto-refresh
- **Anthropic ↔ OpenAI translation** — Full request/response translation between Anthropic and OpenAI formats, streaming state machine for SSE
- **API endpoints** — `POST /v1/messages` (Anthropic), `POST /v1/chat/completions` (OpenAI), `GET /v1/models`
- **Request logging** — SQLite-backed request log with stats queries (overview, timeseries, models, recent)
- **Stats & query API** — `GET /api/stats/*` and `GET /api/requests` with filtering, sorting, cursor/offset pagination
- **Security** — API key auth middleware with timing-safe comparison

### Dashboard

- **Design system** — Basalt design system with Raven slate-blue theme, 3-tier luminance, 24-color chart palette
- **Layout** — Collapsible sidebar, floating island content area, dark mode with FOUC prevention, mobile responsive
- **Overview page** — Stat cards (requests, tokens, latency, error rate) + area/bar/line charts
- **Request log page** — Sortable table with model/status/format filters, cursor and offset pagination
- **Model stats page** — Pie chart (request distribution), bar chart (token consumption), detail table
- **Error handling** — Explicit error state UI instead of silent zero-data fallback
- **Dynamic filters** — Model filter list fetched from proxy at runtime
- **Server components** — AppShell refactored to minimize client boundary hydration cost

### Infrastructure

- Bun workspace monorepo (`packages/proxy` + `packages/dashboard`)
- Husky pre-commit (tests) and pre-push (tests + perf + lint + typecheck) hooks
- ESLint strict + Prettier
- 187 proxy tests passing
