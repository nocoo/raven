/**
 * Pure helpers for scripts/capture-goldens.ts — extracted so the
 * argv-parsing / strategy-validation logic can be unit-tested
 * without spawning bun test or hitting the proxy.
 */

export interface CaptureArgs {
  strategy: string
  extra: string[]
}

export type ValidationResult =
  | { ok: true; args: CaptureArgs }
  | { ok: false; exitCode: 2; message: string }

export function parseCaptureArgs(argv: string[], validStrategies: string[]): ValidationResult {
  const strategy = argv[0]
  if (!strategy) {
    return {
      ok: false,
      exitCode: 2,
      message: `usage: bun run capture-goldens <strategy>\nvalid strategies: ${validStrategies.join(", ")}`,
    }
  }
  if (!validStrategies.includes(strategy)) {
    return {
      ok: false,
      exitCode: 2,
      message: `unknown strategy: ${strategy}\nvalid strategies: ${validStrategies.join(", ")}`,
    }
  }
  return { ok: true, args: { strategy, extra: argv.slice(1) } }
}

export function checkCaptureEnv(env: Record<string, string | undefined>): ValidationResult | null {
  if (!env.RAVEN_API_KEY) {
    return {
      ok: false,
      exitCode: 2,
      message: "RAVEN_API_KEY is not set — create a DB key first (see CLAUDE.md)",
    }
  }
  return null
}
