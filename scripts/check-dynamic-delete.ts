#!/usr/bin/env bun
/**
 * Static guard against dynamic `delete obj[computed]`.
 *
 * Rationale: `delete obj[key]` hides property removal from the type
 * system and defeats optimizer inlining. tseslint's `no-dynamic-delete`
 * (strict tier) blocks `delete obj[computed]` but permits
 * `delete obj.staticName` and `delete obj["static-literal"]`.
 *
 * Uses `oxc-parser` (Rust-native, ESTree AST) rather than the
 * `typescript` compiler API. Reason: TypeScript 7 (native / preview)
 * has "not ready" status for its consumer API and no longer exposes
 * a standalone `createSourceFile` / `forEachChild`. oxc gives us a
 * stable single-file parse that works regardless of what typescript
 * version tsc itself is at.
 *
 * biome 2.5 has no equivalent — `noDelete` is a blanket ban and
 * would fire on legitimate `Record<string, unknown>` deletes. This
 * script + that gap is the smallest wedge to reach strict parity.
 *
 * Extend ALLOWED with justified sites (each entry requires a comment).
 */

import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { parseSync } from "oxc-parser"

const ROOTS = [
  join(import.meta.dir, "..", "packages", "proxy", "src"),
  join(import.meta.dir, "..", "packages", "proxy", "test"),
  join(import.meta.dir, "..", "packages", "dashboard", "src"),
  join(import.meta.dir, "..", "packages", "dashboard", "test"),
]

// Whitelist: repo-relative path → reason. Empty for now.
const ALLOWED: Record<string, string> = {}

interface Violation {
  path: string
  line: number
  col: number
  snippet: string
}

interface Loc {
  line: number
  column: number
}

interface OxcNode {
  type: string
  start?: number
  end?: number
  loc?: { start: Loc; end: Loc }
  operator?: string
  argument?: OxcNode
  expression?: OxcNode
  object?: OxcNode
  property?: OxcNode
  computed?: boolean
  [key: string]: unknown
}

/**
 * Given a member-access chain, does the deepest access use a computed
 * non-literal key? That's the shape tseslint bans. Static string /
 * numeric literals are permitted.
 */
function isDynamicComputedTail(expr: OxcNode | undefined): boolean {
  if (!expr) return false
  let cur = expr
  // Peel wrappers: parens, non-null assertions, and optional-chain
  // wrappers all keep the tail member access underneath.
  while (
    cur.type === "ParenthesizedExpression" ||
    cur.type === "TSNonNullExpression" ||
    cur.type === "ChainExpression"
  ) {
    cur = cur.expression as OxcNode
  }
  if (cur.type !== "MemberExpression") return false
  if (!cur.computed) return false
  const prop = cur.property
  if (!prop) return false
  // Static literals: string, number, template-with-no-substitutions
  if (prop.type === "Literal") return false
  if (prop.type === "TemplateLiteral") {
    const q = prop as unknown as { expressions: unknown[] }
    if (Array.isArray(q.expressions) && q.expressions.length === 0) return false
  }
  return true
}

function collect(node: OxcNode | null | undefined, path: string, src: string, out: Violation[]): void {
  if (!node || typeof node !== "object") return
  if (node.type === "UnaryExpression" && node.operator === "delete") {
    if (isDynamicComputedTail(node.argument)) {
      const startPos = node.start ?? 0
      const line = node.loc?.start.line ?? posToLine(src, startPos)
      const col = node.loc?.start.column ?? posToCol(src, startPos)
      const endPos = node.end ?? startPos
      out.push({
        path,
        line,
        col: col + 1,
        snippet: (src.slice(startPos, endPos).split("\n")[0] ?? "").trim(),
      })
    }
  }
  for (const key in node) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") continue
    const value = (node as Record<string, unknown>)[key]
    if (Array.isArray(value)) {
      for (const item of value) collect(item as OxcNode, path, src, out)
    } else if (value && typeof value === "object" && "type" in (value as object)) {
      collect(value as OxcNode, path, src, out)
    }
  }
}

function posToLine(src: string, pos: number): number {
  let line = 1
  for (let i = 0; i < pos && i < src.length; i++) if (src.charCodeAt(i) === 10) line++
  return line
}

function posToCol(src: string, pos: number): number {
  let col = 0
  for (let i = pos - 1; i >= 0; i--) {
    if (src.charCodeAt(i) === 10) break
    col++
  }
  return col
}

async function main(): Promise<void> {
  const violations: Violation[] = []
  const { readdir, stat } = await import("node:fs/promises")

  async function walk(dir: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      const s = await stat(full)
      if (s.isDirectory()) {
        if (name === "node_modules" || name === "coverage" || name === ".next" || name === "__golden__") continue
        await walk(full)
      } else if (/\.(ts|tsx)$/.test(name)) {
        const repoRel = relative(join(import.meta.dir, ".."), full)
        if (repoRel in ALLOWED) continue
        const src = readFileSync(full, "utf-8")
        const r = parseSync(full, src)
        if (r.errors.length > 0) {
          // Parse errors: report the file so we don't silently ignore
          // broken sources. oxc's diagnostics carry line/col.
          for (const err of r.errors) {
            console.error(`✗ parse error ${repoRel}: ${err.message}`)
          }
          process.exit(1)
        }
        collect(r.program as unknown as OxcNode, repoRel, src, violations)
      }
    }
  }

  for (const root of ROOTS) await walk(root)

  if (violations.length === 0) {
    console.log("✓ no dynamic delete found")
    process.exit(0)
  }

  console.error(`✗ dynamic delete forbidden (${violations.length} site${violations.length === 1 ? "" : "s"}):\n`)
  for (const v of violations) {
    console.error(`  ${v.path}:${v.line}:${v.col}`)
    console.error(`    ${v.snippet}`)
  }
  console.error("\n  Use a static property name, or refactor to a Map/Record helper.")
  process.exit(1)
}

void main()
