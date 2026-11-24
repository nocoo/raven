#!/usr/bin/env bun
/**
 * Static guard: every `@ts-expect-error` must carry a description of
 * at least MIN_LENGTH characters (matching tseslint `ban-ts-comment`'s
 * `minimumDescriptionLength` default).
 *
 * tseslint's `ban-ts-comment` (strict tier) enforces this. biome 2.5's
 * `noTsIgnore` blocks the ts-ignore directive outright but doesn't require
 * descriptions on `@ts-expect-error`.
 *
 * Uses `oxc-parser`, which surfaces every source-file comment
 * (line + block) with precise position info — the TypeScript 7
 * (native / preview) module ships in a "not ready" state and no
 * longer exposes a standalone `createScanner`.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseSync } from "oxc-parser";

const ROOTS = [
  join(import.meta.dir, "..", "packages", "proxy", "src"),
  join(import.meta.dir, "..", "packages", "proxy", "test"),
  join(import.meta.dir, "..", "packages", "dashboard", "src"),
  join(import.meta.dir, "..", "packages", "dashboard", "test"),
];

const MIN_LENGTH = 10;

interface Violation {
  path: string;
  line: number;
  reason: "missing" | "too_short";
  found: string;
}

interface OxcComment {
  type: "Line" | "Block";
  value: string;
  start: number;
  end: number;
}

function posToLine(src: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function scanFile(path: string, src: string): Violation[] {
  const violations: Violation[] = [];
  const r = parseSync(path, src);
  if (r.errors.length > 0) {
    for (const err of r.errors) {
      console.error(`✗ parse error ${path}: ${err.message}`);
    }
    process.exit(1);
  }
  const comments = (r.comments ?? []) as unknown as OxcComment[];

  for (const c of comments) {
    const idx = c.value.indexOf("@ts-expect-error");
    if (idx === -1) continue;
    let rest = c.value.slice(idx + "@ts-expect-error".length);
    // Block comments have leading `*` on subsequent lines — collapse
    // multi-line reasons to flat text.
    if (c.type === "Block") rest = rest.replace(/\n\s*\*?/g, " ");
    // Strip the common leading separator (`-`, `–`, `—`, `:`) once.
    rest = rest.replace(/^\s*[-–—:]?\s*/, "").trim();
    if (rest.length === 0) {
      violations.push({ path, line: posToLine(src, c.start), reason: "missing", found: "" });
    } else if (rest.length < MIN_LENGTH) {
      violations.push({
        path,
        line: posToLine(src, c.start),
        reason: "too_short",
        found: rest,
      });
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const violations: Violation[] = [];
  const { readdir, stat } = await import("node:fs/promises");

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const s = await stat(full);
      if (s.isDirectory()) {
        if (
          name === "node_modules" ||
          name === "coverage" ||
          name === ".next" ||
          name === "__golden__"
        )
          continue;
        await walk(full);
      } else if (/\.(ts|tsx)$/.test(name)) {
        const src = readFileSync(full, "utf-8");
        const repoRel = relative(join(import.meta.dir, ".."), full);
        for (const v of scanFile(repoRel, src)) violations.push(v);
      }
    }
  }

  for (const root of ROOTS) await walk(root);

  if (violations.length === 0) {
    console.log(`✓ every @ts-expect-error carries a ≥${MIN_LENGTH}-char explanation`);
    process.exit(0);
  }

  console.error(`✗ @ts-expect-error violations (${violations.length}, min ${MIN_LENGTH} chars):\n`);
  for (const v of violations) {
    console.error(`  ${v.path}:${v.line}  [${v.reason}]`);
    if (v.reason === "too_short")
      console.error(`    found: "${v.found}" (${v.found.length} chars)`);
  }
  console.error(`\n  Add a short reason: \`// @ts-expect-error - <why, ≥${MIN_LENGTH} chars>\``);
  process.exit(1);
}

void main();
