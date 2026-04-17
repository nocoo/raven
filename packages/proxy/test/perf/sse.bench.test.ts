import { describe, expect, test, afterAll } from "bun:test";
import { parseSSELine, parseSSEStream } from "../../src/util/sse.ts";

// Metrics collector for autoresearch (per-operation latency in nanoseconds)
const metrics: Record<string, number> = {};

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------
const SSE_THROUGHPUT_MBPS = 50; // > 50 MB/s

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Generate a large SSE payload (1MB+) */
function generateSSEPayload(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    const data = JSON.stringify({
      id: `msg-${i}`,
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          delta: {
            content: `This is line number ${i} with some padding text to make it realistic. `,
          },
          finish_reason: null,
        },
      ],
    });
    lines.push(`data: ${data}\n\n`);
  }
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

// ===========================================================================
// SSE performance benchmarks
// ===========================================================================

describe("SSE parser performance benchmarks", () => {
  test("parseSSELine throughput", () => {
    const sampleLine =
      'data: {"id":"msg-1","object":"chat.completion.chunk","created":1700000000,"model":"m","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}';
    const iterations = 100_000;

    // Warmup
    for (let i = 0; i < 100; i++) parseSSELine(sampleLine);

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      parseSSELine(sampleLine);
    }
    const elapsed = performance.now() - start;
    const bytesProcessed = sampleLine.length * iterations;
    const mbps = bytesProcessed / 1e6 / (elapsed / 1000);

    // Per-operation latency in nanoseconds
    const avgNs = Math.round((elapsed / iterations) * 1e6);
    metrics.parseSSELine_ns = avgNs;
    console.log(
      `  parseSSELine: ${mbps.toFixed(1)} MB/s, ${avgNs}ns/op (${iterations} lines, ${elapsed.toFixed(2)}ms)`,
    );
    expect(mbps).toBeGreaterThan(SSE_THROUGHPUT_MBPS);
  });

  test(`parseSSEStream throughput > ${SSE_THROUGHPUT_MBPS} MB/s`, async () => {
    const lineCount = 10_000;
    const payload = generateSSEPayload(lineCount);
    const payloadBytes = new TextEncoder().encode(payload);
    const payloadSizeMB = payloadBytes.length / 1e6;

    // Warmup
    {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(payloadBytes);
          controller.close();
        },
      });
      let count = 0;
      for await (const _ of parseSSEStream(stream)) count++;
    }

    // Benchmark: run 3 times and take best
    let bestMbps = 0;
    for (let run = 0; run < 3; run++) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(payloadBytes);
          controller.close();
        },
      });

      const start = performance.now();
      let chunkCount = 0;
      for await (const _ of parseSSEStream(stream)) chunkCount++;
      const elapsed = performance.now() - start;

      const mbps = payloadSizeMB / (elapsed / 1000);
      if (mbps > bestMbps) bestMbps = mbps;
    }

    // Per-event latency in nanoseconds (for best run)
    const bestElapsedMs = payloadSizeMB / bestMbps * 1000;
    const avgNs = Math.round((bestElapsedMs / lineCount) * 1e6);
    metrics.parseSSEStream_ns = avgNs;
    console.log(
      `  parseSSEStream: ${bestMbps.toFixed(1)} MB/s, ${avgNs}ns/event (${lineCount} events, ${payloadSizeMB.toFixed(2)} MB payload)`,
    );
    expect(bestMbps).toBeGreaterThan(SSE_THROUGHPUT_MBPS);
  });

  afterAll(() => {
    // Output metrics for autoresearch (per-operation latency in ns)
    console.log(`METRIC parseSSELine_ns=${metrics.parseSSELine_ns}`);
    console.log(`METRIC parseSSEStream_ns=${metrics.parseSSEStream_ns}`);
  });
});
