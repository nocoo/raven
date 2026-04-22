// ---------------------------------------------------------------------------
// RequestContext (L2) — per-request invariants computed once at the route
// boundary and threaded through Strategy + Runner. Supersedes the inline
// `requestId / sessionId / clientName / clientVersion / accountName`
// destructuring that today appears at the top of every handler.
//
// Construction is split in two so the route handler can compute the
// non-payload fields before parsing the request body (used to surface
// 4xx JSON-parse errors with full identity logging in later phases).
// ---------------------------------------------------------------------------

import type { Context } from "hono"

import { deriveClientIdentity } from "../util/client-identity"
import { generateRequestId } from "../util/id"

export type RequestFormat = "openai" | "anthropic" | "responses"

export interface RequestContext {
  /** ULID-like; set once per request and reused as DB key + log correlation key. */
  requestId: string
  /** `performance.now()` at handler entry; used for TTFT / total latency. */
  startTime: number
  /** Stable client-protocol classifier — drives router and end-log `format`. */
  format: RequestFormat
  /** API key name from auth middleware, defaults to `"default"`. */
  accountName: string
  /** `User-Agent` header verbatim (may be `null`). */
  userAgent: string | null
  /** `anthropic-beta` header verbatim — only meaningful when `format === "anthropic"`. */
  anthropicBeta: string | null
  /** Composite session key (Anthropic user_id, OpenAI user, or `clientName::accountName`). */
  sessionId: string
  /** Parsed UA name; `"Unknown"` when UA is absent or unrecognised. */
  clientName: string
  /** Parsed UA version; `null` when not derivable. */
  clientVersion: string | null
}

export interface IdentitySignals {
  /** Anthropic `metadata.user_id` — exact per-session UUID when present. */
  anthropicUserId?: string | null
  /** OpenAI `payload.user` — heuristic, combined with name + accountName. */
  openaiUser?: string | null
}

/**
 * Build the per-request context from a Hono `Context` plus the parsed body's
 * identity signals. The body is intentionally NOT read here — the caller
 * decides when (and whether) to parse, so JSON-parse failures still get a
 * fully-populated `requestId` for logging.
 */
export function buildContext(
  c: Context,
  format: RequestFormat,
  signals: IdentitySignals = {},
): RequestContext {
  const accountName = c.get("keyName") ?? "default"
  const userAgent = c.req.header("user-agent") ?? null
  const anthropicBeta = c.req.header("anthropic-beta") ?? null

  const { sessionId, clientName, clientVersion } = deriveClientIdentity(
    signals.anthropicUserId ?? null,
    userAgent,
    accountName,
    signals.openaiUser ?? null,
  )

  return {
    requestId: generateRequestId(),
    startTime: performance.now(),
    format,
    accountName,
    userAgent,
    anthropicBeta,
    sessionId,
    clientName,
    clientVersion,
  }
}
