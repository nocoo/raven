import { describe, expect, it } from "vitest"
import {
  auditBuildContext,
  checkRequiredAppEntries,
  compileIgnorePattern,
  dockerfileContextSources,
  excludingPattern,
  expectedAppPaths,
  formatContextAudit,
  missingAppPaths,
  parseDockerignore,
  REQUIRED_APP_PATHS,
} from "../docker-context.ts"

const SOCKS5_TEST_ROUTE = "packages/dashboard/src/app/api/settings/socks5/test/route.ts"
const UPSTREAM_TEST_ROUTE = "packages/dashboard/src/app/api/upstreams/[id]/test/route.ts"

describe("compileIgnorePattern", () => {
  it("follows moby wildcard semantics", () => {
    expect(compileIgnorePattern("**/test").test("a/b/test")).toBe(true)
    expect(compileIgnorePattern("**/test").test("test")).toBe(true)
    expect(compileIgnorePattern("*.md").test("README.md")).toBe(true)
    expect(compileIgnorePattern("*.md").test("docs/README.md")).toBe(false)
    expect(compileIgnorePattern("packages/*/test").test("packages/proxy/test")).toBe(true)
    expect(compileIgnorePattern("packages/*/test").test("packages/a/b/test")).toBe(false)
    expect(compileIgnorePattern("a/**").test("a/b/c")).toBe(true)
    expect(compileIgnorePattern("file?.txt").test("file1.txt")).toBe(true)
    expect(compileIgnorePattern("file?.txt").test("file/.txt")).toBe(false)
    expect(compileIgnorePattern("f[0-9].ts").test("f7.ts")).toBe(true)
    expect(compileIgnorePattern("lit\\*.ts").test("lit*.ts")).toBe(true)
    expect(compileIgnorePattern("lit\\*.ts").test("litx.ts")).toBe(false)
    expect(compileIgnorePattern("a.b").test("axb")).toBe(false)
    expect(compileIgnorePattern("x[.ts").test("x[.ts")).toBe(true)
  })
})

describe("parseDockerignore", () => {
  it("skips comments and blanks, cleans paths and records negation", () => {
    const patterns = parseDockerignore(
      "# comment\n\n/node_modules/\n! keep/me\n./a/../b//c/\n.\n!\n../up\n",
    )
    expect(patterns.map((p) => [p.source, p.negated])).toEqual([
      ["node_modules", false],
      ["keep/me", true],
      ["b/c", false],
      ["../up", false],
    ])
  })
})

describe("excludingPattern", () => {
  it("excludes files under a matching parent and honours later negation", () => {
    const patterns = parseDockerignore("**/test/\n!keep/test/\n")
    expect(excludingPattern("x/test/a.ts", patterns)).toBe("**/test")
    expect(excludingPattern("keep/test/a.ts", patterns)).toBeUndefined()
    expect(excludingPattern("x/testing/a.ts", patterns)).toBeUndefined()
  })
})

describe("dockerfileContextSources", () => {
  it("collects local COPY/ADD sources and skips --from stages", () => {
    const dockerfile = [
      "FROM base AS build",
      "COPY package.json bun.lock \\",
      "  tsconfig.json ./",
      "COPY --chown=node:node packages/dashboard/public packages/dashboard/public",
      "COPY --from=build /app/out out",
      "ADD ./scripts/run.ts /app/",
      "COPY . ./",
      "RUN echo COPY nothing",
    ].join("\n")
    expect(dockerfileContextSources(dockerfile)).toEqual([
      "package.json",
      "bun.lock",
      "tsconfig.json",
      "packages/dashboard/public",
      "scripts/run.ts",
    ])
  })
})

describe("auditBuildContext", () => {
  const dockerfile = "COPY packages/dashboard/src packages/dashboard/src\nCOPY missing.txt ./\n"
  const files = [SOCKS5_TEST_ROUTE, "packages/dashboard/src/app/page.tsx", "packages/dashboard/test/setup.ts"]

  it("reports build inputs dropped by an over-broad rule (regression: v3.3.2)", () => {
    const audit = auditBuildContext({ files, dockerignore: "**/test/\n", dockerfile })
    expect(audit.missingSources).toEqual(["missing.txt"])
    expect(audit.excludedInputs).toEqual([{ file: SOCKS5_TEST_ROUTE, pattern: "**/test" }])
    expect(formatContextAudit(audit)).toEqual([
      "Dockerfile COPY source has no tracked files: missing.txt",
      `Build input excluded by .dockerignore "**/test": ${SOCKS5_TEST_ROUTE}`,
    ])
  })

  it("passes when only package-level test trees are ignored", () => {
    const audit = auditBuildContext({
      files,
      dockerignore: "packages/*/test/\n",
      dockerfile: "COPY packages/dashboard/src packages/dashboard/src\n",
    })
    expect(formatContextAudit(audit)).toEqual([])
  })
})

describe("app paths", () => {
  const files = [
    "packages/dashboard/src/app/page.tsx",
    "packages/dashboard/src/app/settings/page.tsx",
    SOCKS5_TEST_ROUTE,
    UPSTREAM_TEST_ROUTE,
    "packages/dashboard/src/app/layout.tsx",
    "packages/dashboard/src/lib/route.ts",
  ]

  it("maps App Router entries to app-paths-manifest keys", () => {
    expect([...expectedAppPaths(files).entries()]).toEqual([
      ["/page", "packages/dashboard/src/app/page.tsx"],
      ["/settings/page", "packages/dashboard/src/app/settings/page.tsx"],
      ["/api/settings/socks5/test/route", SOCKS5_TEST_ROUTE],
      ["/api/upstreams/[id]/test/route", UPSTREAM_TEST_ROUTE],
    ])
  })

  it("requires the socks5 and upstream test routes to exist in source", () => {
    expect(checkRequiredAppEntries(files)).toEqual([])
    expect(checkRequiredAppEntries([])).toEqual(
      REQUIRED_APP_PATHS.map((key) => `Required dashboard app path has no source file: ${key}`),
    )
  })

  it("lists source and required entries missing from a built manifest", () => {
    const complete = Object.fromEntries(
      [...expectedAppPaths(files).keys()].map((key) => [key, `app${key}.js`]),
    )
    expect(missingAppPaths(files, complete)).toEqual([])
    const { "/api/settings/socks5/test/route": _dropped, ...broken } = complete
    expect(missingAppPaths(files, broken)).toEqual(["/api/settings/socks5/test/route"])
    expect(missingAppPaths([], {})).toEqual([...REQUIRED_APP_PATHS].sort())
  })
})
