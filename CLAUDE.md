# Raven — Project Instructions

## Architecture

Bun workspace monorepo: `packages/proxy` (Hono, port 7033) + `packages/dashboard` (Next.js 16, port 7032).

## Testing

### Proxy tests — anti-ban protocol

The proxy interacts with GitHub Copilot's upstream API. Automated tests that hit real endpoints risk triggering rate limits or account bans. Follow these rules strictly:

- **Never** send real requests to `api.githubcopilot.com` in tests
- **Always** mock HTTP calls to upstream services (GitHub OAuth, Copilot token, Copilot chat completions)
- **Never** use real GitHub OAuth tokens or Copilot JWTs in test fixtures — use obviously fake values
- **Never** run load tests or rapid-fire requests against real endpoints
- **Never** commit real tokens, even expired ones, into test files or fixtures
- If a test requires integration with the real upstream, it must be explicitly gated behind an env flag (e.g. `RAVEN_INTEGRATION=true`) and must **never** run in CI or pre-commit hooks

### Running tests

```bash
bun run test        # all proxy unit tests (187 tests)
bun run test:perf   # performance benchmarks (SSE parsing, translation)
```

## Retrospective
