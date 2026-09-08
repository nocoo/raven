<p align="center">
  <img src="../assets/brand/icon-rounded.png" width="128" alt="Raven logo" />
</p>
<h1 align="center">Raven</h1>
<p align="center">Adapt GitHub Copilot and custom model upstreams locally, with a dashboard for API activity.</p>
<p align="center">
  <a href="../README.md">简体中文</a>
</p>

## What it does

Raven is a model API proxy for personal research and development. A Bun / Hono service accepts requests such as Anthropic Messages and OpenAI Chat Completions, selects GitHub Copilot or a configured custom upstream by model and protocol, and handles JSON and SSE responses. A Next.js Dashboard provides request analytics, live logs, connection details, and upstream settings.

It depends on upstream account access, model capabilities, and service availability. Startup currently always authenticates with GitHub and Copilot, so working Copilot credentials are still required even if you intend to use only custom upstreams afterward.

## Features

| Task | Current behavior |
| --- | --- |
| Adapt client protocols | Provide Messages, Chat Completions, Responses, and Embeddings endpoints within the routing limits below. |
| Select an upstream | Match custom OpenAI / Anthropic providers by exact model name or a prefix pattern ending in `*`; Copilot is the default. |
| Review API activity | Track requests, tokens, latency, time to first token, and errors, grouped by model, client, session, or provider. |
| Inspect live status | Read live logs, Copilot token-refresh status, the upstream model catalog, and account quota information. |
| Manage connections | Create and revoke database API keys; configure upstreams, an IP allowlist, and a SOCKS5 outbound proxy. |
| Run web searches | Use Tavily for `web_search` in supported Messages paths; a Tavily key is required. |

| Client endpoint | Current upstream support |
| --- | --- |
| `POST /v1/messages` | Native Copilot Claude or OpenAI-protocol translation, plus custom OpenAI / Anthropic providers. Native capabilities depend on the model catalog and endpoint information. |
| `POST /v1/chat/completions` | Copilot or custom OpenAI providers; Copilot Responses-only models are automatically adapted to the Responses upstream. |
| `POST /v1/responses` | Copilot; custom providers are rejected. |
| `POST /v1/embeddings` | Copilot's embeddings endpoint. |
| `GET /v1/models` | Query available model information. |

Automatic Messages adaptation to Responses-only upstreams is still a planned feature. OpenAI Chat requests also cannot route to custom Anthropic-format providers. Available models, context length, thinking, and tool capabilities depend on the actual catalog and upstream responses. `/v1/messages/count_tokens` is a local estimate and returns a fallback value when the model is missing or calculation fails.

## Usage

### Install and configure

Use Bun 1.3.11 or later, Node.js 24 LTS, and a GitHub account with Copilot access. This repository uses Bun workspaces.

```bash
git clone https://github.com/nocoo/raven.git
cd raven
bun install --frozen-lockfile
```

Generate separate random keys for client requests and Dashboard management, for example by running this twice:

```bash
openssl rand -hex 32
```

Create `packages/proxy/.env.local`, replacing the examples with your generated values:

```dotenv
RAVEN_API_KEY=replace-with-client-key
RAVEN_INTERNAL_KEY=replace-with-management-key
```

Create `packages/dashboard/.env.local` with the same management key as the Proxy:

```dotenv
RAVEN_PROXY_URL=http://127.0.0.1:7024
RAVEN_INTERNAL_KEY=replace-with-management-key
```

Full examples are in the [Proxy template](../packages/proxy/.env.example) and [Dashboard template](../packages/dashboard/.env.example). The Proxy template's `RAVEN_TOKEN_PATH=data/github_token` overrides the default data location; omit it to use platform defaults.

### Start and connect

```bash
bun run dev
```

On first startup, the terminal displays a GitHub Device Flow URL and code. Complete authorization in the browser, then the Proxy continues initializing the Copilot token and model catalog. Default ports are 7024 for the Proxy and 7023 for the Dashboard. Open `http://127.0.0.1:7023` and use Connect to inspect connection details and manage API keys.

AI endpoints accept `Authorization: Bearer ...` or `x-api-key` and always require a valid client key. `RAVEN_INTERNAL_KEY` is for management endpoints only. Database-generated keys start with `rk-`; use the generated random values for environment keys.

