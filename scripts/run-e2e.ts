/**
 * L2 E2E runner — connects to running proxy or auto-starts one,
 * runs E2E tests against real upstream APIs.
 *
 * Usage:  bun run scripts/run-e2e.ts [-- bun-test-args...]
 *
 * The proxy must have valid Copilot credentials configured
 * (GITHUB_TOKEN or cached token) for upstream tests to pass.
 *
 * Uses production database to test real configurations including
 * server-side tools (Tavily web_search).
 */
import { $ } from "bun";

const PROXY_PORT = 7024;
const STARTUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 300;

async function isPortReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    void res.body?.cancel();
    return res.ok;
  } catch {
    // /health may not exist — try root
    try {
      const res = await fetch(`http://localhost:${port}`, {
        signal: AbortSignal.timeout(2_000),
      });
      void res.body?.cancel();
      return true;
    } catch {
      return false;
    }
  }
}

async function waitForPort(port: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    if (await isPortReady(port)) {
      console.log(`  ✓ ${label} ready on :${port}`);
      return;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`${label} did not start within ${STARTUP_TIMEOUT_MS}ms`);
}

function killProc(
  proc: ReturnType<typeof Bun.spawn> | null,
  label: string,
) {
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
    console.log(`  ✗ ${label} stopped`);
  } catch {
    // already exited
  }
}

async function main(): Promise<number> {
  let proxyProc: ReturnType<typeof Bun.spawn> | null = null;
  let startedByUs = false;

  try {
    const alreadyRunning = await isPortReady(PROXY_PORT);

    console.log("🔌 L2 API E2E (production database)\n");

    if (alreadyRunning) {
      console.log(`  ✓ Using existing proxy on :${PROXY_PORT}`);
    } else {
      console.log("  ⏳ Starting proxy...");
      proxyProc = Bun.spawn(["bun", "run", "dev:proxy"], {
        cwd: `${import.meta.dir}/..`,
        stdout: "ignore",
        stderr: "ignore",
        env: process.env,
      });
      startedByUs = true;
      await waitForPort(PROXY_PORT, "Proxy");
    }

    console.log("");

    // Run E2E tests via bun test
    const extraArgs = process.argv.slice(2);
    const result =
      await $`bun test test/e2e/ ${extraArgs}`.cwd(
        `${import.meta.dir}/../packages/proxy`,
      ).nothrow();

    return result.exitCode;
  } finally {
    // Only kill if we started it
    if (startedByUs) {
      killProc(proxyProc, "Proxy");
    }
  }
}

main().then((code) => process.exit(code));
