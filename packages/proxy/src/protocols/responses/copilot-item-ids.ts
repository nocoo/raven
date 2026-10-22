import { isTerminalResponseEvent } from "./stream-state"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function withItemId(item: unknown, id: string | undefined): unknown {
  if (!isRecord(item) || id === undefined || typeof item.id !== "string" || item.id === id) return item
  return { ...item, id }
}

/**
 * Copilot can mint a different opaque item ID for every event of one output.
 * Anchor each output_index to its first output_item.added ID so clients can
 * reconcile deltas and completed items. Keep the upstream-issued ID for replay.
 * The caller owns one map per stream; payloads and non-ID fields stay intact.
 * See https://github.com/BerriAI/litellm/pull/30072 for the same upstream issue.
 */
export function normalizeCopilotItemIds(
  value: unknown,
  event: string | undefined,
  ids: Map<number, string>,
): unknown {
  if (!isRecord(value)) return value

  if (isTerminalResponseEvent(event)) {
    const response = value.response
    if (!isRecord(response) || !Array.isArray(response.output)) return value
    let changed = false
    const output = response.output.map((item: unknown, index: number) => {
      const next = withItemId(item, ids.get(index))
      changed ||= next !== item
      return next
    })
    return changed ? { ...value, response: { ...response, output } } : value
  }

  const index = value.output_index
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return value
  if (event === "response.output_item.added" && isRecord(value.item)) {
    const id = value.item.id
    if (typeof id === "string" && id.length > 0 && !ids.has(index)) ids.set(index, id)
  }

  const id = ids.get(index)
  if (id === undefined) return value
  if (event === "response.output_item.added" || event === "response.output_item.done") {
    const item = withItemId(value.item, id)
    return item !== value.item ? { ...value, item } : value
  }
  if (event?.startsWith("response.") && typeof value.item_id === "string" && value.item_id !== id) {
    return { ...value, item_id: id }
  }
  return value
}