After setting `RAVEN_API_KEY` in your current terminal, check the service and model catalog:

```bash
curl http://127.0.0.1:7024/health
curl -H "Authorization: Bearer $RAVEN_API_KEY" \
  http://127.0.0.1:7024/v1/models
```

Anthropic-compatible clients use Base URL `http://127.0.0.1:7024`; OpenAI-compatible clients typically use `http://127.0.0.1:7024/v1`. Choose a catalog model that supports the relevant endpoint, and follow your client's documentation for its configuration format.

### Access and data

The Dashboard runs in Local mode without sign-in if any of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, or `NEXTAUTH_SECRET` is missing. The Proxy's `/api/*` endpoints and log WebSocket also allow unauthenticated access when neither environment key is configured, regardless of the number of database keys.

Startup scripts do not explicitly bind only to loopback, so restrict external access to these ports for local use. Network access requires configuring Dashboard Google OAuth, `ALLOWED_EMAILS`, and Proxy access controls together. An empty email allowlist accepts all signed-in Google accounts. See the [deployment document](14-vps-deployment.md) for further configuration.

Default GitHub token and database locations:

| Platform | Configuration and data directories |
| --- | --- |
| macOS | `~/Library/Application Support/raven/` |
| Linux | Configuration in `~/.config/raven/`, data in `~/.local/share/raven/`, respecting XDG overrides |

`RAVEN_CONFIG_DIR` / `RAVEN_DATA_DIR` override directories; `RAVEN_TOKEN_PATH` / `RAVEN_DB_PATH` override complete paths. Database API keys are stored as digests. The GitHub token file and custom upstream keys remain local plaintext credentials, and the database also contains request records and settings.

## Development

`packages/proxy/` contains routes, protocol adapters, upstream clients, and SQLite access. `packages/dashboard/` contains pages and server routes that forward to the Proxy.

```bash
bun run dev:proxy
bun run dev:dashboard
```

These start each service separately; run them in different terminals as needed. To build the Dashboard and start the Proxy:

```bash
bun run build
bun run start:proxy
```

In another terminal:

```bash
bun run start:dashboard
```

Both development and built startup paths use real configuration; starting the Proxy connects to GitHub. `bun run start` builds the Dashboard first, then starts both services together.

## Tests

After installing dependencies, run from the repository root:

| Scope | Command |
| --- | --- |
| Proxy and Dashboard unit tests | `bun run test:all` |
| Route and handler integration with mocked upstreams | `bun run test:l2` |
| SSE and protocol-adapter benchmarks | `bun run test:perf` |
| Real upstream API tests | `RAVEN_API_KEY=your-client-key bun run test:e2e` |
| Dashboard browser tests | `bun run test:ui` |

Real API tests reuse or start the Proxy on port 7024, use its actual configuration and database, and make upstream requests. For browser tests, first run `bunx playwright install chromium` in `packages/dashboard/`. The runner requires the Proxy port to be free and uses a test database, but still depends on GitHub authentication. Run these two categories in a prepared test environment.

## Stack

| Technology | Role |
| --- | --- |
| Bun / TypeScript / Hono | Proxy runtime, HTTP routing, and SSE |
| SQLite | API key digests, request records, settings, and provider configuration |
| Next.js / React | Dashboard pages and server routes |
| Basalt / Tailwind CSS | Components and styling |
| SWR / Recharts | Data updates and analytics charts |
| NextAuth / Google OAuth | Optional Dashboard sign-in |
| Zod / gpt-tokenizer | Request validation and local token estimates |
| socks / Tavily | Optional outbound proxy and server-side web search |
| Vitest / bun:test / Playwright | Unit, protocol, performance, and browser tests |

## Documentation

- [Documentation index](README.md)
- [Authentication design background](09-unified-auth.md)
- [Custom upstream routing](11-custom-upstream-routing.md)
- [Server-side search tools](13-server-tools.md)
- [Protocol-processing architecture](20-architecture-refactor.md)
- [Token Sentinel](23-token-sentinel.md)
- [Chat Completions to Responses adaptation](24-chat-responses-shim.md)
- [Changelog](../CHANGELOG.md)

## License

[MIT](../LICENSE)
