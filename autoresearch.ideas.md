# Autoresearch Ideas: Hot Path Optimization

## Final Results
**Baseline: 3,862µs → Current: ~3,839µs (~0.6% improvement)**

Note: Initial optimizations achieved ~10% improvement but three were reverted due to semantic/contract regressions.

## Lessons Learned
1. **Logger early return broke central bus** — Other sinks (WebSocket, DB) may have different log level needs. Events must always reach the bus.
2. **Order matters in content aggregation** — Original code: `[...textBlocks.map(), ...thinkingBlocks.map()]` preserves "text first, thinking second" order. Single-pass collection changed this.
3. **Return new array vs mutate** — `filterContentBlocks()` contract says "returns new array". Returning original array breaks caller immutability assumptions.

## Completed Optimizations (Kept)
1. ✅ Single-pass categorization in handleAssistantMessage (with correct text/thinking order)
2. ✅ Single-pass categorization in handleUserMessage
3. ✅ Single-pass mapContent
4. ✅ isToolBlockOpen: for-in loop instead of Object.values().some()
5. ✅ Avoid array allocation in sanitizeToolDefinitions
6. ✅ Pre-compile model name translation regexes

## Reverted Optimizations
1. ❌ Logger early return — broke central bus event flow
2. ❌ filterContentBlocks fast path — broke immutability contract

## Potential Future Optimizations

### Request Translation Path
- [ ] **Pre-compiled regex for model name translation**: `translateModelName` uses regex match on every call. Could pre-compile and cache patterns.
- [ ] **Avoid object spread in translateToOpenAI**: `{...base, ...optional}` creates intermediate objects. Could build directly.

### Response Translation Path
- [ ] **Avoid spread in content array**: `[...allTextBlocks, ...allToolUseBlocks]` allocates. Could use `Array.prototype.concat` or pre-allocate.

### Stream Translation Path
- [ ] **Reduce object allocations in translateChunkToAnthropicEvents**: Each event pushes new objects. Could use object pools for high-frequency paths.
- [ ] **Cache finish_reason to stop_reason mapping**: `mapOpenAIStopReasonToAnthropic` called on every chunk finish.

### SSE Parsing
- [ ] **Use typed arrays for buffer**: TextDecoder + string concatenation has overhead. Could use Uint8Array directly.
- [ ] **Batch newline detection**: Instead of split + iterate, could scan for newlines directly.

### Authentication
- [ ] **Cache hash validation results**: API key validation does hash comparison on every request. Could LRU cache valid keys (with security considerations).

### General
- [ ] **Consider using `bun:jsc` profile-guided optimization** for hot functions.
- [ ] **Add microbenchmarks for individual functions** to isolate optimization targets.

## Notes
- Benchmark variance is ~5-10%, making small improvements hard to measure
- Real-world payloads may differ from benchmark fixtures
- Security-sensitive code (auth, timing-safe compare) should not be optimized for speed
