import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")

describe("Docker deployment configuration", () => {
  test("binds host ports to loopback and uses only a new named volume", () => {
    const compose = read("compose.yaml")

    expect(compose).toContain("RAVEN_DASHBOARD_HOST_PORT:-7023")
    expect(compose).toContain("RAVEN_PROXY_HOST_PORT:-7024")
    expect(compose).toContain("raven-docker-state:/var/lib/raven")
    expect(compose).toMatch(/\nvolumes:\n {2}raven-docker-state:\n$/)
    expect(compose).not.toMatch(/-\s+\.:/)
    expect(compose).toContain("RAVEN_PROXY_URL: http://127.0.0.1:7024")
    expect(compose).toContain("BUN_CONFIG_REGISTRY:-https://mirrors.tencent.com/npm/")
    expect(read(".env.docker.example")).toContain("BUN_CONFIG_REGISTRY=https://mirrors.tencent.com/npm/")
  })

  test("runs non-root with runtime-only state and no-upstream probes", () => {
    const dockerfile = read("Dockerfile")
    const entrypoint = read("scripts/container-entrypoint.ts")

    expect(dockerfile).toContain("FROM node:26.12.1-trixie-slim AS runtime")
    expect(dockerfile).toContain("COPY --from=bun /usr/local/bin/bun")
    expect(dockerfile).toContain("USER node")
    expect(dockerfile).toContain("chmod 700")
    expect(dockerfile).toContain("bun install --frozen-lockfile --production")
    expect(dockerfile).toContain("COPY package.json bun.lock")
    expect(dockerfile).toContain("/api/auth/config")
    expect(dockerfile).not.toContain("/api/live")
    expect(entrypoint).toContain('command: ["/usr/local/bin/bun"')
    expect(entrypoint).toContain('"/usr/local/bin/node"')
    expect(dockerfile).toContain("ARG BUN_CONFIG_REGISTRY")
    expect(dockerfile).toContain("node node_modules/next/dist/bin/next build")
    expect(entrypoint).toContain("process.umask(0o077)")
    expect(entrypoint).toContain("must be writable by the non-root user")
    expect(entrypoint).not.toContain("chmod")
  })

  test("installs proxy runtime data and reports the root workspace version", () => {
    const dockerfile = read("Dockerfile")
    const rootPackage = JSON.parse(read("package.json")) as { version: string }
    const proxyPackage = JSON.parse(read("packages/proxy/package.json")) as {
      dependencies: Record<string, string>
    }

    expect(rootPackage.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(proxyPackage.dependencies).toHaveProperty("gpt-tokenizer")
    expect(proxyPackage.dependencies).toHaveProperty("socks")
    expect(dockerfile).toContain("COPY package.json bun.lock")
    expect(dockerfile).toContain("bun install --frozen-lockfile --production")
  })

  test("documents complete Compose-only runtime and protected Caddy paths", () => {
    const guide = read("docs/31-docker-deployment.md")

    expect(guide).toContain("does not document or support a direct `docker run`")
    expect(guide).not.toContain("docker run --name")
    expect(guide).not.toContain("reverse_proxy 127.0.0.1:7024")
    expect(guide).toContain("intentionally provides no Caddy route to the Proxy port")
    expect(guide).toContain("exact public allowlist")
    for (const route of [
      "/health",
      "/chat/completions",
      "/embeddings",
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/messages/count_tokens",
      "/v1/responses",
      "/v1/systemone",
      "/v1/decisions",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/models",
      "/v1/embeddings",
    ]) {
      expect(guide).toContain(`- \`${route}\``)
    }
    expect(guide).toContain("Reject repeated slashes")
    expect(new URL("/ws//../logs", "http://fixture.invalid").pathname).toBe(
      "/ws/logs",
    )
  })

  test("keeps entrypoint tests independent of real bootstrap state", () => {
    const test = read("scripts/__tests__/container-entrypoint.test.ts")

    expect(test).not.toContain("Bun.spawn")
    expect(test).not.toContain("Bun.env")
  })
  test("keeps secrets and persistent state out of the build context", () => {
    const ignore = read(".dockerignore")

    for (const pattern of [
      "**/.env.*",
      "**/*.db*",
      "**/*.sqlite*",
      "**/github_token*",
      "**/*.bak",
      "**/*.backup",
    ]) {
      expect(ignore).toContain(pattern)
    }
  })
})
