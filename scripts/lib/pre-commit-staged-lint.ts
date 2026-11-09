import { readFileSync } from "node:fs"
import picomatch from "picomatch"

const BIOME_ARGS = [
  "check",
  "--no-errors-on-unmatched",
  "--error-on-warnings",
  "--max-diagnostics=500",
] as const

/** lint-staged glob keys from root package.json — single source for hook Biome scope. */
export function lintStagedPatterns(): string[] {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    "lint-staged"?: Record<string, string>
  }
  return Object.keys(pkg["lint-staged"] ?? {})
}

export function pathsMatchingLintStaged(paths: string[], patterns: string[] = lintStagedPatterns()): string[] {
  const matchers = patterns.map((pattern) => picomatch(pattern, { dot: true }))
  return paths.filter((path) => matchers.some((match) => match(path)))
}

export async function runBiomeOnStaged(paths: string[]): Promise<{ ok: boolean; output: string }> {
  if (paths.length === 0) {
    return { ok: true, output: "" }
  }
  const proc = Bun.spawn(["bunx", "biome", ...BIOME_ARGS, ...paths], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { ok: exitCode === 0, output: stdout + stderr }
}
