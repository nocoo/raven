# Raven

GitHub Copilot proxy with Anthropic/OpenAI API translation and a statistics dashboard.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.3
- Git

## Getting Started

```bash
# Install dependencies
bun install

# Start proxy (port 7033)
bun run dev:proxy

# Start dashboard (port 7032)
bun run dev:dashboard

# Start both
bun run dev
```

## Development

### Git Hooks (Husky)

Husky is configured to enforce code quality on every commit and push. Hooks are checked into the repository under `.husky/` and shared across the team.

| Hook | What it runs | Purpose |
|---|---|---|
| **pre-commit** | `bun test` | Unit tests must pass before every commit |
| **pre-push** | `bun test && bun run test:perf && bun run lint && bun run typecheck` | Full gate: UT + performance benchmarks + ESLint + TypeScript |

> **Important:** Skipping hooks with `--no-verify` is not allowed. If a hook fails, fix the issue before committing.

After cloning, run `bun install` — the `prepare` script will set up Husky automatically.

### Running Tests

```bash
# Unit tests (all packages)
bun test

# Performance benchmarks (proxy translation layer + SSE parser)
bun run test:perf
```

### Linting & Type Checking

```bash
# ESLint (all packages)
bun run lint

# TypeScript type check (all packages)
bun run typecheck
```

### Test Coverage

Target: **≥ 90%** line coverage for the proxy package.

```bash
# Run tests with coverage report
bun test --coverage
```

Modules that are hard to test (e.g., entry points with side effects) should be split into pure-function modules that are easy to unit test.

### Project Structure

```
raven/
├── packages/
│   ├── proxy/          # Bun + Hono API proxy (port 7033)
│   │   ├── src/        # Source code
│   │   └── test/       # Tests (unit, perf)
│   └── dashboard/      # Next.js statistics dashboard (port 7032)
├── docs/               # Design documents
├── .husky/             # Git hooks (shared via repo)
└── eslint.config.js    # Shared ESLint config
```
