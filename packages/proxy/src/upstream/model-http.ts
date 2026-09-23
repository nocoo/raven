/** Optional transport + diagnostic replay gate shared by model HTTP clients. */
export interface ModelHttpConfig {
  /** Replaces global fetch for this client. Root injects per-attempt accounting here. */
  fetch?: typeof globalThis.fetch
  /**
   * When false, suppress same-provider credential refresh and parameter-repair
   * retries. Omitted means the existing replay behavior.
   */
  allowReplay?: boolean
  requestUsage?: boolean
}

export function withStreamingUsage<T extends { stream?: boolean | null; stream_options?: { include_usage?: boolean } | null }>(payload: T, enabled = false): T {
  return enabled && payload.stream && payload.stream_options?.include_usage === undefined
    ? { ...payload, stream_options: { ...payload.stream_options, include_usage: true } }
    : payload
}

export function modelFetch(config: ModelHttpConfig): typeof globalThis.fetch {
  return config.fetch ?? fetch
}

export function replayAllowed(config: ModelHttpConfig): boolean {
  return config.allowReplay !== false
}
