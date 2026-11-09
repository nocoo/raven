# Docker deployment

Raven's container runs the Proxy and Dashboard in one network namespace. Dashboard management requests reach the Proxy through `127.0.0.1`, so Raven preserves the existing loopback-peer plus `RAVEN_INTERNAL_KEY` requirement. AI API requests still require a client key and never accept the management key.

## Security boundary

- Compose publishes only `127.0.0.1:7023` and `127.0.0.1:7024`. A host-side Caddy instance can reverse-proxy either port, but publication is an explicit operator choice.
- The container runs as the non-root `node` user. Node 26.12.1 runs the Dashboard; Bun runs the Proxy and PID 1 entrypoint from the same Debian trixie libc family. The entrypoint sets umask `077`, forwards stop signals, and maps an unexpected clean child exit to failure. It escalates a child that does not stop within ten seconds.
- A project-scoped named volume, `<compose-project>_raven-docker-state`, owns all persistent state under `/var/lib/raven`: GitHub token, SQLite database, WAL and provider configuration. No host bind mount is used, so it neither reads nor modifies the existing native Raven directories. Different checkout names or `docker compose -p` values receive different volumes; the same project name reuses its volume across container restarts and rebuilds.
- A permission failure stops startup. The container does not broaden filesystem permissions.
- Build-time registry configuration must not contain credentials. Compose passes `BUN_CONFIG_REGISTRY` only to `bun install`; the build rejects that URL if it appears in `bun.lock`. Docker build arguments can remain visible in image history or provenance metadata, so this option is not a secret channel and does not guarantee that the registry URL is absent from the built image. Dockerignore excludes nested env files, tokens, databases, WAL/SHM files and backups.

Docker port publishing performs network-address translation. The container may see a Docker or Caddy peer rather than the original client address. Raven's original-client-IP and IP-whitelist behavior through this path has not been established by a Docker acceptance test; do not rely on IP allowlists as the only network control.

## Configure

From the repository root:

```bash
cp .env.docker.example .env
openssl rand -hex 32  # RAVEN_API_KEY
openssl rand -hex 32  # RAVEN_INTERNAL_KEY
```

Set the two different random values in `.env`. Keep `.env` outside Git; it is also excluded from the Docker build context.

`BUN_CONFIG_REGISTRY` is empty by default, so Bun uses its project/default registry. If the default registry is blocked or does not contain the locked artifacts on a particular network, set the build-only argument explicitly. For example, the Tencent mirror used by this machine's pre-release check was:

```dotenv
BUN_CONFIG_REGISTRY=https://mirrors.tencent.com/npm/
```

A third-party mirror has its own availability, retention and trust boundary; verify that it is acceptable for your environment. Do not put credentials in a build argument: Docker may expose build arguments in image history or provenance metadata. The URL is not added to runtime service configuration, and the Dockerfile verifies that it is not written into `bun.lock`.

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

## GHCR production image

