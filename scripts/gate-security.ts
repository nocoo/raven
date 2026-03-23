/**
 * G2 Security Gate — osv-scanner + gitleaks
 *
 * Hard-fail behavior:
 * - If either tool is missing from $PATH, exit non-zero immediately.
 * - osv-scanner: hard fail on any vulnerability (exitCode 1) or scanner error (exitCode > 1).
 *   Use osv-scanner.toml [[IgnoredVulns]] to suppress known/accepted indirect-dep vulns.
 * - gitleaks: hard fail on any leaked secret.
 */

import { $ } from "bun";

interface ScanResult {
  name: string;
  ok: boolean;
  warn: boolean;
  output: string;
}

function toolExists(name: string): boolean {
  try {
    const result = Bun.spawnSync(["which", name]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function runOsvScanner(): Promise<ScanResult> {
  const name = "osv-scanner";
  if (!toolExists(name)) {
    return {
      name,
      ok: false,
      warn: false,
      output: `❌ ${name} not found. Install: brew install osv-scanner`,
    };
  }

  try {
    const result = await $`osv-scanner scan --lockfile=bun.lock 2>&1`.quiet().nothrow();
    const output = result.text();

    // osv-scanner exits 0 = no vulns, 1 = vulns found, other = error
    if (result.exitCode === 0) {
      return { name, ok: true, warn: false, output: `✅ ${name}: no vulnerabilities found` };
    }
    if (result.exitCode === 1) {
      return {
        name,
        ok: false,
        warn: false,
        output: `❌ ${name}: vulnerabilities detected — update deps or add to osv-scanner.toml [[IgnoredVulns]]\n${output}`,
      };
    }
    // exitCode > 1 = scanner error (lockfile parse failure, CLI error, etc.)
    return {
      name,
      ok: false,
      warn: false,
      output: `❌ ${name}: scanner error (exit ${result.exitCode})\n${output}`,
    };
  } catch (err) {
    return { name, ok: false, warn: false, output: `❌ ${name}: unexpected error — ${err}` };
  }
}

async function runGitleaks(): Promise<ScanResult> {
  const name = "gitleaks";
  if (!toolExists(name)) {
    return {
      name,
      ok: false,
      warn: false,
      output: `❌ ${name} not found. Install: brew install gitleaks`,
    };
  }

  try {
    const result = await $`gitleaks detect --source=. --no-banner 2>&1`.quiet().nothrow();
    const output = result.text();

    // gitleaks exits 0 = no leaks, 1 = leaks found
    if (result.exitCode === 0) {
      return { name, ok: true, warn: false, output: `✅ ${name}: no secrets detected` };
    }
    return { name, ok: false, warn: false, output: `❌ ${name}: secrets detected\n${output}` };
  } catch (err) {
    return { name, ok: false, warn: false, output: `❌ ${name}: unexpected error — ${err}` };
  }
}

async function main(): Promise<void> {
  console.log("🔒 G2 Security Gate\n");

  const results = await Promise.all([runOsvScanner(), runGitleaks()]);

  for (const r of results) {
    console.log(r.output);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`\n❌ G2 failed: ${failed.map((r) => r.name).join(", ")}`);
    process.exit(1);
  }

  console.log("\n✅ G2 passed: all security checks clean");
}

main();
