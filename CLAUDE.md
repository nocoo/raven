# Raven — Project Instructions

## Project Positioning

Research-oriented, open-source, personal-use only. Not designed for multi-user deployment or server hosting. Runs locally.

## Architecture

Bun workspace monorepo: `packages/proxy` (Hono, port 7024) + `packages/dashboard` (Next.js 16, port 7023).

### Proxy layering (see `docs/20-architecture-refactor.md` for the full contract)

Seven layers, top → bottom. Each layer imports only from the layers below (enforced by `dependency-cruiser.config.cjs`):

1. **`routes/`** — HTTP entry points (Hono handlers). Owns request parsing, logging start, and composition dispatch. Must not import `strategies/` or `upstream/` directly.
2. **`composition/`** — the **sole bridge** between `routes/`, `strategies/`, and `upstream/`. `dispatch()` picks a strategy factory, builds it with state-derived deps, and drives the Runner.
3. **`core/`** — abstract `Strategy`/`Runner`/router contracts + `RequestContext`. Concretion-free: never imports `strategies/` or `upstream/`.
4. **`strategies/`** — seven `makeXxx(deps)` factories implementing the 7-method `Strategy` interface (`prepare` / `dispatch` / `adaptJson` / `initStreamState` / `adaptChunk` / `adaptStreamError` / `describeEndLog`). Per-strategy files (`strategies/*.ts`) read no `infra/state` — deps are injected. `strategies/support/` holds cross-strategy helpers (server-tool `decorate()`, effort-fallback, capability gates).
5. **`protocols/`** — pure translation zone (Anthropic ↔ OpenAI, SSE adapters, preprocess). No state, no logging, no Hono streaming.
6. **`upstream/`** — upstream HTTP clients (Copilot native, Copilot OpenAI, custom providers) registered via `composition/upstream-registry.ts`.
7. **`infra/` + `lib/` + `util/`** — state, auth, rate-limit, logging primitives, IDs.

**Seven strategies** (all registered in `composition/strategy-registry.ts`):
- `copilot-openai-direct` — `/v1/chat/completions` to Copilot
- `copilot-chat-via-responses` — `/v1/chat/completions` → Copilot `/responses` (responses-only models)
- `copilot-translated` — `/v1/messages` Anthropic → Copilot OpenAI
- `copilot-native` — `/v1/messages` to Copilot native endpoint (claude-* models)
- `copilot-responses` — `/v1/responses` to Copilot
- `custom-openai` — user-configured OpenAI-compatible providers
- `custom-anthropic` — user-configured Anthropic providers

**Server-tool interception** (Tavily `web_search`) runs via `strategies/support/server-tools.ts::decorate()`, which wraps `withServerToolInterception` + `request_end` log + JSON/SSE replay. Both translated and native paths share it.

## Data Directory Structure

Runtime data is stored in platform-standard user directories, not in the source tree:

**macOS:**
- Config: `~/Library/Application Support/raven/`
  - `github_token` (0600 permissions)
- Data: `~/Library/Application Support/raven/`
  - `raven.db` (SQLite database)

**Linux:**
- Config: `~/.config/raven/`
  - `github_token` (0600 permissions)
- Data: `~/.local/share/raven/`
  - `raven.db` (SQLite database)

**Environment overrides:**
- `RAVEN_CONFIG_DIR` — override config directory
- `RAVEN_DATA_DIR` — override data directory
- `RAVEN_TOKEN_PATH` — override token file path
- `RAVEN_DB_PATH` — override database path

**Migration:** Legacy `./data/` files are automatically migrated to new locations on first run.

## Testing

### Proxy tests — anti-ban protocol

The proxy interacts with GitHub Copilot's upstream API. Careless testing can trigger rate limits or account bans.

**Unit tests** (`bun run test`): Always mock upstream HTTP calls. Never use real tokens in fixtures.

