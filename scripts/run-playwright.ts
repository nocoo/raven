/**
 * L3 Playwright runner — auto-starts proxy + dashboard dev servers,
 * runs Playwright smoke tests, then kills both servers.
 *
 * Usage:  bun run scripts/run-playwright.ts [-- playwright-args...]
 *
 * References: otter/run-e2e-ui.ts pattern
 */
import { existsSync, unlinkSync } from "node:fs";
import { $ } from "bun";

const PROXY_PORT = 7033;
const DASHBOARD_PORT = 7032;
const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

// ── Helpers ──────────────────────────────────────────────────────────

async function isPortReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}`, {
      signal: AbortSignal.timeout(2_000),
    });
    // Any response (even 404) means the server is up
    void res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

async function waitForPort(
  port: number,
  label: string,
): Promise<void> {
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

function killProc(proc: ReturnType<typeof Bun.spawn> | null, label: string) {
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
    console.log(`  ✗ ${label} stopped`);
  } catch {
    // already exited
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let proxyProc: ReturnType<typeof Bun.spawn> | null = null;
  let dashboardProc: ReturnType<typeof Bun.spawn> | null = null;

  // Clean slate: delete test DB + WAL/SHM sidecars before run (D1 isolation)
  const TEST_DB = `${import.meta.dir}/../packages/proxy/data/raven-test.db`;
  for (const ext of ["", "-wal", "-shm"]) {
    const file = TEST_DB + ext;
    if (existsSync(file)) {
      try {
        unlinkSync(file);
      } catch {
        // OK if deletion fails (file in use, etc.)
      }
    }
  }

  try {
    // Check if servers are already running
    const proxyAlready = await isPortReady(PROXY_PORT);
    const dashboardAlready = await isPortReady(DASHBOARD_PORT);

    console.log("🎭 L3 Playwright E2E\n");

    // D1 isolation: proxy must use test DB, reject if already running
    if (proxyAlready) {
      console.error(`  ❌ Proxy already running on :${PROXY_PORT}`);
      console.error(`     D1 isolation requires a fresh proxy with RAVEN_DB_PATH=data/raven-test.db`);
      console.error(`     Stop the running proxy and try again.`);
      return 1;
    }

    console.log("  ⏳ Starting proxy...");
    proxyProc = Bun.spawn(["bun", "run", "dev:proxy"], {
      cwd: `${import.meta.dir}/..`,
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        // Dev mode: no auth required
        RAVEN_API_KEY: undefined,
        RAVEN_INTERNAL_KEY: undefined,
        RAVEN_DB_PATH: "data/raven-test.db",
      },
    });
    await waitForPort(PROXY_PORT, "Proxy");

    // Dashboard can be reused (doesn't touch DB directly)
    if (dashboardAlready) {
      console.log(`  ⤳ Dashboard already running on :${DASHBOARD_PORT}`);
    } else {
      console.log("  ⏳ Starting dashboard...");
      dashboardProc = Bun.spawn(["bun", "run", "dev:dashboard"], {
        cwd: `${import.meta.dir}/..`,
        stdout: "ignore",
        stderr: "ignore",
      });
      await waitForPort(DASHBOARD_PORT, "Dashboard");
    }

    console.log("");

    // Run Playwright
    const extraArgs = process.argv.slice(2);
    const result =
      await $`bunx playwright test --config packages/dashboard/e2e/playwright.config.ts ${extraArgs}`.cwd(
        `${import.meta.dir}/..`,
      ).nothrow();

    return result.exitCode;
  } finally {
    // Cleanup: only kill servers we started
    killProc(dashboardProc, "Dashboard");
    killProc(proxyProc, "Proxy");
  }
}

main().then((code) => process.exit(code));
