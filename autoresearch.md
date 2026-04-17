# Autoresearch: Hot Path Performance Optimization

## Objective
Optimize performance of Raven proxy's hot paths without breaking any functionality.

## Primary Metric
**request_translation_ns** — Per-operation latency for request translation in nanoseconds (lower is better).

This is the single most impactful hot path: every Anthropic request must be translated to OpenAI format.

## Secondary Metrics
- `response_translation_ns` — Per-operation latency for response translation
- `stream_translation_ns` — Per-chunk latency for stream translation
- `parseSSELine_ns` — Per-line latency for SSE parsing
- `parseSSEStream_ns` — Per-event latency for SSE stream parsing

## Benchmark Suite
```bash
bun run test:perf
```

Benchmarks:
1. **SSE parsing** — `parseSSELine` and `parseSSEStream` throughput
2. **Request translation** — Anthropic → OpenAI payload conversion
3. **Response translation** — OpenAI → Anthropic response conversion
4. **Stream translation** — Chunk-by-chunk SSE event conversion

## Checks (autoresearch.checks.sh)
```bash
bun run test        # proxy unit tests (1147 tests, 90% coverage)
bun run typecheck   # type checking
```

All checks must pass. Any optimization that breaks tests is rejected.

## Rules
1. **No cheating**: Optimizations must be real, not benchmark-specific
2. **No regressions**: All existing tests must pass
3. **No breaking changes**: API compatibility must be preserved
4. **Measure real impact**: Use structured METRIC output for precise tracking

## Hot Paths to Optimize
1. `util/sse.ts` — SSE parsing (parseSSELine, parseSSEStream, events)
2. `routes/messages/stream-translation.ts` — translateChunkToAnthropicEvents
3. `routes/messages/non-stream-translation.ts` — translateToOpenAI, translateToAnthropic
4. `middleware.ts` — apiKeyAuth, timingSafeEqual (but security-sensitive)

## Constraints
- Security-sensitive code (timing-safe comparison, auth) should not be optimized for speed at the expense of security
- Memory allocation patterns matter for GC pressure
- Bun runtime specific optimizations are acceptable
