# Raven — Project Instructions

## Project Positioning

Research-oriented, open-source, personal-use only. Not designed for multi-user deployment or server hosting. Runs locally.

## Architecture

Bun workspace monorepo: `packages/proxy` (Hono, port 7033) + `packages/dashboard` (Next.js 16, port 7032).

## Testing

### Proxy tests — anti-ban protocol

The proxy interacts with GitHub Copilot's upstream API. Careless testing can trigger rate limits or account bans.

**Unit tests** (`bun run test`): Always mock upstream HTTP calls. Never use real tokens in fixtures.

**E2E tests** (`bun run test:e2e`): Hit the real running proxy (localhost:7033) which forwards to real Copilot API. Rules:
- **Fail fast**: stop the entire suite on first upstream error (non-2xx from Copilot). Do not retry, do not continue.
- **Minimal requests**: each test sends exactly 1 request. No loops, no load testing, no rapid-fire.
- **Never commit real tokens** into test files or fixtures.
- **Require proxy running**: skip gracefully if proxy is not reachable.
- E2E tests must **never** run in CI or pre-commit hooks — manual execution only.

### Running tests

```bash
bun run test        # unit tests (187 tests, all mocked)
bun run test:perf   # performance benchmarks (SSE parsing, translation)
bun run test:e2e    # e2e tests (requires proxy running on :7033)
```

## Retrospective

- `eea1083` mixed model list fix (proxy feature) with e2e test model update (test) in one commit. Should have been two: one for `models.ts`, one for `proxy.e2e.test.ts`. Always split source changes and test changes into separate commits when they serve different purposes.
- `6ea7485` wrongly switched `copilot_internal/user` from GitHub OAuth token to Copilot JWT, causing 401. Root cause: assumed all copilot_internal endpoints use the same auth — they don't. Both `/copilot_internal/v2/token` and `/copilot_internal/user` on `api.github.com` require `token ${githubOAuth}`, not `Bearer ${copilotJwt}`. Always verify auth by curl-testing the real endpoint before committing auth changes.
- `f477dcc` stream translator emitted `input: ""` (empty string) instead of `input: {}` (empty object) in `content_block_start` for `tool_use` blocks. Anthropic protocol requires an object. Clients silently failed to render tool calls (e.g. AskUserQuestion). Root cause: wrote the literal without checking the Anthropic SSE spec. Always verify emitted event shapes against the protocol spec or a known-good reference implementation.
- `a7c6fcf` deleted `RAVEN_API_KEY` env var support and `multiKeyAuth` env path entirely, breaking backward compatibility and removing `/api/*` auth. Three compounding errors: (1) removed a design-doc-mandated backward compat path without consulting the doc, (2) widened dev mode to "DB empty = no auth" which is a security regression when env key is set but DB has no keys yet, (3) left `/api/*` management endpoints unauthenticated while they should share the same auth. Root cause: user said "remove RAVEN_API_KEY" and I complied without cross-checking the design doc's compatibility requirements. Always re-read the design doc before making protocol-level changes, even if the user requests them conversationally.
