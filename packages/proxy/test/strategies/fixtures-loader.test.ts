// H.1 — sanity check that all 6 strategy fixtures parse into the B.5 envelope.
import { describe, expect, test } from "bun:test"
import { FIXTURE_NAMES, loadFixture } from "./__fixtures__/loader"

describe("strategies/__fixtures__ loader", () => {
  for (const name of FIXTURE_NAMES) {
    test(`${name} loads with all B.5 fields populated`, () => {
      const fx = loadFixture(name)
      expect(fx.request.body).toBeDefined()
      expect(Array.isArray(fx.upstreamChunks)).toBe(true)
      expect(fx.upstreamChunks.length).toBeGreaterThan(0)
      expect(typeof fx.expectedClientBody).toBe("string")
      expect(fx.expectedClientBody.length).toBeGreaterThan(0)
      expect(typeof fx.expectedEndLog).toBe("object")
    })
  }
})
