/**
 * Pre-commit gate runner — parallel:
 *   - L1 coverage  (proxy tests + §4.5 baseline via gate:coverage / check-coverage.ts)
 *   - L1 dashboard unit tests
 *   - G1 lint-staged, typecheck, fetch-boundary, dynamic-delete, ts-expect-error
 *   - G2 gitleaks (staged-only)
 *
 * Proxy L1 must go through check-coverage.ts — bare vitest thresholds do not
 * enforce docs/20-baseline.json (directory floors, untested files, regression).
 */

export interface Task {
  name: string
  gate: string
  cmd: string[]
}

/** Exported for unit tests — coverage task must invoke the CI baseline gate. */
export const tasks: Task[] = [
  { name: "coverage", gate: "L1", cmd: ["bun", "run", "gate:coverage"] },
  { name: "dashboard-tests", gate: "L1", cmd: ["bun", "run", "--filter", "dashboard", "test"] },
  // Only the root vitest "scripts" project — not full monorepo (coverage +
  // dashboard-tests already cover packages/*).
  {
    name: "scripts-tests",
    gate: "L1",
    cmd: ["bunx", "--bun", "vitest", "run", "--project", "scripts"],
  },
  { name: "lint-staged", gate: "G1", cmd: ["bunx", "lint-staged"] },
  { name: "typecheck", gate: "G1", cmd: ["bun", "run", "typecheck"] },
  { name: "fetch-boundary", gate: "G1", cmd: ["bun", "run", "scripts/check-fetch-boundary.ts"] },
  { name: "dynamic-delete", gate: "G1", cmd: ["bun", "run", "scripts/check-dynamic-delete.ts"] },
  { name: "ts-expect-error", gate: "G1", cmd: ["bun", "run", "scripts/check-ts-expect-error.ts"] },
  { name: "gitleaks", gate: "G2", cmd: ["gitleaks", "protect", "--staged", "--no-banner"] },
]

async function runTask(task: Task): Promise<{ task: Task; ok: boolean; output: string }> {
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
  const start = performance.now()
  console.log("🚀 Pre-commit (parallel)\n")

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
