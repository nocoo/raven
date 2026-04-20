interface Task {
  name: string;
  gate: string;
  cmd: string[];
}

const tasks: Task[] = [
  { name: "tests", gate: "L1", cmd: ["bun", "run", "test:all"] },
  { name: "lint-staged", gate: "G1", cmd: ["bunx", "lint-staged"] },
  { name: "typecheck", gate: "G1", cmd: ["bun", "run", "typecheck"] },
  { name: "gitleaks", gate: "G2", cmd: ["gitleaks", "protect", "--staged", "--no-banner"] },
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
  console.log("🚀 Pre-commit (parallel)\n");

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
