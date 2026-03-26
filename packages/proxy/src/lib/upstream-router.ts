import { state } from "./state"
import type { ProviderRecord } from "~/db/providers"

export interface ResolvedProvider {
  provider: ProviderRecord
  matchedPattern: string
}

/**
 * Two-pass matching: first scan exact rules, then scan glob rules.
 * This ensures exact matches always have priority over glob patterns,
 * regardless of provider insertion order or pattern array order.
 *
 * Returns null = route to default Copilot.
 */
export function resolveProvider(model: string): ResolvedProvider | null {
  // Pass 1: exact match only (no wildcards)
  for (const provider of state.providers) {
    const patterns: string[] = JSON.parse(provider.model_patterns)
    for (const pattern of patterns) {
      if (!pattern.includes("*") && model === pattern) {
        return { provider, matchedPattern: pattern }
      }
    }
  }

  // Pass 2: glob match only (trailing wildcards)
  for (const provider of state.providers) {
    const patterns: string[] = JSON.parse(provider.model_patterns)
    for (const pattern of patterns) {
      if (pattern.endsWith("*") && model.startsWith(pattern.slice(0, -1))) {
        return { provider, matchedPattern: pattern }
      }
    }
  }

  return null
}
