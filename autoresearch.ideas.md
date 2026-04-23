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

## 2026-04-23 Session Results
**Baseline: 2,915ns → Current best: ~1,914ns (-34.3%)**

### Key wins (kept)
1. ✅ Eliminate object/array spreads in translateToOpenAI + handleAssistantMessage
2. ✅ Single-pass extractToolUseIds without filter/map intermediate arrays
3. ✅ appendUserMessage / appendAssistantMessage push directly into shared result array (eliminate per-message intermediate array + spread)
4. ✅ appendSystemPrompt: push directly into shared result
5. ✅ appendUserMessage fast path when no tool-result flags (most common case)
6. ✅ Fuse filterContentBlocks into appendUserMessage + appendAssistantMessage categorization loops
7. ✅ Indexed for-loops in all message/content/tool iteration hot loops
8. ✅ translateToAnthropic: append* pattern, no spreads, indexed loops
9. ✅ Pre-allocated indexed loop in translateAnthropicToolsToOpenAI
10. ✅ Stream: cache chunk.usage / cached_tokens locally
11. ✅ translateModelName: zero-alloc beta scanning (charCode-based segment scanner)

### Discarded (no measurable gain)
- mapContent single-pass with eager ContentParts switch (engine handles 2-pass already)
- filterContentBlocks fast path returning input array
- Lazy alloc per-type arrays in appendAssistantMessage (null checks offset savings)
- Inline string fast-path for tool_result content (function call already cheap)

### Remaining opportunities
- [ ] Inline translateAnthropicToolChoiceToOpenAI body in translateToOpenAI
- [ ] stripBlockMetadata: try replacing `in` check + `delete` with hidden-class-friendly pattern
- [ ] Stream: avoid `events: []` allocation for no-op chunks (rare in practice)
- [ ] Response: object pool for repeated AnthropicTextBlock/AnthropicToolUseBlock shapes (risky)

### Notes
- Bun bench variance is ~10-15% between runs; need 10+ runs to detect <5% changes
- First 1-2 runs in a batch are typically warmup outliers (1.5-3x slower)
- Best path was reducing array allocations + indexed loops + zero-alloc string scanners
