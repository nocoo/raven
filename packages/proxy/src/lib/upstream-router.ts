import { state } from "./state"
import type { CompiledProvider } from "./../db/providers"

export interface ResolvedProvider {
  provider: CompiledProvider
  matchedPattern: string
}

/**
 * Two-pass matching: first scan exact rules, then scan glob rules.
 * This ensures exact matches always have priority over glob patterns,
 * regardless of provider insertion order or pattern array order.
 *
 * Uses pre-compiled patterns from CompiledProvider for efficient matching
 * (no JSON.parse on each request).
 *
 * Returns null = route to default Copilot.
 */
export function resolveProvider(model: string): ResolvedProvider | null {
  // Pass 1: exact match only (no wildcards)
  for (const provider of state.providers) {
    for (const pattern of provider.patterns) {
      if (pattern.isExact && model === pattern.raw) {
        return { provider, matchedPattern: pattern.raw }
      }
    }
  }

  // Pass 2: glob match only (trailing wildcards)
  for (const provider of state.providers) {
    for (const pattern of provider.patterns) {
      if (pattern.prefix !== undefined && model.startsWith(pattern.prefix)) {
        return { provider, matchedPattern: pattern.raw }
      }
    }
  }

  return null
}
