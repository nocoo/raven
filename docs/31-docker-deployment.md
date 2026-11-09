# Docker deployment

Raven's container runs the Proxy and Dashboard in one network namespace. Dashboard management requests reach the Proxy through `127.0.0.1`, so Raven preserves the existing loopback-peer plus `RAVEN_INTERNAL_KEY` requirement. AI API requests still require a client key and never accept the management key.

## Security boundary

- Compose publishes only `127.0.0.1:7023` and `127.0.0.1:7024`. A host-side Caddy instance can reverse-proxy either port, but publication is an explicit operator choice.
- The container runs as the non-root `node` user. Node 26.12.1 runs the Dashboard; Bun runs the Proxy and PID 1 entrypoint from the same Debian trixie libc family. The entrypoint sets umask `077`, forwards stop signals, and maps an unexpected clean child exit to failure. It escalates a child that does not stop within ten seconds.
- A project-scoped named volume, `<compose-project>_raven-docker-state`, owns all persistent state under `/var/lib/raven`: GitHub token, SQLite database, WAL and provider configuration. No host bind mount is used, so it neither reads nor modifies the existing native Raven directories. Different checkout names or `docker compose -p` values receive different volumes; the same project name reuses its volume across container restarts and rebuilds.
- A permission failure stops startup. The container does not broaden filesystem permissions.
- Build-time configuration contains no real secrets. Runtime values come from `.env`/the host environment. Compose passes `BUN_CONFIG_REGISTRY` only to `bun install`; the build rejects that URL if it appears in `bun.lock`. Dockerignore excludes nested env files, tokens, databases, WAL/SHM files and backups.

Docker port publishing performs network-address translation. The container may see a Docker or Caddy peer rather than the original client address. Raven's original-client-IP and IP-whitelist behavior through this path has not been established by a Docker acceptance test; do not rely on IP allowlists as the only network control.

## Configure

From the repository root:

```bash
cp .env.docker.example .env
openssl rand -hex 32  # RAVEN_API_KEY
openssl rand -hex 32  # RAVEN_INTERNAL_KEY
```

Set the two different random values in `.env`. Keep `.env` outside Git; it is also excluded from the Docker build context.

Set `BUN_CONFIG_REGISTRY` only if a different build-time package mirror is needed. The example uses the permitted Tencent mirror; the temporary value is not copied to runtime and is not persisted in `bun.lock`.

The default is safe host-local operation. If a Caddy site makes the Dashboard reachable from another machine, configure all of the following in `.env`:

```dotenv
NEXTAUTH_URL=https://raven.example.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NEXTAUTH_SECRET=...
ALLOWED_EMAILS=you@example.com
USE_SECURE_COOKIES=true
```

Missing any of the three Google/NextAuth credentials selects Raven's existing Local mode and disables Dashboard sign-in. An empty `ALLOWED_EMAILS` permits every Google account that authenticates. Therefore remote or public HTTPS exposure requires the complete OAuth tuple and a non-empty allowlist. Configure the Google redirect URI as `NEXTAUTH_URL/api/auth/callback/google`.

Set `RAVEN_BASE_URL` to the API URL clients actually use, for example `https://raven-api.example.com`. `RAVEN_GITHUB_HOST` is empty for public `github.com`; for GitHub Enterprise Cloud with data residency, set the tenant hostname only.

## Build and first authorization

Docker Desktop is not required by the repository at build or test time, but Docker Engine is required to build and run the container.

```bash
docker compose build
docker compose up
```

On the first run, keep Compose attached and read the Proxy logs. Raven prints a GitHub Device Flow URL and code; open the URL, enter the code, and authorize an account with Copilot access. Startup completes after Raven obtains and persists the GitHub token and Copilot JWT. Subsequent runs use the token from that Compose project's `raven-docker-state` volume and do not require this step unless authorization is removed or replaced.

After successful startup, local checks are:

```bash
curl http://127.0.0.1:7024/health
curl http://127.0.0.1:7023/api/auth/config
```

The healthcheck itself performs only those two local, no-upstream requests.

