/**
 * Pre-commit gate runner (Git index snapshot) — parallel:
 *   - L1 coverage  (proxy tests + §4.5 baseline via gate:coverage / check-coverage.ts)
 *   - L1 dashboard unit tests
 *   - G1 index-scoped Biome (replaces lint-staged; paths from staged snapshot)
 *   - G1 typecheck, fetch-boundary, dynamic-delete, ts-expect-error
 *
 * Invoked from `.husky/pre-commit` after `git checkout-index` into a temp
 * directory. G2 gitleaks runs in the husky launcher on the real index.
 *
 * Proxy L1 must go through check-coverage.ts — bare vitest thresholds do not
 * enforce docs/20-baseline.json (directory floors, untested files, regression).
 */

import { existsSync, readFileSync } from "node:fs"

import { pathsMatchingLintStaged, runBiomeOnStaged } from "./lib/pre-commit-staged-lint.ts"

export interface CommandTask {
  name: string
  gate: string
  cmd: string[]
}

export type Task =
  | CommandTask
  | {
      name: string
      gate: string
      run: () => Promise<{ ok: boolean; output: string }>
    }

function loadStagedPaths(): string[] {
  const file = process.env.RAVEN_STAGED_PATHS_FILE
  if (!file) {
    return []
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Exported for unit tests — coverage task must invoke the CI baseline gate. */
export const commandTasks: CommandTask[] = [
  { name: "coverage", gate: "L1", cmd: ["bun", "run", "gate:coverage"] },
  { name: "dashboard-tests", gate: "L1", cmd: ["bun", "run", "--filter", "dashboard", "test"] },
  // Only the root vitest "scripts" project — not full monorepo (coverage +
  // dashboard-tests already cover packages/*).
  {
    name: "scripts-tests",
    gate: "L1",
    cmd: ["bunx", "--bun", "vitest", "run", "--project", "scripts"],
  },
  { name: "typecheck", gate: "G1", cmd: ["bun", "run", "typecheck"] },
  { name: "fetch-boundary", gate: "G1", cmd: ["bun", "run", "scripts/check-fetch-boundary.ts"] },
  { name: "dynamic-delete", gate: "G1", cmd: ["bun", "run", "scripts/check-dynamic-delete.ts"] },
  { name: "ts-expect-error", gate: "G1", cmd: ["bun", "run", "scripts/check-ts-expect-error.ts"] },
]

export const tasks: Task[] = [
  ...commandTasks,
  {
    name: "staged-lint",
    gate: "G1",
    run: async (): Promise<{ ok: boolean; output: string }> => {
      const staged = loadStagedPaths()
      const lintable = pathsMatchingLintStaged(staged).filter((path) => existsSync(path))
      return runBiomeOnStaged(lintable)
    },
  },
]

async function runTask(task: Task): Promise<{ task: Task; ok: boolean; output: string }> {
  if ("run" in task) {
    try {
      const result = await task.run()
      return { task, ...result }
    } catch (err) {
      return { task, ok: false, output: String(err) }
    }
  }
  try {
    const proc = Bun.spawn(task.cmd, { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    return { task, ok: exitCode === 0, output: stdout + stderr }
  } catch (err) {
    return { task, ok: false, output: String(err) }
  }
}

async function main(): Promise<void> {
  if (process.env.RAVEN_HOOK_INDEX !== "1") {
    console.error("❌ pre-commit: must run from .husky/pre-commit index snapshot (RAVEN_HOOK_INDEX=1)")
    process.exit(1)
  }

  const start = performance.now()
  console.log("🚀 Pre-commit (index snapshot, parallel)\n")

  const results = await Promise.all(tasks.map(runTask))
  const elapsed = ((performance.now() - start) / 1000).toFixed(1)

  const failed: string[] = []

  for (const r of results) {
    const icon = r.ok ? "✅" : "❌"
    console.log(`${icon} [${r.task.gate}] ${r.task.name}`)
    if (!r.ok) {
      console.log(r.output)
      failed.push(r.task.name)
    }
  }

  console.log(`\n⏱  ${elapsed}s`)

  if (failed.length > 0) {
    console.log(`\n❌ Failed: ${failed.join(", ")}`)
    process.exit(1)
  }

  console.log(`\n✅ All gates passed`)
}

if (import.meta.main) {
  main()
}
