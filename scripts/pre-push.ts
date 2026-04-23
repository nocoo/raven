/**
 * Pre-push gate runner — parallelizes the three independent gates:
 *   - G2 security  (osv-scanner + gitleaks; gate-security.ts internally
 *                   runs the two tools in parallel via Promise.all)
 *   - L1 coverage  (proxy unit tests + §4.5 baseline-driven gate)
 *   - G1 arch      (dep-cruiser layering + fetch-boundary)
 *
 * All three run concurrently; any failure exits non-zero. Replaces the
 * previous sequential `set -e` pre-push hook so the wall-clock cost is
 * `max(t)` instead of `sum(t)`.
 *
 * Not in this hook (by design):
 *   L2 — manual-only: bun run test:e2e  (real Copilot API, anti-ban)
 *   L3 — manual-only: bun run test:ui    (Playwright)
 */

interface Task {
  name: string;
  gate: string;
  cmd: string[];
}

const tasks: Task[] = [
  { name: "security", gate: "G2", cmd: ["bun", "run", "gate:security"] },
  { name: "coverage", gate: "L1", cmd: ["bun", "run", "--filter", "@raven/proxy", "test"] },
  { name: "arch", gate: "G1", cmd: ["bun", "run", "gate:arch"] },
];

async function runTask(task: Task): Promise<{ task: Task; ok: boolean; output: string }> {
  try {
    const proc = Bun.spawn(task.cmd, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { task, ok: exitCode === 0, output: stdout + stderr };
  } catch (err) {
    return { task, ok: false, output: String(err) };
  }
}

async function main(): Promise<void> {
  const start = performance.now();
  console.log("🚀 Pre-push (parallel)\n");

  const results = await Promise.all(tasks.map(runTask));
  const elapsed = ((performance.now() - start) / 1000).toFixed(1);

  const failed: string[] = [];
  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    console.log(`${icon} [${r.task.gate}] ${r.task.name}`);
    if (!r.ok) {
      console.log(r.output);
      failed.push(r.task.name);
    }
  }

  console.log(`\n⏱  ${elapsed}s`);

  if (failed.length > 0) {
    console.log(`\n❌ Failed: ${failed.join(", ")}`);
    process.exit(1);
  }

  console.log(`\n✅ All gates passed`);
}

main();
