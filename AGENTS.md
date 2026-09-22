# Raven

Personal local model-API proxy and dashboard for GitHub Copilot and configured upstream providers.
Profile: ts-worker-web (Bun server with local SQLite; no Cloudflare runtime).
Direction: [architecture](docs/20-architecture-refactor.md), [operations](docs/26-agent-operations.md).

## Sources of Truth

This file is the contract; hooks, CI and config enforce it. Raise weaker enforcement to match, never reduce requirements. Frameworks must not replace this handbook.

Maintain project instructions only in this root `AGENTS.md`. Do not create nested instruction files or any `CLAUDE.md`. Dashboard disables Next.js agent-file generation with `agentRules: false`; consult the installed Next.js guides in `packages/dashboard/node_modules/next/dist/docs/` before changing framework APIs.

| Fact | Where |
| --- | --- |
| Human docs | [README.md](README.md), [docs/README.md](docs/README.md) |
| Version | Root/dashboard `package.json`, `scripts/release.ts` |
| Enforcement | `.husky/`, hook TS scripts, CI, Vitest configs and `docs/20-baseline.json` |
| Environment | Ignored Proxy/Dashboard `.env.local`; package `.env.example` files |
| Accidents | [Retrospective.md](Retrospective.md) |

## Project Invariants

- Personal local research is the primary scope. Preserve API versus internal management keys and GitHub OAuth versus Copilot JWT distinctions; do not weaken authentication when a database is empty.
- Seven-layer proxy architecture, seven established strategies and the shared `protocol-converted` strategy follow [operations](docs/26-agent-operations.md). Composition is the sole routes↔strategies/upstream bridge; strategies receive injected dependencies; protocols remain pure.
- Share server-tool interception through the existing decorator; preserve correct JSON/SSE shapes and raw model IDs. Do not rewrite model names to compensate for a client's display bug.
- Tokens/database belong in platform user directories with private permissions, not Git. Preserve `RAVEN_CONFIG_DIR`, `RAVEN_DATA_DIR`, `RAVEN_TOKEN_PATH`, `RAVEN_DB_PATH` and legacy migration semantics.
- Upstream HTTP is always mocked in unit/in-process route tests. Never place real tokens in fixtures or automatically exercise a real Copilot/provider account.
- Any separately authorized live diagnostic stops at the first upstream error, no retry/loop/load testing, one request per case. It does not qualify as isolated 6DQ proof.
- Use Bun workspaces only; mixing package managers can create duplicate React instances. Keep MVVM and the shared log-stream path/ring-buffer/event contracts documented in [operations](docs/26-agent-operations.md).

## Stack / Layout

| Component | Choice |
| --- | --- |
| Proxy | `packages/proxy`, Bun/Hono, SQLite, protocol/SSE adapters |
| Dashboard | `packages/dashboard`, Next.js/React, Basalt, SWR/Recharts |
| Quality | TypeScript 7 strict, Biome, Vitest, bun:test, Playwright |
| Support | Root `scripts/` gates; dependency-cruiser architecture rules |

## Commands

Run from root with Bun 1.3.11+ and the Node.js 26 release pinned in [.node-version](.node-version). CI reads the same Node version file; use its pinned Bun version for CI reproduction.

```sh
bun install --frozen-lockfile
bun run dev
bun run typecheck
bun run lint
bun run build
bun run test:all
bun run test:root
bun run test:l2
bun run gate:coverage
bun run gate:arch
bun run gate:security
```

`dev`/`start:proxy` perform real GitHub/Copilot authentication; they are not test setup. Proxy needs separate `RAVEN_API_KEY` and `RAVEN_INTERNAL_KEY`; Dashboard uses matching internal key and `RAVEN_PROXY_URL`. `test:e2e` uses real configuration/database/upstream; `test:ui` uses test DB but still needs real GitHub auth. Do not run those for routine verification; a fully isolated local system runner is planned.

After a production build, `bun run scripts/verify-routing-ui.ts` exercises Routing/Upstreams/Connect/Requests with per-run SQLite, synthetic credentials, random loopback ports and a local fixture upstream. It preserves screenshots and a report outside the repository and removes its runtime state. This bounded workflow does not establish complete endpoint/workflow coverage or change the planned L2/L3/D1 status.

## Verification

