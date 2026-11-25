# Raven

Personal local model-API proxy (`packages/proxy`: Bun/Hono, SQLite, protocol/SSE adapters; no Cloudflare runtime) and dashboard (`packages/dashboard`: Next.js 16/React, `@nocoo/basalt`, SWR/Recharts) for GitHub Copilot and configured upstream providers.
Tooling: TypeScript 7 strict, Biome, Vitest, `bun:test`, Playwright, root `scripts/` gates, `dependency-cruiser`.
Docs: [README.md](README.md) · [Docs](docs/README.md) · [Architecture](docs/20-architecture-refactor.md) · [Operations](docs/26-agent-operations.md) · [Systemone](docs/30-systemone.md) · [Docker](docs/31-docker-deployment.md) · [VPS](docs/14-vps-deployment.md) · [Retrospective](Retrospective.md)

## Commands

Run from root with Bun 1.3.11+ and the Node.js 26 release pinned in [.node-version](.node-version) (CI reads the same file; match CI's pinned Bun version when reproducing CI). Local `.env.local` files are ignored; variable names live in `packages/proxy/.env.example`, `packages/dashboard/.env.example`, and `.env.docker.example`.

```sh
bun install --frozen-lockfile
bun run dev                  # Dashboard :7023 / Proxy :7024 (real GitHub/Copilot auth)
bun run typecheck            # S1
bun run lint                 # S2 check-only, 0 warnings
bun run build                # B1 Next.js production bundle
bun run test:all             # L1 workspace tests (Proxy + Dashboard)
bun run test:root            # L1 workspace + scripts unit tests
bun run test:l2              # L3 in-process route/handler tests (mocked upstream)
bun run gate:coverage        # L1 baseline gate (Proxy >=80% floor + scripts/lib >=80%)
bun run gate:arch            # dependency-cruiser + fetch-boundary
bun run gate:security        # G1/G2 gitleaks + osv-scanner (hard-fail when missing)
bun run gate:docker-context  # CI .dockerignore build-input verification
```

- `dev` and `start:proxy` perform real GitHub/Copilot auth (not test setup). Proxy requires separate `RAVEN_API_KEY` and `RAVEN_INTERNAL_KEY`; Dashboard uses matching `RAVEN_INTERNAL_KEY` and `RAVEN_PROXY_URL`.
- Do not run `test:e2e` (real config/DB/upstream) or `test:ui` (fixed test DB + real GitHub auth) for routine verification; a full isolated system runner is `planned`.
- After `bun run build`, `bun run scripts/verify-routing-ui.ts` tests Routing/Upstreams/Connect/Requests using per-run SQLite, synthetic keys, random loopback ports, and a fixture upstream (reports saved outside).

## Invariants

- Personal local research is primary scope. Keep client API vs internal management keys and GitHub OAuth vs Copilot JWT distinct; never weaken auth when the DB is empty.
- Proxy follows [operations](docs/26-agent-operations.md): 7 layers, `composition/` is sole `routes/`↔`strategies/`/`upstream/` bridge, injected strategy deps (incl. `protocol-converted`/native), pure `protocols/`.
- Share server-tool interception through the existing decorator; preserve JSON/SSE shapes and raw model IDs. Never rewrite model names to compensate for client display bugs.
- Native `/v1/systemone`, `/v1/decisions`, `/v1/images/generations`, and multipart `/v1/images/edits` use exact Copilot catalog entries, validated token API hosts, and key-bound admission ([docs](docs/30-systemone.md)).
- Those native endpoints return raw JSON with no protocol conversion, inference retries, redirect following, or fabricated fields; Copilot image edits transport is verified by isolated tests only, not live.
- Management `/api/*` and `/ws/logs` require a loopback socket peer plus `RAVEN_INTERNAL_KEY` (never client API keys). Global/key IP whitelists share the IPv4/IPv6 core; geo lookup is Dashboard-only enrichment.
- Store tokens/DB in platform user dirs with private permissions, never Git. Preserve `RAVEN_CONFIG_DIR`, `RAVEN_DATA_DIR`, `RAVEN_TOKEN_PATH`, `RAVEN_DB_PATH`, and legacy migration semantics.
- Always mock upstream HTTP in unit and in-process route tests. Never place real tokens in fixtures or automatically exercise a real Copilot/provider account.
- Separately authorized live diagnostics stop at the first upstream error (one request/case, no retries/loops/load) and never qualify as isolated L2–L4 proof or imply dry runs validated live upstreams.
- Use Bun workspaces only (mixing package managers duplicates React). Preserve Dashboard MVVM and shared log-stream path/ring-buffer/event contracts in [operations](docs/26-agent-operations.md).
- Dashboard sets `agentRules: false`; consult `packages/dashboard/node_modules/next/dist/docs/` before changing Next.js APIs. Keep versions synced across root/dashboard `package.json` and `scripts/release.ts`.
- Authorized releases run `bun run release`; GitHub Releases trigger `docker-publish.yml` (`ghcr.io/nocoo/raven`, `linux/amd64`, proven CI) for `compose.prod.yaml` + `.env` ([Docker](docs/31-docker-deployment.md)).
- Network deployment requires Google OAuth for Dashboard, explicit API/management access controls, and IP whitelists ([VPS guide](docs/14-vps-deployment.md)).

## Quality & Local Gates

Follows `system1-quality`; hooks, CI, and config enforce this contract (raise weaker enforcement to match, never weaken requirements). CI slot definitions and pinned `base-ci` revision live in `.github/workflows/quality-slots.yml` (`quality / Z1: Gate` required on `main`, including `P1: Package`), and `.github/workflows/ci.yml` delegates directly to it. Status vocabulary: `enforced`, `planned`, `manual`, `N/A`.

- **L1 coverage (`enforced`)**: No focused/skipped tests; all 4 metrics >=80% (`v8`) for Proxy, Dashboard (excluding pure View `src/components/**` and `src/app/**/*.tsx`), and `scripts/lib` (`vitest.scripts.config.ts` → `coverage/scripts`).
- **Proxy baseline (`enforced`)**: `gate:coverage` enforces `docs/20-baseline.json` (>=80% line floor, per-dir floors, <=0.1pp regression, no new untested files); never swap for bare Vitest.
- **Exceptions / gaps**: `L2 Runtime` is `N/A` (covered by L1/L3); `L3 Integration` is `enforced` via in-process route tests (mocked upstream); isolated real-HTTP/SQLite `L3` and `L4 E2E` are `planned` (CI gated off).
- **Package & manual**: `P1 Package` (`enforced`) verifies Docker build context (`bun run gate:docker-context`); protocol and baseline doc updates are `manual`. `scripts/verify-routing-ui.ts` covers Routing flows only, not full `L3`/`L4`.
- **Pre-commit (`.husky/pre-commit`)**: Installed via `bun run prepare`. Runs staged `gitleaks` (`G1`), exports `git checkout-index` temp tree (`trap` cleanup), then `scripts/pre-commit.ts` in parallel (<30s target).
- **Pre-commit scope**: `gate:coverage`, Dashboard/scripts tests, `typecheck`, index-scoped Biome, and `fetch-boundary`; staged manifests must match worktree.
- **Pre-push (`.husky/pre-push`)**: Parallel `scripts/pre-push.ts` on working files: `gate:security` (`G1`/`G2`, hard-fail if missing), `gate:coverage`, `gate:arch`, full `lint` (<3min target).
- **Hook policy**: Stdin pushed-ref scoping and isolated local `B1`/`L3`/`L4` pre-push checks are `planned`; never bypass hooks or use soft-security mode.

## Resources & Isolation

| Lane | Endpoint / State | Boundary |
| --- | --- | --- |
| Daily dev | `https://raven.dev.hexly.ai` → Dashboard `:7023`, Proxy `:7024`; user data dir | Actual account/config/DB; verify `/opt/homebrew/etc/Caddyfile` before previewing |
| Unit / L2 | In-process handlers, mocked upstream, synthetic state | No real tokens or external provider calls |
| Isolated UI | Random loopback ports, per-run SQLite/dir, fixture upstream | `scripts/verify-routing-ui.ts`; synthetic credentials, cleans up runtime state |
| Legacy UI | Fixed `packages/proxy/data/raven-test.db`, dev ports | `test:ui` requires real GitHub auth; partial isolation only (not routine) |

- Use `https://raven.dev.hexly.ai` for local browser previews and user-facing links; ports `7023`/`7024` are internal upstreams and loopback URLs stay internal/test-only. Do not alter certs or Keychain trust.
- Physical test isolation requires fresh per-run DB/config/token dirs, a local fixture upstream, and guards before seed/reset/cleanup to separate tests from dev and prod. No Cloudflare Workers or D1 are needed.

## Retrospective

Record incident narratives in [Retrospective.md](Retrospective.md); promote recurring project constraints to `Invariants` above and deterministic checks to hooks/tests. Keep the same `gate:coverage` baseline entry in hooks and CI, and preserve protocol event shapes and authentication compatibility.
