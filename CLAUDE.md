# Raven — Project Instructions

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