**E2E tests** (`bun run test:e2e`): Hit the real running proxy (localhost:7024) which forwards to real Copilot API. Rules:
- **Fail fast**: stop the entire suite on first upstream error (non-2xx from Copilot). Do not retry, do not continue.
- **Minimal requests**: each test sends exactly 1 request. No loops, no load testing, no rapid-fire.
- **Never commit real tokens** into test files or fixtures.
- **Require proxy running**: skip gracefully if proxy is not reachable.
- E2E tests must **never** run in CI or pre-commit hooks — manual execution only.

### Running tests

```bash
bun run test        # proxy unit tests only (pre-commit hook)
bun run test:all    # proxy + dashboard unit tests
bun run test:perf   # performance benchmarks (SSE parsing, translation)
bun run test:e2e    # e2e tests (auto-starts proxy if needed)
bun run test:ui     # Playwright dashboard smoke tests (auto-starts both servers)
```

### Test status (2026-04-21)

| Package | Runner | Tests | Pass | Coverage (stmts) | Threshold | Status |
|---------|--------|-------|------|-------------------|-----------|--------|
| proxy | vitest | 1222 | 1222 | 95.6% | 90% | ✅ |
| dashboard | vitest 4 + jsdom | 277 | 277 | 98.6% | 90% | ✅ |
| e2e (L2) | bun:test | 41 | 41 | — | — | ✅ |

**L1 (UT)**: All 1499 tests pass. Dashboard coverage excludes pure UI components (shadcn, charts, layout, settings pages, login) — only business logic (API routes, hooks, lib, auth) is measured.

**L2 (API E2E)**: `bun run test:e2e` — uses production database to test real configurations (server-side tools, providers). Reuses running proxy if available, otherwise auto-starts one. Manual only (anti-ban protocol). **Requires `RAVEN_API_KEY`** — generate a temporary DB key via the proxy API before running (see below).

**L3 (UI E2E)**: `bun run test:ui` — 25 Playwright tests across 5 specs for dashboard. Auto-starts proxy + dashboard. Manual only.

**G1 (Static Analysis)**: Both packages pass `biome check` and `tsc --noEmit` (with strict extras) with 0 errors, 0 warnings. Biome lints `src/` + `test/` in one pass (config: `biome.json`). Pre-commit runs lint-staged (biome, incremental) + full typecheck.

**G2 (Security)**: `bun run gate:security` — osv-scanner + gitleaks. gitleaks runs at pre-commit (staged-only); full G2 runs at pre-push. CI runs both.

**D1 (Test Isolation)**: Playwright UI tests use isolated test database. L2 E2E tests use production database intentionally — they validate real upstream integration including server-side tools (Tavily web_search).

### Pre-commit hook

Runs in parallel via `scripts/pre-commit.ts`:
- **L1** `gate:coverage` (`scripts/check-coverage.ts` — proxy tests + §4.5 baseline floors / untested-file gate; **same entry as CI**)
- **L1** dashboard unit tests + `test:root` (scripts/ harness tests)
- **G1** lint-staged, typecheck, fetch-boundary, dynamic-delete, ts-expect-error
- **G2** gitleaks (staged-only)

Do **not** replace `gate:coverage` with bare `bun run test` / `--filter @raven/proxy test` — vitest thresholds alone miss baseline regressions CI catches.

### Pre-push hook

Runs in parallel via `scripts/pre-push.ts`:
- **G2** `gate:security` (osv-scanner + gitleaks)
- **L1** `gate:coverage` (again — same baseline gate as CI)
- **G1** `gate:arch` + full `lint`

L2 E2E and L3 Playwright remain manual-only (anti-ban).

### CI

GitHub Actions runs on push to main and PRs: L1 (`check-coverage.ts` job) + G1 + G2. L2/L3 need credentials / are optional in workflow.

### Package manager — bun only

