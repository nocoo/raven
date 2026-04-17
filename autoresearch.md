# Autoresearch: Hot Path Performance Optimization

## Objective
Optimize performance of Raven proxy's hot paths without breaking any functionality.

## Primary Metric
**total_µs** — Total benchmark execution time in microseconds (lower is better).

Computed as the sum of all benchmark durations from `bun run test:perf`.

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
bun run test        # proxy unit tests (584 tests, 90% coverage)
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
