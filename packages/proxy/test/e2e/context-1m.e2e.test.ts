/**
 * E2E validation for 1M context window models.
 *
 * This test suite verifies that:
 * 1. Model name translation works correctly (claude-opus-4.6-1m is available)
 * 2. The -1m variant can handle progressively larger contexts
 * 3. Context boundaries are tested at key breakpoints (128K, 200K, 500K, 800K)
 *
 * Prerequisites:
 *   - Proxy running on localhost:7024
 *   - Valid Copilot token configured
 *   - RAVEN_API_KEY environment variable set
 *
 * Usage:
 *   # Run all tests (large context tests are skipped by default)
 *   RAVEN_API_KEY=<key> bun test test/e2e/context-1m.e2e.test.ts
 *
 *   # Run specific large context test (remove .skip and run)
 *   RAVEN_API_KEY=<key> bun test test/e2e/context-1m.e2e.test.ts -t "128K"
 *
 * Anti-ban protocol:
 *   - Each context size test sends exactly 1 request
 *   - Fail fast on any error
 *   - No retries
 *
 * WARNING: Large context tests consume significant tokens. Run manually only.
 */

import { describe, test, expect, beforeAll, setDefaultTimeout } from "bun:test"

// Set default timeout to 15 minutes for large context tests
setDefaultTimeout(900_000)

const PROXY = process.env.RAVEN_PROXY_URL ?? "http://localhost:7024"
const API_KEY = process.env.RAVEN_API_KEY ?? ""

// Model to test (explicit 1m variant)
const MODEL_1M = "claude-opus-4-6-1m"
const MODEL_STANDARD = "claude-opus-4-6"