This monorepo uses **bun workspaces** exclusively. The lockfile is `bun.lock`. Never run `pnpm install` or `npm install` in any package — mixing package managers creates duplicate dependency instances (e.g. dual React copies) that cause silent runtime failures in tests and dev server.

### Running E2E tests (L2) — step by step

E2E tests authenticate to the proxy via `RAVEN_API_KEY`. The proxy must be running with valid GitHub/Copilot credentials.

```bash
# 1. Ensure proxy is running
bun run dev:proxy   # or: proxy already running on :7024

# 2. Create a temporary API key via the proxy management API
#    (management endpoints are unauthenticated when no env key is set)
curl -s http://localhost:7024/api/keys -X POST \
  -H 'Content-Type: application/json' \
  -d '{"name":"e2e-test"}' | jq .key
# Returns: "rk-..."

# 3. Run e2e with the key
RAVEN_API_KEY=rk-... bun run test:e2e

# 4. Clean up: revoke the key after testing
curl -s http://localhost:7024/api/keys/<id>/revoke -X POST
# Or delete from Dashboard → Connect page
```

**Troubleshooting:**
- 401 errors on all tests → missing or invalid `RAVEN_API_KEY`, or GitHub token expired (re-auth by deleting `~/Library/Application Support/raven/github_token` and restarting proxy)
- Timeout failures (5s default) → upstream latency; retry with `--timeout 30000` or re-run individual tests
- To run specific tests: `RAVEN_API_KEY=rk-... bun test packages/proxy/test/e2e/<file> -t "test name" --timeout 30000`

## Debugging — Real-time log stream

The proxy has a built-in structured logging system with real-time WebSocket streaming. No third-party logging library — fully custom, based on `EventEmitter` + ring buffer.

### Observing live logs

Connect to the WebSocket endpoint while the proxy is running:

```bash
# listen to all levels (debug/info/warn/error)
bun -e '
const ws = new WebSocket("ws://localhost:7024/ws/logs?level=debug");
ws.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  const ts = new Date(ev.ts).toISOString().slice(11, 23);
  console.log(`[${ts}] ${ev.level.toUpperCase().padEnd(5)} ${ev.type.padEnd(15)} ${ev.msg}${ev.requestId ? ` (${ev.requestId.slice(0,8)})` : ""}`);
};'
```

If `RAVEN_API_KEY` is set or DB has API keys, append `&token=<key>` to the query string.

### Key concepts

- **Log levels**: `debug | info | warn | error`. Default level is `info` (configurable via `RAVEN_LOG_LEVEL` env var). Level gating happens before JSON serialization (zero cost for filtered-out events).
- **Event types**: `system`, `request_start`, `request_end`, `sse_chunk`, `upstream_error`. Each request carries a ULID `requestId` linking start → chunks → end.
- **Ring buffer**: Last 200 events cached in memory. New WebSocket connections receive backfill automatically.
- **Client commands**: Send JSON to the WebSocket to adjust filtering on the fly:
  - `{ "type": "set_level", "level": "debug" }` — change minimum level
  - `{ "type": "set_filter", "requestId": "..." }` — isolate a single request
  - `{ "type": "set_filter" }` — clear request filter
- **Three sinks**: terminal (JSON lines → stdout), WebSocket (real-time push), DB (`request_end` → SQLite).
- **Dashboard path**: proxy WebSocket → dashboard SSE bridge (`/api/logs/stream`) → `useLogStream` hook → `/logs` page UI.

## Remote Deployment (VPS)

See [docs/14-vps-deployment.md](docs/14-vps-deployment.md) for full guide. Key security requirements:

1. **Dashboard must use Google OAuth** — never deploy with Local mode on a public server. Local mode skips all authentication.
2. **Enable IP whitelist** — restrict API access to known client IPs via Dashboard Settings → IP Whitelist. Even with API key protection, IP whitelist provides defense-in-depth against key leakage.

## Retrospective

