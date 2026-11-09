/**
 * Offline emulation of Docker build-context filtering (moby patternmatcher)
 * so CI can prove every Dockerfile build input survives `.dockerignore`.
 */

export interface IgnorePattern {
  source: string
  negated: boolean
  regex: RegExp
}

function cleanPattern(raw: string): string {
  const parts: string[] = []
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join("/")
}

function escapeRegexChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

export function compileIgnorePattern(pattern: string): RegExp {
  let regex = "^"
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++
        if (pattern[i + 1] === "/") {
          i++
          regex += "(.*/)?"
        } else {
          regex += ".*"
        }
      } else {
        regex += "[^/]*"
      }
    } else if (char === "?") {
      regex += "[^/]"
    } else if (char === "\\" && i + 1 < pattern.length) {
      i++
      regex += escapeRegexChar(pattern[i] as string)
    } else if (char === "[" && pattern.indexOf("]", i + 1) > i + 1) {
      const end = pattern.indexOf("]", i + 1)
      regex += pattern.slice(i, end + 1)
      i = end
    } else {
      regex += escapeRegexChar(char)
    }
  }
  return new RegExp(`${regex}$`)
}

export function parseDockerignore(text: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = []
  for (const line of text.split(/\r?\n/)) {
    let entry = line.trim()
    if (entry === "" || entry.startsWith("#")) continue
    const negated = entry.startsWith("!")
    if (negated) entry = entry.slice(1).trim()
    entry = cleanPattern(entry)
    if (entry === "") continue
    patterns.push({ source: entry, negated, regex: compileIgnorePattern(entry) })
  }
  return patterns
}

function matchesOrParentMatches(path: string, regex: RegExp): boolean {
  if (regex.test(path)) return true
  const parts = path.split("/")
  for (let depth = 1; depth < parts.length; depth++) {
    if (regex.test(parts.slice(0, depth).join("/"))) return true
  }
  return false
}

/** Returns the pattern that excludes `path`, or undefined when it is kept. */
export function excludingPattern(
  path: string,
  patterns: readonly IgnorePattern[],
): string | undefined {
  let excludedBy: string | undefined
  for (const pattern of patterns) {
    if (!matchesOrParentMatches(path, pattern.regex)) continue
    excludedBy = pattern.negated ? undefined : pattern.source
  }
  return excludedBy
}

/** Local (non `--from`) COPY/ADD sources of a Dockerfile. */
export function dockerfileContextSources(dockerfile: string): string[] {
  const joined = dockerfile.replace(/\\\r?\n/g, " ")
  const sources = new Set<string>()
  for (const line of joined.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/)
    const instruction = tokens[0]?.toUpperCase()
    if (instruction !== "COPY" && instruction !== "ADD") continue
    const args = tokens.slice(1)
    if (args.some((arg) => arg.startsWith("--from="))) continue
    const operands = args.filter((arg) => !arg.startsWith("--"))
    for (const source of operands.slice(0, -1)) {
      const cleaned = cleanPattern(source)
      if (cleaned !== "") sources.add(cleaned)
    }
  }
  return [...sources]
}

function isUnderSource(file: string, source: string): boolean {
  return file === source || file.startsWith(`${source}/`)
}

export interface ExcludedInput {
  file: string
  pattern: string
}

export interface ContextAudit {
  sources: string[]
  missingSources: string[]
  excludedInputs: ExcludedInput[]
}

export function auditBuildContext(options: {
  files: readonly string[]
  dockerignore: string
  dockerfile: string
}): ContextAudit {
  const patterns = parseDockerignore(options.dockerignore)
  const sources = dockerfileContextSources(options.dockerfile)
  const missingSources: string[] = []
  const excludedInputs: ExcludedInput[] = []
  for (const source of sources) {
    const inputs = options.files.filter((file) => isUnderSource(file, source))
    if (inputs.length === 0) missingSources.push(source)
    for (const file of inputs) {
      const pattern = excludingPattern(file, patterns)
      if (pattern !== undefined) excludedInputs.push({ file, pattern })
    }
  }
  return { sources, missingSources, excludedInputs }
}

export const DASHBOARD_APP_DIR = "packages/dashboard/src/app"

const APP_ENTRY_RE = /\/(route|page)\.(ts|tsx|js|jsx)$/

/** App Router entry files mapped to their `app-paths-manifest.json` keys. */
export function expectedAppPaths(files: readonly string[]): Map<string, string> {
  const expected = new Map<string, string>()
  for (const file of files) {
    if (!file.startsWith(`${DASHBOARD_APP_DIR}/`)) continue
    const match = APP_ENTRY_RE.exec(file)
    if (match === null) continue
    const segment = file.slice(DASHBOARD_APP_DIR.length, match.index)
    expected.set(`${segment}/${match[1]}`, file)
  }
  return expected
}

export const REQUIRED_APP_PATHS = [
  "/api/settings/socks5/test/route",
  "/api/upstreams/[id]/test/route",
] as const

export function missingAppPaths(
  files: readonly string[],
  manifest: Record<string, unknown>,
): string[] {
  const expected = new Set(expectedAppPaths(files).keys())
  for (const required of REQUIRED_APP_PATHS) expected.add(required)
  return [...expected].filter((key) => !(key in manifest)).sort()
}

export function formatContextAudit(audit: ContextAudit): string[] {
  const problems: string[] = []
  for (const source of audit.missingSources) {
    problems.push(`Dockerfile COPY source has no tracked files: ${source}`)
  }
  for (const { file, pattern } of audit.excludedInputs) {
    problems.push(`Build input excluded by .dockerignore "${pattern}": ${file}`)
  }
  return problems
}

export function checkRequiredAppEntries(files: readonly string[]): string[] {
  const keys = new Set(expectedAppPaths(files).keys())
  return REQUIRED_APP_PATHS.filter((key) => !keys.has(key)).map(
    (key) => `Required dashboard app path has no source file: ${key}`,
  )
}