6DQ retains its name; former G1 merged into unified L1 on 2026-09-21. Scope: L1/L2/L3, G2 and D1. Follow the maintained `system0-6dq-l1` skill for the pre-commit contract. Status: `enforced`, `planned`, `manual`, `N/A`. No focused/skipped tests; all four L1 metrics ≥95%, preserving stricter baseline floors.

| Piece | Requirement and current reality | Status | Evidence |
| --- | --- | --- | --- |
| L1 coverage: Proxy | Four metrics ≥95%, plus baseline line floor ≥97.5%, ≤0.1pp regression and no untested files | enforced | `gate:coverage` retains the stronger line/directory baseline, regression and untested-file rules; Vitest enforces all four 95% thresholds |
| L1 coverage: Dashboard | Four metrics ≥95% | enforced | Dashboard tests and CI enforce all four 95% thresholds on the declared scope |
| L1 coverage: scripts | Four metrics ≥95% | enforced | The baseline gate explicitly runs the dedicated Bun/Istanbul config for the declared `scripts/lib` scope; reports are isolated in `coverage/scripts` |
| L2 | Every API endpoint/method through real isolated HTTP/SQLite | planned | CI `test:l2` is in-process route/handler tests with mocked upstream; legacy live E2E uses real state |
| L3 | Real isolated dashboard/auth/provider workflows | planned | Playwright manual runner uses real auth and fixed test DB |
| L1 complete contract | Coverage above plus strict types, zero-warning/error check-only Biome, architecture boundaries and installed index-snapshot rejection | planned | Configured coverage/static subchecks run in hooks; lint-staged commands are check-only. Hooks still inspect working files; complete index isolation, failure-rejection evidence and <30s timing remain unverified |
| G2 | Required OSV and gitleaks, fail when absent | enforced | `gate:security`, pre-push and CI |
| D1 | Per-run test DB/config/token paths and local fixture upstream | planned | Legacy HTTP E2E reuses real database; browser fixed test DB still uses real credentials |
| Build | Next production bundle | manual | Root `build`; mandatory for runtime/bundler changes |
| Docs | Protocol and gate-baseline evidence kept current | manual | Numbered guide review |

Pre-commit runs `gate:coverage`, Dashboard/script tests, lint-staged/types/micro-gates and staged secrets in parallel. Pre-push runs the same baseline gate, architecture, full lint and G2 on working files. Never replace baseline entry with bare Vitest. Target: check-only index unified L1 <30s, stdin pushed-ref local L2/G2 <3min; no hook bypass or soft-security mode.

## Resources / Isolation

| Purpose | Resource | Policy |
| --- | --- | --- |
| Daily dev | Dashboard 7023 / Proxy 7024 | Actual account/config/database |
| Unit/routes | Mocked upstream and synthetic state | No real token/provider requests |
| Legacy browser | Fixed `packages/proxy/data/raven-test.db`, dev ports | Partial isolation; complete per-run local harness required |

For local development previews and manual browser verification, open **https://raven.dev.hexly.ai** through the machine's Caddy reverse proxy. Verify the mapping in `/opt/homebrew/etc/Caddyfile` before opening the browser. Ports 7023 (Dashboard) and 7024 (Proxy) are internal upstreams; loopback URLs are reserved for internal service calls and isolated automated tests. Use the Caddy HTTPS URL in user-facing preview links. Do not change certificates or Keychain trust for ordinary development.

Physical test isolation includes DB, credentials, configuration and upstream receiver. Fresh per-run directories plus guards before seed/reset/cleanup must separate tests from daily-dev and production. This Bun/SQLite application needs no remote test Workers or Cloudflare D1 resources.

## Operations / Release

Authorized release entry: `bun run release`; build and verify the intended version/CI. Normal use remains local. Network deployment requires Google OAuth for Dashboard, explicit API/management access controls and IP whitelist; follow [VPS guide](docs/14-vps-deployment.md). Keep live diagnostics separate from automated tests and never imply a dry run published or validated live upstreams.

## Retrospective

Full narratives live in [Retrospective.md](Retrospective.md). Keep recurring rules brief; cross-project lessons belong in global rules/nmem and deterministic checks in hooks/tests.

- Use exactly the same coverage-baseline gate in hooks and CI; preserve protocol event shapes and authentication compatibility.
