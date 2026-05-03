import { describe, expect, test } from "vitest"
import { generateRequestId } from "../../src/util/id"

// ===========================================================================
// generateRequestId
// ===========================================================================

describe("generateRequestId", () => {
  test("returns a string of expected length (26 chars: 10 ts + 16 random)", () => {
    const id = generateRequestId()
    expect(typeof id).toBe("string")
    expect(id).toHaveLength(26)
  })

  test("format: uppercase alphanumeric", () => {
    const id = generateRequestId()
    expect(id).toMatch(/^[0-9A-Z]{26}$/)
  })

  test("two sequential calls produce different IDs", () => {
    const a = generateRequestId()
    const b = generateRequestId()
    expect(a).not.toBe(b)
  })

  test("IDs sort chronologically (earlier < later)", async () => {
    const a = generateRequestId()
    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 2))
    const b = generateRequestId()
    // First 10 chars are the timestamp prefix — earlier should sort first
    expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true)
  })

  test("generates 1000 IDs without collision", () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      ids.add(generateRequestId())
    }
    expect(ids.size).toBe(1000)
  })
})
