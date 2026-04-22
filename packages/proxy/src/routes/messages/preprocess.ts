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

// A.5: `translateModelName` has moved to protocols/anthropic/preprocess.
// This file remains as a transitional shim re-exporting the canonical
// helper; D.1 deletes the shim entirely and migrates importers.
export { translateModelName } from "../../protocols/anthropic/preprocess"
import { translateModelName } from "../../protocols/anthropic/preprocess"

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

// The canonical implementation now lives in protocols/anthropic/preprocess.
// Re-exported at the top of this file for backward compat until D.1.

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