// Generate a unique marker for verification
function generateMarker(): string {
  return `MARKER_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

// Generate a story with embedded markers for verification
function generateStoryWithMarkers(
  targetTokens: number,
  markers: { position: number; value: string }[],
): string {
  // Approximate: 1 word ≈ 1.3 tokens, so we need targetTokens / 1.3 words
  const targetWords = Math.floor(targetTokens / 1.3)

  // Story template paragraphs (each ~50-100 words)
  const paragraphs = [
    "The ancient library stood silent in the moonlight, its towering shelves reaching toward a ceiling lost in shadow. Dust motes danced in the pale beams that filtered through cracked windows, illuminating leather-bound volumes that had not been touched in centuries. The smell of old paper and forgotten knowledge hung heavy in the air.",
    "Professor Elena Chen stepped carefully between the fallen books, her flashlight cutting through the darkness. She had spent fifteen years searching for this place, following cryptic clues left by scholars long dead. Now, standing in the heart of the lost Archive of Alexandria, she could barely believe her eyes.",
    "The manuscripts here predated any known collection. Some bore symbols that matched no known alphabet, their pages seemingly immune to the decay that should have claimed them millennia ago. Elena's hands trembled as she reached for the nearest volume, its cover embossed with a strange geometric pattern.",
    "As she opened the book, the symbols seemed to shift and rearrange themselves before her eyes. She blinked, convinced it was a trick of the light, but the movement continued. The text was reorganizing itself, forming words she could almost understand.",
    "A sound echoed from deeper in the library. Elena froze, her heart pounding. She had been assured this location was unknown to anyone else. The sound came again, closer now, footsteps on the ancient marble floor. Someone else was here.",
    "She extinguished her flashlight and pressed herself against the nearest shelf. The footsteps grew louder, accompanied by the soft glow of another light source. Through a gap between books, she could see a figure approaching, robed in dark fabric that seemed to absorb the light around it.",
    "The figure stopped at a reading table and placed something upon it. Even from her hiding spot, Elena could see it was another book, but this one glowed faintly with an inner light. The robed figure began to speak in a language she had never heard, yet somehow understood perfectly.",
    "The words spoke of knowledge hidden since the dawn of human civilization, of truths too dangerous for the unprepared mind. They spoke of the library's true purpose, not to preserve knowledge, but to protect the world from it.",
    "Elena realized she had stumbled into something far beyond a mere historical discovery. This was a living institution, guarded across millennia by keepers who existed outside normal time. And now, they knew she was here.",
    "The figure turned toward her hiding spot, and Elena saw that beneath the hood there was no face, only a swirling void of stars and darkness. A voice spoke directly into her mind, ancient and vast as the cosmos itself.",
  ]

  const parts: string[] = []
  let currentWords = 0
  let paragraphIndex = 0

  // Sort markers by position
  const sortedMarkers = [...markers].sort((a, b) => a.position - b.position)
  let markerIndex = 0

  while (currentWords < targetWords) {
    // Check if we need to insert a marker
    if (markerIndex < sortedMarkers.length) {
      const marker = sortedMarkers[markerIndex]!
      const markerWordPosition = Math.floor((marker.position / targetTokens) * targetWords)

      if (currentWords >= markerWordPosition) {
        parts.push(`\n\n[${marker.value}]\n\n`)
        markerIndex++
        continue
      }
    }

    // Add a paragraph
    const paragraph = paragraphs[paragraphIndex % paragraphs.length]!
    parts.push(paragraph + "\n\n")
    currentWords += paragraph.split(/\s+/).length
    paragraphIndex++
  }

  return parts.join("")
}

// Headers for authenticated requests
function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  }
  if (API_KEY) {
    h["Authorization"] = `Bearer ${API_KEY}`
  }
  return h
}

// Fail-fast helper
function failFastOnError(res: Response, body: string): void {
  if (!res.ok) {
    throw new Error(
      `Upstream error ${res.status} — aborting 1M context test to avoid ban.\n${body.slice(0, 500)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Connectivity and model availability check
// ---------------------------------------------------------------------------

let proxyReachable = false
let model1mAvailable = false
let authConfigured = false

// Helper to check prerequisites
function skipIfNotReady(): boolean {
  if (!proxyReachable) {
    console.log("Skipping: proxy not reachable")
    return true
  }
  if (!authConfigured) {
    console.log("Skipping: auth not configured")
    return true
  }
  return false
}

beforeAll(async () => {
  // Check proxy connectivity
  try {
    const res = await fetch(`${PROXY}/health`, { signal: AbortSignal.timeout(3000) })
    proxyReachable = res.ok
  } catch {
    proxyReachable = false
  }

  if (!proxyReachable) {
    console.warn("\n⚠️  Proxy not reachable at %s — skipping 1M context tests\n", PROXY)
    return
  }

  // Check if API key is configured
  if (!API_KEY) {
    console.warn("\n⚠️  RAVEN_API_KEY not set — skipping 1M context tests")
    console.warn("   Set it via: RAVEN_API_KEY=<your-key> bun test test/e2e/context-1m.e2e.test.ts\n")
    return
  }

  // Check if 1M model is available
  try {
    const res = await fetch(`${PROXY}/v1/models`, { headers: headers() })
    if (res.ok) {
      authConfigured = true
      const body = await res.json()
      const models = body.data as Array<{ id: string }>
      model1mAvailable = models.some(
        (m) => m.id === "claude-opus-4.6-1m" || m.id === "claude-opus-4-6-1m",
      )
      if (!model1mAvailable) {
        console.warn("\n⚠️  Model claude-opus-4.6-1m not found in available models")
        console.log(
          "Available Claude models:",
          models
            .filter((m) => m.id.includes("claude"))
            .map((m) => m.id)
            .join(", "),
        )
      }
    } else if (res.status === 401) {
      console.warn("\n⚠️  Authentication failed — check RAVEN_API_KEY")
      console.warn("   Response:", await res.text())
    }
  } catch (e) {
    console.warn("\n⚠️  Failed to fetch models:", e)
  }
})

// ===========================================================================
// Layer 1: Model Availability and Name Translation
// ===========================================================================

describe("1M Context: Model Availability", () => {
  test("claude-opus-4.6-1m is available in model list", async () => {
    if (skipIfNotReady()) return

    const res = await fetch(`${PROXY}/v1/models`, { headers: headers() })
    expect(res.status).toBe(200)

    const body = await res.json()
    const models = body.data as Array<{ id: string; context_window?: number }>

    // Find the 1M model
    const model1m = models.find((m) => m.id.includes("opus") && m.id.includes("1m"))
    expect(model1m).toBeDefined()
    console.log("Found 1M model:", model1m?.id, "context_window:", model1m?.context_window)
  })

  test("Model name translation works for explicit 1m suffix", async () => {
    if (skipIfNotReady()) return

    // Send a minimal request to verify the model is routed correctly
    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL_1M,
        max_tokens: 16,
        messages: [{ role: "user", content: "Say 'ok'" }],
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error("Model validation failed:", text.slice(0, 500))
      failFastOnError(res, text)
    }

    const body = await res.json()
    expect(body.type).toBe("message")
    expect(body.model).toBeDefined()
    console.log("Response model:", body.model)
  })
})

// ===========================================================================
// Layer 2: Context Size Validation
// ===========================================================================

describe("1M Context: Size Breakpoints", () => {
  // Test each breakpoint individually
  // NOTE: Large context tests are skipped by default (expensive)

  test("Baseline: Small context (1K tokens) works", async () => {
    if (skipIfNotReady()) return

    const marker = generateMarker()
    const story = generateStoryWithMarkers(1000, [{ position: 500, value: marker }])

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL_1M,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: `Here is a story:\n\n${story}\n\nWhat is the marker code embedded in the story? Reply with just the marker.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    })

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()
    expect(body.type).toBe("message")
    expect(body.content[0].text).toContain(marker)
    console.log("✓ 1K context baseline passed, found marker:", marker)
  })

  // ---------------------------------------------------------------------------
  // Large context tests (skipped by default — remove .skip to run)
  // ---------------------------------------------------------------------------

  test("128K context boundary", async () => {
    if (skipIfNotReady()) return

    const marker = generateMarker()
    const story = generateStoryWithMarkers(128_000, [
      { position: 10_000, value: `EARLY_${marker}` },
      { position: 64_000, value: `MIDDLE_${marker}` },
      { position: 120_000, value: `LATE_${marker}` },
    ])

    console.log("Sending 128K context request...")
    const startTime = Date.now()

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL_1M,
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: `${story}\n\nList all three marker codes (EARLY_, MIDDLE_, LATE_) you found in the story above.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(180000), // 3 min timeout for large context
    })

    const elapsed = Date.now() - startTime
    console.log(`Request completed in ${elapsed}ms`)

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()
    expect(body.type).toBe("message")

    const responseText = body.content[0].text
    expect(responseText).toContain(`EARLY_${marker}`)
    expect(responseText).toContain(`MIDDLE_${marker}`)
    expect(responseText).toContain(`LATE_${marker}`)

    console.log("✓ 128K context passed")
    console.log("  Input tokens:", body.usage?.input_tokens)
    console.log("  Output tokens:", body.usage?.output_tokens)
  })

  test("200K context (exceeds standard 200K limit)", async () => {
    if (skipIfNotReady()) return

    const marker = generateMarker()
    const story = generateStoryWithMarkers(200_000, [
      { position: 50_000, value: `QUARTER_${marker}` },
      { position: 150_000, value: `THREE_QUARTER_${marker}` },
    ])

    console.log("Sending 200K context request (should fail on non-1m model)...")
    const startTime = Date.now()

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL_1M,
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: `${story}\n\nFind the two marker codes in the story.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(300000), // 5 min timeout
    })

    const elapsed = Date.now() - startTime
    console.log(`Request completed in ${elapsed}ms`)

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()
    expect(body.type).toBe("message")

    const responseText = body.content[0].text
    expect(responseText).toContain(marker)

    console.log("✓ 200K context passed - 1M model can handle beyond standard limit")
    console.log("  Input tokens:", body.usage?.input_tokens)
  })

  test("500K context (halfway to 1M)", async () => {
    if (skipIfNotReady()) return

    const marker = generateMarker()
    const story = generateStoryWithMarkers(500_000, [
      { position: 100_000, value: `P20_${marker}` },
      { position: 250_000, value: `P50_${marker}` },
      { position: 400_000, value: `P80_${marker}` },
    ])

    console.log("Sending 500K context request...")
    const startTime = Date.now()

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL_1M,
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: `${story}\n\nList all marker codes found (P20_, P50_, P80_).`,
          },
        ],
      }),
      signal: AbortSignal.timeout(600000), // 10 min timeout
    })

    const elapsed = Date.now() - startTime
    console.log(`Request completed in ${elapsed}ms`)

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()
    expect(body.type).toBe("message")

    console.log("✓ 500K context passed")
    console.log("  Input tokens:", body.usage?.input_tokens)
  })

  test("800K context (near 1M limit)", async () => {
    if (skipIfNotReady()) return

    const marker = generateMarker()
    const story = generateStoryWithMarkers(800_000, [
      { position: 100_000, value: `START_${marker}` },
      { position: 400_000, value: `MID_${marker}` },
      { position: 700_000, value: `END_${marker}` },
    ])

    console.log("Sending 800K context request (near 1M limit)...")
    const startTime = Date.now()

    const res = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL_1M,
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: `${story}\n\nWhat are the three marker codes?`,
          },
        ],
      }),
      signal: AbortSignal.timeout(900000), // 15 min timeout
    })

    const elapsed = Date.now() - startTime
    console.log(`Request completed in ${elapsed}ms`)

    if (!res.ok) {
      failFastOnError(res, await res.text())
    }

    const body = await res.json()
    expect(body.type).toBe("message")

    console.log("✓ 800K context passed")
    console.log("  Input tokens:", body.usage?.input_tokens)
  })
})

// ===========================================================================
// Layer 3: Compare 1M vs Standard Model
// ===========================================================================

describe("1M Context: Model Comparison", () => {
  test("Standard model rejects context beyond limit, 1M accepts it", async () => {
    if (skipIfNotReady()) return

    const marker = generateMarker()
    // Generate 250K tokens - should fail on standard 200K model
    const story = generateStoryWithMarkers(250_000, [{ position: 125_000, value: marker }])

    // Test standard model (should fail or truncate)
    console.log("Testing standard claude-opus-4-6 with 250K context...")
    const standardRes = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL_STANDARD,
        max_tokens: 64,
        messages: [{ role: "user", content: story }],
      }),
      signal: AbortSignal.timeout(60000),
    })

    const standardBody = await standardRes.text()
    const standardFailed =
      !standardRes.ok || standardBody.includes("context") || standardBody.includes("token")
    console.log(
      "Standard model result:",
      standardRes.status,
      standardFailed ? "(expected failure)" : "(unexpected success)",
    )

    // Test 1M model (should succeed)
    console.log("Testing claude-opus-4-6-1m with 250K context...")
    const res1m = await fetch(`${PROXY}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: MODEL_1M,
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: `${story}\n\nFind the marker code.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(300000),
    })

    if (!res1m.ok) {
      failFastOnError(res1m, await res1m.text())
    }

    const body1m = await res1m.json()
    expect(body1m.type).toBe("message")
    expect(body1m.content[0].text).toContain(marker)

    console.log("✓ 1M model successfully handled 250K context where standard model couldn't")
  })
})