GitHub Releases publish **`ghcr.io/nocoo/raven`** images through [`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml).

| Trigger | When it runs |
| --- | --- |
| `release` → `published` | Each new GitHub Release (after `bun run release` creates the tag and release) |
| `workflow_dispatch` | Maintainer backfill for an **existing** release tag without creating a new release |

The workflow proves the annotated tag’s commit with [`release-source`](https://github.com/nocoo/base-ci) (successful **CI** on that SHA, `package.json` version matches `vX.Y.Z`), checks out **`refs/tags/vX.Y.Z`** (not the dispatcher’s default SHA), builds **`linux/amd64`**, and pushes to GHCR. It records the **digest**, source revision, and CI run ID in the job summary and a `ghcr-manifest-*.json` artifact.

**Image references** (content identity is the digest; **tags can be moved or repointed**):

- `ghcr.io/nocoo/raven@sha256:…` — preferred for production pinning
- `ghcr.io/nocoo/raven:vX.Y.Z` and `ghcr.io/nocoo/raven:X.Y.Z` — convenience (omitted for prereleases)
- `ghcr.io/nocoo/raven:<40-char-source-sha>` — maps to the proven release commit

The workflow does **not** publish a `:latest` tag (avoid accidental drift on backfill or prerelease).

**GHCR visibility** is not guaranteed by repository visibility. After the first successful publish, open the package on `https://github.com/nocoo/raven/pkgs/container/raven` and confirm whether pulls require authentication. Private packages need `docker login ghcr.io` with a token that includes **`read:packages`**; do not bake registry credentials into the image.

Production runtime uses **`compose.prod.yaml`** (image pull only; same named volume, loopback ports, and environment as `compose.yaml`). Set the full reference in `.env`:

```dotenv
RAVEN_IMAGE_REF=ghcr.io/nocoo/raven@sha256:…
# or: RAVEN_IMAGE_REF=ghcr.io/nocoo/raven:v3.3.2
```

```bash
docker login ghcr.io   # when the package is private or your account requires it
docker compose -f compose.prod.yaml --env-file .env pull
docker compose -f compose.prod.yaml --env-file .env up
```

OAuth, API keys, and tenant settings remain **runtime** `.env` values only (see above). Optional repository variable **`BUN_CONFIG_REGISTRY`** can be set for the publish workflow if the default npm registry fails during the image build on GitHub Actions.

## Build from source (development)

Docker Desktop is not required by the repository at build or test time, but Docker Engine is required to build and run the container.

```bash
docker compose build
docker compose up
```

Use the root [`compose.yaml`](../compose.yaml) for local builds from a checkout. Use [`compose.prod.yaml`](../compose.prod.yaml) with a GHCR reference for production pulls (previous section).

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

The repository's isolated tests verify container configuration and the PID-1 exit/signal policy without Docker or upstream access. Docker-specific acceptance remains manual: the test suite does not invoke the Docker CLI or require `/dev/null`.

During this pre-release check, `docker compose config --format json` was also run manually with an allowlisted synthetic process environment and an explicit empty env file. It resolved `BUN_CONFIG_REGISTRY` to an empty string by default and to the Tencent URL when explicitly supplied. This manual configuration check is evidence for that run, not a portable unit-test prerequisite.

On 2026-11-09, source v3.3.1 at commit `5a7d0b1` was built from the current Dockerfile and Compose definition with Docker Desktop Engine 29.7.2. This was a linux/arm64 check using a temporary image tag, isolated Compose project and fresh named volume. The Microsoft package mirror returned 404 for current locked packages, while the explicitly selected `https://mirrors.tencent.com/npm/` completed both frozen-lockfile installs and the Next.js production build without writing that URL into `bun.lock`. The repository default registry override remains empty; the mirror is not a global requirement.

The temporary Compose invocation used a new named volume and Docker `network_mode: none`. The image reported `node v26.12.1` and `bun 1.4.4`; a non-root `node` user (UID 1000) could access the three mode-0700 state directories, and a marker survived container replacement on that volume. A standalone Next production process returned 200 for `/`, a referenced `/_next/static/*` asset and `/api/auth/config`, then terminated after `docker stop` without an OOM event. This was a single-process Next stop test, not a successful full entrypoint shutdown test.

The check supplied synthetic values through a temporary env file, but `docker compose --env-file` does not clear same-named host-process variables. It therefore does not prove that every inherited variable was synthetic. No real GitHub/Copilot account, token or user database was intentionally used, and `network_mode: none` prevented the tested production bootstrap from reaching GitHub; the isolated attempt initialized fresh SQLite state, then failed closed at token bootstrap. A complete production Proxy + Dashboard startup was not established.

Not verified: successful startup with a real account and Copilot token, the full two-process entrypoint success path, host-published ports or Caddy routing, IP-address behavior through Docker/Caddy, and linux/amd64. Synthetic credentials are not a substitute for a real upstream integration, and the no-network fixture establishes only the reported local boundaries.