Run detached later with:

```bash
docker compose up -d
```

## Direct `docker run`

Raven does not document or support a direct `docker run` deployment. Compose supplies the project-scoped volume name, runtime allowlisted environment, loopback port bindings and stop policy together. A hand-written `docker run` can silently omit OAuth, tenant or base URL variables and accidentally share an independently named volume across instances. Use the Compose entrypoint in this guide instead.

The image entrypoint still rejects a missing internal key or reuse of the API key before starting either service, but that guard does not replace Compose's configuration and instance isolation.

## Host Caddy

A minimal local HTTPS publication is:

```caddy
raven.example.com {
    reverse_proxy 127.0.0.1:7023
}
```

The Dashboard host remains unrestricted at the Caddy layer and exposes its same-origin BFF `/api/*` through the Dashboard's Google OAuth boundary.

This guide intentionally provides no Caddy route to the Proxy port. A reverse proxy must not publish a catch-all or a path-blacklist: `/ws//../logs` can be interpreted differently by an edge matcher and Raven's WHATWG URL parser, which canonicalizes it to `/ws/logs`.

If an operator publishes the AI API, the edge must validate the original request target before forwarding and allow only canonical paths from this exact public allowlist:

- `/health`
- `/chat/completions`
- `/embeddings`
- `/v1/chat/completions`
- `/v1/messages`
- `/v1/messages/count_tokens`
- `/v1/responses`
- `/v1/systemone`
- `/v1/decisions`
- `/v1/images/generations`
- `/v1/images/edits`
- `/v1/models`
- `/v1/embeddings`

Reject repeated slashes, dot segments (including encoded variants), encoded slashes/backslashes, `/api`, `/api/*`, and `/ws/*`; requests outside the exact allowlist must never reach port 7024. Do not copy a Dashboard-only BFF route from the first host to the Proxy host.

Use a real OAuth-protected Dashboard origin as `NEXTAUTH_URL`. Do not publish the Proxy management routes as a substitute for the Dashboard; management is deliberately accepted only from a loopback socket peer with the internal key. Any supported public API edge must preserve streaming and WebSocket behavior for allowed client routes while keeping management paths private.

## Stop and backup

```bash
docker compose stop
docker compose logs
```

`stop` sends SIGTERM to PID 1; both services receive it and the container waits before exit. The project-scoped volume survives normal `stop`, `down`, image rebuilds and container replacement. `docker compose -p PROJECT down -v` deletes only that project's Compose volume, including the GitHub token and SQLite state, so do not use it for routine shutdown. Back up the whole Docker volume rather than moving an individual database file away from its WAL state.

## Verification limits

The repository's isolated tests verify container configuration and the PID-1 exit/signal policy without Docker or upstream access.

On 2026-11-09, the current v3.3.2 pre-release HEAD was built through Docker Compose with Docker Desktop Engine 29.7.2. A temporary image tag, isolated Compose project and fresh named volume were used. The Microsoft package mirror returned 404 for current locked packages, while `https://mirrors.tencent.com/npm/` completed both frozen-lockfile installs and the Next.js production build without writing the mirror URL into `bun.lock`; the Compose and `.env` examples now default to that verified mirror.

All runtime checks used only synthetic keys and fresh state, with Docker `network_mode: none`. The image reported `node v26.12.1` and `bun 1.4.4`; a non-root `node` user (UID 1000) wrote to the three mode-0700 state directories and a marker survived container replacement on the named volume. Next.js started from the production image, returned 200 for `/`, a referenced `/_next/static/*` asset and `/api/auth/config`, then stopped through SIGTERM without an OOM event.

Full production Proxy bootstrap remains unverified: `src/index.ts` necessarily calls GitHub to validate the stored token and exchange it for a Copilot JWT, then schedules Copilot catalog access. The release check therefore did not start that bootstrap as a claimed success; an isolated no-network attempt was used only to verify fail-closed behavior. Synthetic credentials are not a substitute for a real GitHub/Copilot integration, and no real token, account or database was used.
