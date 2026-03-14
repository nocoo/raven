# Changelog

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