- `eea1083` mixed model list fix (proxy feature) with e2e test model update (test) in one commit. Should have been two: one for `models.ts`, one for `proxy.e2e.test.ts`. Always split source changes and test changes into separate commits when they serve different purposes.
- `6ea7485` wrongly switched `copilot_internal/user` from GitHub OAuth token to Copilot JWT, causing 401. Root cause: assumed all copilot_internal endpoints use the same auth — they don't. Both `/copilot_internal/v2/token` and `/copilot_internal/user` on `api.github.com` require `token ${githubOAuth}`, not `Bearer ${copilotJwt}`. Always verify auth by curl-testing the real endpoint before committing auth changes.
- `f477dcc` stream translator emitted `input: ""` (empty string) instead of `input: {}` (empty object) in `content_block_start` for `tool_use` blocks. Anthropic protocol requires an object. Clients silently failed to render tool calls (e.g. AskUserQuestion). Root cause: wrote the literal without checking the Anthropic SSE spec. Always verify emitted event shapes against the protocol spec or a known-good reference implementation.
- `a7c6fcf` deleted `RAVEN_API_KEY` env var support and `multiKeyAuth` env path entirely, breaking backward compatibility and removing `/api/*` auth. Three compounding errors: (1) removed a design-doc-mandated backward compat path without consulting the doc, (2) widened dev mode to "DB empty = no auth" which is a security regression when env key is set but DB has no keys yet, (3) left `/api/*` management endpoints unauthenticated while they should share the same auth. Root cause: user said "remove RAVEN_API_KEY" and I complied without cross-checking the design doc's compatibility requirements. Always re-read the design doc before making protocol-level changes, even if the user requests them conversationally.
- `34ae0f7` dashboard 56 tests FAIL blocking pre-commit. Root cause: someone ran `pnpm install` inside `packages/dashboard/` after `bun install`, creating a `.pnpm/` store alongside bun's `.bun/` symlinks. `react` resolved from `.pnpm/` (pnpm copy) while `@testing-library/react` resolved from root `.bun/` (bun copy) — two physical React instances = "Invalid hook call" on all component/hook tests. Fix: `rm -rf packages/dashboard/node_modules && bun install`. Also added `turbopack.root` to next.config.ts since Turbopack lost workspace root inference after the reinstall. Rule: never mix package managers in a monorepo; this project uses bun exclusively.
- `d15e6e6` + `8b9aad1` added dot→hyphen model-ID translation (`claude-opus-4.8` → `claude-opus-4-8`) to Raven's `/v1/models` route, then native `adaptChunk`/`adaptJson` + `preprocess.ts` — both reverted same-day (`d0c647e`, `809c3c3`), net zero. Root cause: assumed the "Opus 4 instead of Opus 4.8" display glitch was Raven's to fix. It is **not** — Copilot upstream accepts both dot and hyphen forms; the display name is resolved client-side by `ccstatusline`'s `includes()` matching, which only recognizes the hyphen form. Correct fix lives in the **cc switch** client config (use `claude-opus-4-8`), and Raven stays a passthrough on model IDs. Rule: when a symptom only manifests in a client's display, confirm the upstream actually mishandles the value before adding translation logic to the proxy — don't make Raven compensate for a client-side resolver. The "fix + revert" pair is a closed investigation, not an open bug.
- v2.5.0 release: local pre-push reported L1 coverage ✅ while CI `check-coverage.ts` failed (protocols/ floor + untested new files + global regression vs `docs/20-baseline.json`). Root cause: `scripts/pre-push.ts` ran bare `bun run --filter @raven/proxy test` (vitest % thresholds only) and never invoked the §4.5 baseline gate that CI uses. Fix: pre-commit + pre-push both run `gate:coverage` → `scripts/check-coverage.ts`; unit test locks the wiring. Rule: any hook labeled "coverage" must call the same entrypoint as CI — never a weaker substitute.
