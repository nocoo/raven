/**
 * Shared types for reusable analytics panel components.
 * These types are the "data contract" between data sources (live SSE, historical API)
 * and the panel UI components.
 */

/** A single minute-aligned bucket for request volume charts. */
export interface MinuteBucket {
  minute: number; // epoch ms, minute-aligned
  count: number;
  errors: number;
}

/** Model distribution entry (name + count). */
export interface ModelCount {
  model: string;
  count: number;
}

/** A single point in a timing scatter/line chart. */
export interface TimingPoint {
  index: number;
  latencyMs: number;
  ttftMs: number | null;
  processingMs: number | null;
  model: string;
  stream: boolean;
  ts: number;
}

/** A single minute-aligned concurrency bucket. */
export interface ConcurrencyBucket {
  minute: number; // epoch ms
  sessions: number;
}

/** Aggregated session info for session list cards. */
export interface SessionInfo {
  sessionId: string;
  clientName: string;
  clientVersion: string | null;
  accountName: string;
  activeRequests: Set<string>;
  totalRequests: number;
  errorCount: number;
  totalTokens: number;
  lastActiveTs: number;
  firstSeenTs: number;
}
