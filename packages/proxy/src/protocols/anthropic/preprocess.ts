/**
 * protocols/anthropic — pure helpers for the Anthropic wire protocol.
 *
 * Canonical home for request preprocessing:
 *   - model-name translation (Anthropic → Copilot)
 *   - anthropic-beta header filtering
 *   - payload sanitisation (drop unsupported fields)
 *   - server-side tool detection
 *
 * All helpers here must stay pure — no imports from `lib/state`,
 * `db/`, or any side-effecting module. Enforced by dep-cruiser from
 * D.7 onward (docs/20-architecture-refactor.md §3.7).
 */

import {
  type AnthropicMessagesPayload,
  isServerSideTool,
} from "./types"

// ---------------------------------------------------------------------------
// Model Name Translation
// ---------------------------------------------------------------------------

// Pre-compiled regexes for model name translation (avoid regex compilation on each call)
const MODEL_REGEX_WITH_MINOR =
  /^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d{1,2})(?:(?:-|\[)(1m|fast)\]?)?(?:-\d{8})?$/
const MODEL_REGEX_NO_MINOR = /^(claude-(?:opus|sonnet|haiku))-(\d+)(?:-\d{8})?$/

// Tiny cache for translated model names. Same (model, beta) pair often
// recurs across requests from the same client; regex match + string concat is the
// dominant cost. Cleared when full to avoid unbounded growth (model namespace is small).
const MODEL_NAME_CACHE = new Map<string, string>()

/**
 * Translate Anthropic SDK model identifiers to Copilot model IDs.
 *
 * Copilot uses dot-separated versions without date suffixes:
 * - `claude-opus-4-6-20250820` → `claude-opus-4.6`
 * - `claude-opus-4-6` + `anthropic-beta: context-1m-*` → `claude-opus-4.6-1m`
 * - `claude-opus-4-6[1m]` → `claude-opus-4.6-1m`
 * - `claude-sonnet-4-5-20250514` → `claude-sonnet-4.5`
 * - `claude-sonnet-4-20250514` → `claude-sonnet-4`
 *
 * This function is ONLY used for Copilot routing. Custom providers receive
 * the original model name unchanged.
 */
export function translateModelName(model: string, anthropicBeta: string | null): string {
  // Cache hit on identical (model, beta) inputs — common for repeat clients.
  const cacheKey = anthropicBeta === null ? model : `${model}\0${anthropicBeta}`
  const cached = MODEL_NAME_CACHE.get(cacheKey)
  if (cached !== undefined) return cached

  const result = translateModelNameUncached(model, anthropicBeta)
  if (MODEL_NAME_CACHE.size >= 64) MODEL_NAME_CACHE.clear()
  MODEL_NAME_CACHE.set(cacheKey, result)
  return result
}

