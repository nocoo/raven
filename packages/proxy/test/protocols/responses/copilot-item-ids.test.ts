import { describe, expect, test } from "vitest"

import { normalizeCopilotItemIds } from "../../../src/protocols/responses/copilot-item-ids"

describe("Copilot Responses item IDs", () => {
  test.each([
    ["message", "response.output_text.delta"],
    ["reasoning", "response.reasoning_summary_text.delta"],
    ["function_call", "response.function_call_arguments.delta"],
  ])("anchors %s events without changing their content", (type, deltaType) => {
    const ids = new Map<number, string>()
    const added = { output_index: 0, item: { type, id: "added-id" } }
    expect(normalizeCopilotItemIds(added, "response.output_item.added", ids)).toBe(added)
    for (const item_id of ["delta-1", "delta-2"]) {
      const delta = { output_index: 0, item_id, delta: "same text", sequence_number: 7, content_index: 0 }
      expect(normalizeCopilotItemIds(delta, deltaType, ids)).toEqual({ ...delta, item_id: "added-id" })
      expect(delta.item_id).toBe(item_id)
    }
    const done = { output_index: 0, item: { type, id: "done-id", encrypted_content: "fixture", call_id: "call-1", arguments: "{}" } }
    expect(normalizeCopilotItemIds(done, "response.output_item.done", ids)).toEqual({
      ...done, item: { ...done.item, id: "added-id" },
    })
    expect(done.item.id).toBe("done-id")
  })

  test("keeps interleaved items separate and retains the first added ID", () => {
    const ids = new Map<number, string>()
    for (const index of [0, 1]) {
      normalizeCopilotItemIds({ output_index: index, item: { id: `item-${index}` } }, "response.output_item.added", ids)
    }
    expect(normalizeCopilotItemIds({ output_index: 0, item: { id: "repeated-added" } }, "response.output_item.added", ids))
      .toEqual({ output_index: 0, item: { id: "item-0" } })
    for (const index of [1, 0, 1]) {
      expect(normalizeCopilotItemIds({ output_index: index, item_id: "changing", delta: "identical" }, "response.output_text.delta", ids))
        .toEqual({ output_index: index, item_id: `item-${index}`, delta: "identical" })
    }
  })

  test.each(["response.completed", "response.done", "response.incomplete", "response.failed"])(
    "keeps %s snapshots consistent without changing usage or unregistered items",
    (event) => {
      const ids = new Map([[0, "reasoning"], [1, "message"], [2, "tool"]])
      const response = { id: "response-id", output: [
        { type: "reasoning", id: "r-done", encrypted_content: "fixture" },
        { type: "message", id: "m-done", content: [{ type: "output_text", text: "Hello" }] },
        { type: "function_call", id: "t-done", call_id: "call-1", name: "read", arguments: "{}" },
        { type: "message", id: "unregistered" },
      ], usage: { input_tokens: 5, output_tokens: 9 } }
      const snapshot = JSON.parse(JSON.stringify(response))
      expect(normalizeCopilotItemIds({ response }, event, ids)).toEqual({
        response: { ...response, output: response.output.map((item, i) => ({ ...item, id: ids.get(i) ?? item.id })) },
      })
      expect(response).toEqual(snapshot)
    },
  )

  test("preserves stable, unknown and malformed frames by identity", () => {
    const ids = new Map([[0, "stable"]])
    const cases: { event: string | undefined; value: unknown }[] = [
      ...[null, [], 1, "text"].map((value) => ({ event: "response.output_item.added", value })),
      ...[undefined, -1, 0.5, "0"].map((output_index) => ({ event: "response.output_text.delta", value: { output_index, item_id: "bad" } })),
      ...[null, [], {}, { id: 1 }, { id: "" }].map((item) => ({ event: "response.output_item.added", value: { output_index: 1, item } })),
      ...[null, [], {}, { id: 1 }, { id: "stable" }].map((item) => ({ event: "response.output_item.done", value: { output_index: 0, item } })),
      { event: "response.output_item.done", value: { output_index: 3, item: { id: "unregistered" } } },
      { event: "response.output_text.delta", value: { output_index: 0, item_id: "stable" } },
      { event: "response.output_text.delta", value: { output_index: 0, item_id: 1 } },
      { event: "custom", value: { output_index: 0, item_id: "custom" } },
      { event: undefined, value: { output_index: 0, item_id: "custom" } },
      ...[null, [], {}, { output: null }, { output: [] }, { output: [{ id: "stable" }, { id: "unknown" }, null] }]
        .map((response) => ({ event: "response.completed", value: { response } })),
    ]
    for (const { value, event } of cases) expect(normalizeCopilotItemIds(value, event, ids)).toBe(value)
    expect(ids).toEqual(new Map([[0, "stable"]]))
  })
})
