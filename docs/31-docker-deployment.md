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

Set `BUN_CONFIG_REGISTRY` only if a different build-time package mirror is needed. The example uses the permitted Microsoft mirror; the temporary value is not copied to runtime and is not persisted in `bun.lock`.

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

Compose is the recommended path, but the entrypoint enforces the same key boundary without Compose. A direct invocation must provide a non-empty `RAVEN_INTERNAL_KEY` different from `RAVEN_API_KEY`; otherwise PID 1 exits before starting either service.

```bash
docker build \
  --build-arg BUN_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ \
  -t raven:local .
docker run --name raven \
  -p 127.0.0.1:7023:7023 \
  -p 127.0.0.1:7024:7024 \
  -e RAVEN_API_KEY \
  -e RAVEN_INTERNAL_KEY \
  -v raven-local-state:/var/lib/raven \
  raven:local
```

Set the two exported shell values to different generated secrets before this command. Direct `docker run` has no Compose project namespace, so choose a stable, instance-unique volume name instead of sharing `raven-local-state` across independent Raven instances. Do not replace the `127.0.0.1` host bindings with public `0.0.0.0` bindings while the Dashboard is in Local mode.

Missing any of the three Dashboard OAuth values leaves the existing Local mode unchanged; an incomplete OAuth configuration is not treated as authenticated mode. In that state the entrypoint logs a warning and the operator must keep the Dashboard host-loopback-only. Complete OAuth with an empty `ALLOWED_EMAILS` still logs a warning and permits every authenticated Google account.

## Host Caddy

A minimal local HTTPS publication is:

```caddy
raven.example.com {
    reverse_proxy 127.0.0.1:7023
}

raven-api.example.com {
    reverse_proxy 127.0.0.1:7024
}
```

Use a real OAuth-protected Dashboard origin as `NEXTAUTH_URL`. Do not publish the Proxy management routes as a substitute for the Dashboard; management is deliberately accepted only from a loopback socket peer with the internal key. Caddy must forward proxy and WebSocket traffic for API features it exposes.

## Stop and backup

```bash
docker compose stop
docker compose logs
```

`stop` sends SIGTERM to PID 1; both services receive it and the container waits before exit. The project-scoped volume survives normal `stop`, `down`, image rebuilds and container replacement. `docker compose -p PROJECT down -v` deletes only that project's Compose volume, including the GitHub token and SQLite state, so do not use it for routine shutdown. Back up the whole Docker volume rather than moving an individual database file away from its WAL state.

## Verification limits

The repository's isolated tests verify container configuration and the PID-1 exit/signal policy without Docker or upstream access. The exact Node and Bun tags were checked through Docker Hub metadata and the official image Dockerfiles establish that Oven's image supplies only a Bun-backed `node` fallback on Debian trixie. The Docker daemon was unavailable, so image pulls, `docker build`, and runtime behavior were not executed or claimed as passing.