function translateModelNameUncached(model: string, anthropicBeta: string | null): string {
  let wants1m = false
  let wantsFast = false
  if (anthropicBeta) {
    // Avoid allocating betas array for the common (null beta) case.
    let start = 0
    const len = anthropicBeta.length
    for (let i = 0; i <= len; i++) {
      if (i === len || anthropicBeta.charCodeAt(i) === 44 /* ',' */) {
        // Trim whitespace via charCode bounds without slicing.
        let s = start
        let e = i
        while (s < e && anthropicBeta.charCodeAt(s) <= 32) s++
        while (e > s && anthropicBeta.charCodeAt(e - 1) <= 32) e--
        if (e - s >= 11 && !wants1m && anthropicBeta.startsWith("context-1m-", s)) wants1m = true
        else if (e - s >= 10 && !wantsFast && anthropicBeta.startsWith("fast-mode-", s)) wantsFast = true
        start = i + 1
      }
    }
  }

  const match = model.match(MODEL_REGEX_WITH_MINOR)
  if (match) {
    const [, family, major, minor, suffix] = match
    const base = `${family}-${major}.${minor}`
    if (suffix) return `${base}-${suffix}`
    if (wants1m) return `${base}-1m`
    if (wantsFast) return `${base}-fast`
    return base
  }

  const matchNoMinor = model.match(MODEL_REGEX_NO_MINOR)
  if (matchNoMinor) {
    const [, family, major] = matchNoMinor
    return `${family}-${major}`
  }

  return model
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerToolContext {
  /** Names of server-side tools detected in the payload */
  serverSideToolNames: string[]
  /** Whether any server-side tools are present */
  hasServerSideTools: boolean
  /** Whether ALL tools are server-side (pure mode) */
  allServerSide: boolean
}

export interface PreprocessedRequest {
  /** Cleaned payload (service_tier removed, original model preserved) */
  payload: AnthropicMessagesPayload
  /** Original model name from client, used for provider matching */
  rawModel: string
  /** Normalized model name for Copilot routing and sending */
  copilotModel: string
  /** Filtered anthropic-beta header (only allowed betas) */
  anthropicBeta: string | null
  /** Server-side tool detection results */
  serverToolContext: ServerToolContext
}

// ---------------------------------------------------------------------------
// Beta Header Filtering
// ---------------------------------------------------------------------------

/**
 * Beta features that Copilot supports.
 * Other betas are filtered out to avoid errors.
 */
export const ALLOWED_BETAS = new Set([
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "advanced-tool-use-2025-11-20",
])

/**
 * Filter anthropic-beta header to only include supported betas.
 * Betas like "context-1m-*" are handled via model name suffix, not header.
 */
export function filterAnthropicBeta(header: string | null | undefined): string | null {
  if (!header) return null
  const filtered = header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => ALLOWED_BETAS.has(s))
  return filtered.length > 0 ? filtered.join(",") : null
}

// ---------------------------------------------------------------------------
// Payload Sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize the payload by removing fields that Copilot doesn't support.
 * Returns a new object, does not mutate the input.
 */
export function sanitizePayload(payload: AnthropicMessagesPayload): AnthropicMessagesPayload {
  // Remove service_tier (Copilot doesn't support it)
  const { service_tier: _, ...sanitized } = payload
  return sanitized as AnthropicMessagesPayload
}

// ---------------------------------------------------------------------------
// Server-side Tool Detection
// ---------------------------------------------------------------------------

/**
 * Detect server-side tools in the payload.
 * This is done early (before translation) so both native and translated paths
 * can use the same interception logic.
 */
export function detectServerTools(payload: AnthropicMessagesPayload): ServerToolContext {
  const tools = payload.tools ?? []
  const serverSideToolNames: string[] = []

  for (const tool of tools) {
    if (isServerSideTool(tool)) {
      serverSideToolNames.push(tool.name)
    }
  }

  const hasServerSideTools = serverSideToolNames.length > 0
  const allServerSide = hasServerSideTools && serverSideToolNames.length === tools.length

  return {
    serverSideToolNames,
    hasServerSideTools,
    allServerSide,
  }
}

// ---------------------------------------------------------------------------
// Main Preprocessing Function
// ---------------------------------------------------------------------------

/**
 * Preprocess an incoming Anthropic messages request.
 *
 * This function:
 * 1. Extracts the raw model name for provider routing
 * 2. Translates the model name for Copilot (copilotModel)
 * 3. Filters the anthropic-beta header
 * 4. Sanitizes the payload (removes unsupported fields)
 * 5. Detects server-side tools
 *
 * The rawModel is used for resolveProvider() matching.
 * The copilotModel is used for supportsNativeMessages() and actual Copilot requests.
 */
export function preprocessPayload(
  rawPayload: AnthropicMessagesPayload,
  rawBeta: string | null,
): PreprocessedRequest {
  const rawModel = rawPayload.model

  // 1. Copilot model name normalization (only for Copilot path)
  const copilotModel = translateModelName(rawModel, rawBeta)

  // 2. Beta header filtering
  const anthropicBeta = filterAnthropicBeta(rawBeta)

  // 3. Payload sanitization (remove service_tier, etc.)
  const payload = sanitizePayload(rawPayload)

  // 4. Server-side tool detection (before translation!)
  const serverToolContext = detectServerTools(payload)

  return {
    payload,
    rawModel,
    copilotModel,
    anthropicBeta,
    serverToolContext,
  }
}
