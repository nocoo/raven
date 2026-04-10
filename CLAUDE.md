# Raven — Project Instructions

## Project Positioning

Research-oriented, open-source, personal-use only. Not designed for multi-user deployment or server hosting. Runs locally.

## Architecture

Bun workspace monorepo: `packages/proxy` (Hono, port 7024) + `packages/dashboard` (Next.js 16, port 7023).

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

### Test status (2026-03-27)

| Package | Runner | Tests | Pass | Coverage (stmts) | Threshold | Status |
|---------|--------|-------|------|-------------------|-----------|--------|
| proxy | bun:test | 584 | 584 | 91.8% | 90% | ✅ |
| dashboard | vitest 4 + jsdom | 236 | 236 | 98.2% | 90% | ✅ |

**L1 (UT)**: All 820 tests pass. Dashboard coverage excludes pure UI components (shadcn, charts, layout, settings pages, login) — only business logic (API routes, hooks, lib, auth) is measured.

**L2 (API E2E)**: `bun run test:e2e` — auto-starts proxy, runs against real upstream. Manual only (anti-ban protocol).

**L3 (UI E2E)**: `bun run test:ui` — 25 Playwright tests across 5 specs for dashboard. Auto-starts proxy + dashboard. Manual only.

**G1 (Static Analysis)**: Both packages pass `eslint` and `tsc --noEmit` (with strict extras) with 0 errors, 0 warnings. Pre-commit runs lint-staged (incremental) + full typecheck.

**G2 (Security)**: `bun run gate:security` — osv-scanner + gitleaks. Wired into pre-push hook.

**D1 (Test Isolation)**: E2E and Playwright tests use isolated `data/raven-test.db` via `RAVEN_DB_PATH` env var. Test data never touches production `data/raven.db`.

### Pre-commit hook

Runs `bun run test:all && bunx lint-staged && bun run typecheck` — enforces L1 (all tests + coverage thresholds) and G1 (incremental lint + types) on every commit.

### Pre-push hook

Runs `bun run gate:security` (G2). L2 E2E tests are manual-only (anti-ban protocol). L3 Playwright is manual-only.

### Package manager — bun only

This monorepo uses **bun workspaces** exclusively. The lockfile is `bun.lock`. Never run `pnpm install` or `npm install` in any package — mixing package managers creates duplicate dependency instances (e.g. dual React copies) that cause silent runtime failures in tests and dev server.

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
