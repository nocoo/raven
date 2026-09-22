/** Optional transport + diagnostic replay gate shared by model HTTP clients. */
export interface ModelHttpConfig {
  /** Replaces global fetch for this client. Root injects per-attempt accounting here. */
  fetch?: typeof globalThis.fetch
  /**
   * When false, suppress same-provider credential refresh and parameter-repair
   * retries. Omitted means the existing replay behavior.
   */
  allowReplay?: boolean
}

export function modelFetch(config: ModelHttpConfig): typeof globalThis.fetch {
  return config.fetch ?? fetch
}

export function replayAllowed(config: ModelHttpConfig): boolean {
  return config.allowReplay !== false
}
