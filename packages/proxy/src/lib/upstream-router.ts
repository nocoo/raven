import { state } from "./state"
import type { CompiledProvider } from "./../db/providers"

export interface ResolvedProvider {
  provider: CompiledProvider
  matchedPattern: string
}

/**
 * Two-pass matching across one or more candidate models: first scan
 * every candidate for an exact rule, then scan every candidate for a
 * glob rule. Exact always wins over glob, regardless of candidate
 * order; within a single pass, earlier candidates win over later
 * candidates. This lets callers supply aliases (e.g. raw and
 * normalised model names) while preserving the "exact beats glob"
 * invariant.
 *
 * Returns null = route to default Copilot.
 */
export function resolveProviderForModels(models: string[]): ResolvedProvider | null {
  for (const model of models) {
    for (const provider of state.providers) {
      for (const pattern of provider.patterns) {
        if (pattern.isExact && model === pattern.raw) {
          return { provider, matchedPattern: pattern.raw }
        }
      }
    }
  }

  for (const model of models) {
    for (const provider of state.providers) {
      for (const pattern of provider.patterns) {
        if (pattern.prefix !== undefined && model.startsWith(pattern.prefix)) {
          return { provider, matchedPattern: pattern.raw }
        }
      }
    }
  }

  return null
}

/**
 * Single-model convenience wrapper around resolveProviderForModels.
 */
export function resolveProvider(model: string): ResolvedProvider | null {
  return resolveProviderForModels([model])
}
