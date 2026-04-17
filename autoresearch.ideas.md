# Autoresearch Ideas: Hot Path Optimization

## Final Results
**Baseline: 3,862µs → Current: ~3,470µs (10% improvement)**

## Completed Optimizations
1. ✅ Logger: skip event creation when level check fails
2. ✅ Single-pass categorization in handleAssistantMessage (3 filter → 1 for-switch)
3. ✅ Single-pass categorization in handleUserMessage (2 filter → 1 for)
4. ✅ Single-pass mapContent (some+filter+map+join → 1 for-switch)
5. ✅ isToolBlockOpen: for-in loop instead of Object.values().some()
6. ✅ Avoid array allocation in sanitizeToolDefinitions
7. ✅ filterContentBlocks fast path: avoid array allocation when no filtering needed
8. ✅ Pre-compile model name translation regexes

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
