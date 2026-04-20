/**
 * Preprocessing layer for Anthropic messages requests.
 *
 * This module handles:
 * - Model name normalization (rawModel vs copilotModel)
 * - Beta header filtering
 * - Payload sanitization
 * - Server-side tool detection
 *
 * All preprocessing happens BEFORE routing decisions, ensuring consistent
 * behavior across native passthrough and translated paths.
 */

import {
  type AnthropicMessagesPayload,
  isServerSideTool,
} from "./anthropic-types"

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
// Model Name Translation
// ---------------------------------------------------------------------------

// Pre-compiled regexes for model name translation (avoid regex compilation on each call)
const MODEL_REGEX_WITH_MINOR =
  /^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d{1,2})(?:(?:-|\[)(1m|fast)\]?)?(?:-\d{8})?$/
const MODEL_REGEX_NO_MINOR = /^(claude-(?:opus|sonnet|haiku))-(\d+)(?:-\d{8})?$/

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
  // Parse beta flags from anthropic-beta header
  const betas = anthropicBeta?.split(",").map((b) => b.trim()) ?? []
  const wants1m = betas.some((b) => b.startsWith("context-1m-"))
  const wantsFast = betas.some((b) => b.startsWith("fast-mode-"))

  // Try to match models with minor version: claude-{family}-{major}-{minor}[-suffix][-date]
  const match = model.match(MODEL_REGEX_WITH_MINOR)
  if (match) {
    const [, family, major, minor, suffix] = match
    const base = `${family}-${major}.${minor}`
    // Explicit suffix in model name takes priority
    if (suffix) return `${base}-${suffix}`
    // Otherwise, check anthropic-beta header for variant
    if (wants1m) return `${base}-1m`
    if (wantsFast) return `${base}-fast`
    return base
  }

  // No minor version: claude-{family}-{major}[-date]
  const matchNoMinor = model.match(MODEL_REGEX_NO_MINOR)
  if (matchNoMinor) {
    const [, family, major] = matchNoMinor
    return `${family}-${major}`
  }

  // Not a Claude model or already in Copilot format, return as-is
  return model
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
