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
