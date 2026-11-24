#!/usr/bin/env bun
/**
 * Architecture gate — depcruise runner with TS-6 shim + empty-cruise guard.
 *
 * The problem in two lines:
 *   - dependency-cruiser@18 peer-requires typescript ">=2 <7".
 *   - Our root runs typescript@7 for typecheck / IDE.
 *
 * When those two collide, depcruise silently drops every .ts file and
 * reports "0 modules, 0 dependencies cruised". The gate stays green,
 * the arch rules never run, violations reach main.
 *
 * Why a top-level alias isn't enough:
 *   bun's isolated store puts each package under
 *   `node_modules/.bun/<name>@<ver>/node_modules/<name>`. When
 *   depcruise does `createRequire(import.meta.url).resolve("typescript")`,
 *   the require's root is depcruise's realpath inside `.bun`, and
 *   Node's upward walk lands in `.bun/typescript@<x>/node_modules/typescript`
 *   — whichever version bun happened to hoist. Top-level
 *   `node_modules/typescript` is irrelevant to that walk.
 *
 *   Fresh `bun install --frozen-lockfile` puts TS 7 at that location,
 *   so depcruise loses. The old "add an alias" fix worked only by
 *   accident on incremental installs where the alias happened to be
 *   the last one hoisted.
 *
 * What this wrapper does:
 *   1. Ensures a symlink at
 *        node_modules/.bun/dependency-cruiser@<ver>/node_modules/typescript
 *      pointing at the typescript6-for-depcruise alias's real files.
 *      Node's resolve algorithm finds this at the very first parent
 *      of depcruise's own node_modules and stops climbing — TS 7 in
 *      the store above is never seen.
 *   2. Runs depcruise and hard-fails if the summary reports 0 modules
 *      or 0 dependencies. Same failure surface as a broken parser,
 *      and it must not read as green ever again.
 *
 * When depcruise upstream supports TS 7:
 *   - drop typescript6-for-depcruise from package.json devDependencies
 *   - delete this shim block and simplify to a plain spawn
 *   - keep the empty-cruise guard
 */

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, symlinkSync } from "node:fs"
import { join, relative } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..")

function locateDepcruiseStores(): string[] {
  const bunStore = join(REPO_ROOT, "node_modules", ".bun")
  if (!existsSync(bunStore)) {
    console.error(
      "✗ node_modules/.bun not found — did `bun install` complete?",
    )
    process.exit(1)
  }
  const entries = readdirSync(bunStore).filter((name) =>
    name.startsWith("dependency-cruiser@"),
  )
  if (entries.length === 0) {
    console.error(
      "✗ dependency-cruiser is not installed under node_modules/.bun.",
    )
    process.exit(1)
  }
  // Shim every version present. bun may keep an older store copy around
  // after an upgrade, and .find()-ing the first one can pick the stale
  // sibling. Cheap to shim them all.
  return entries.map((entry) => join(bunStore, entry, "node_modules"))
}

function locateTs6Store(): string {
  const bunStore = join(REPO_ROOT, "node_modules", ".bun")
  const entry = readdirSync(bunStore).find(
    (name) => name === "typescript@6.0.3",
  )
  if (!entry) {
    console.error(
      "✗ typescript@6.0.3 not found under node_modules/.bun.\n" +
        "  The typescript6-for-depcruise devDependency must be installed;\n" +
        "  see package.json.",
    )
    process.exit(1)
  }
  return join(bunStore, entry, "node_modules", "typescript")
}

function ensureShim(): void {
  const depStores = locateDepcruiseStores()
  const ts6Real = locateTs6Store()
  for (const depStore of depStores) {
    const shimPath = join(depStore, "typescript")
    if (existsSync(shimPath)) continue
    const relTarget = relative(depStore, ts6Real)
    symlinkSync(relTarget, shimPath, "dir")
  }
}

ensureShim()

const proc = spawnSync(
  "bunx",
  ["depcruise", "--config", "dependency-cruiser.config.cjs", "packages/proxy/src"],
  { cwd: REPO_ROOT, stdio: ["inherit", "pipe", "inherit"] },
)

const output = proc.stdout?.toString() ?? ""
process.stdout.write(output)

if (proc.status !== 0) process.exit(proc.status ?? 1)

const match = output.match(/\((\d+) modules,\s*(\d+) dependencies cruised\)/)
if (!match?.[1] || !match[2]) {
  console.error(
    "✗ depcruise output missing modules/dependencies summary — reporter format may have changed.",
  )
  process.exit(1)
}
const modules = Number.parseInt(match[1], 10)
const deps = Number.parseInt(match[2], 10)
if (modules === 0 || deps === 0) {
  console.error(
    `✗ depcruise cruised ${modules} modules / ${deps} dependencies.\n` +
      "  The TypeScript parser is disabled — arch rules did not run.\n" +
      "  Verify:\n" +
      "    - typescript6-for-depcruise is in package.json devDependencies\n" +
      "    - `bunx depcruise -i` reports ✔ for typescript@6.x\n" +
      "    - node_modules/.bun/dependency-cruiser@*/node_modules/typescript\n" +
      "      exists and points at .bun/typescript@6.0.3/...",
  )
  process.exit(1)
}
