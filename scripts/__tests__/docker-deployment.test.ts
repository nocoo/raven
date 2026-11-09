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
    expect(compose).toContain("name: raven-docker-state-v1")
    expect(compose).not.toMatch(/-\s+\.:/)
    expect(compose).toContain("RAVEN_PROXY_URL: http://127.0.0.1:7024")
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
