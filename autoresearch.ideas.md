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

## 2026-04-23 Session Results (continued)
**Baseline: 2,915ns → Current best: 1,738ns (-40.4%)** (median ~1770ns, very stable)

### Latest wins (kept)
12. ✅ Inline mapContent for string content in append* fast paths (#38)
13. ✅ mapContent: skip join() when textParts.length === 1
14. ✅ Skip join() for single text/thinking in assistant message
15. ✅ Cache usage lookup chain in translateToAnthropic (response improved 510→482)
16. ✅ Normalize Message property order across all role variants for hidden class sharing
17. ✅ **Single object literal in translateToOpenAI (stable hidden class via `as` cast)** (#52)

### Discarded (recent attempts)
- Hoist flagsActive once + pass through (no perf gain, branch overhead)
- Skip ids array allocation in appendAssistantMessage (branch overhead)
- DEFAULT_FLAGS frozen singleton reuse (worse perf)
- mapContent fast path for single text/thinking block (more variance)
- UNSUPPORTED_LOOKUP prototype-less object map (within noise)
- Cache toolUseBlocks.length / toolUse.id locals (JIT does this)
- Inline string fast path for tool_result content (function call already cheap)

### Hard limits hit
- Strict coverage gate (protocols/ baseline 99.37, allowance 0.1pp) blocks dead-code removals
- exactOptionalPropertyTypes requires `as` cast for unified-literal pattern
- Bun JIT already does load-elimination, length caching, function inlining
- 14-message per-call work appears to be near-irreducible (object allocations + JSON.stringify)

### Notes
- Bun bench variance is ~5-15% between runs; need 10+ runs to detect <5% changes
- First 1-2 runs in a batch are typically warmup outliers (1.5-3x slower)
- Best path was reducing array allocations + indexed loops + zero-alloc string scanners + hidden class normalization

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

## Recently exhausted attempts (sessions 60-66, all worse or coverage-failed)
- ❌ NO_MINOR regex first in translateModelName (run 60)
- ❌ Inline tool_calls/ids during scan, lazy alloc (run 61, 35)
- ❌ Single-pass mapContent on-demand (run 62)
- ❌ Undefined-compare instead of `in` for stripBlockMetadata (run 63)
- ❌ Switch-first dispatch in appendAssistantMessage (run 64) — coverage regression on default branch
- ❌ Short-circuit type-compare before Set.has (run 65) — coverage regression
- ❌ Use EMPTY_IDS singleton as initial pendingToolCallIds (run 66)

## Still untried
- [ ] Inline appendSystemPrompt into outer translateAnthropicMessagesToOpenAI loop
- [ ] Pre-allocate result Array<Message> with `new Array(messages.length * 2 + 1)` and index-track
- [ ] Hand-rolled JSON.stringify for simple tool input (avoid generic stringify cost)
- [ ] Inline fast paths of appendUser/AssistantMessage into loop body (size limits JIT inlining?)
- [ ] Replace `for (let i; i < arr.length; i++)` with cached length once JIT specializes hot loop

## Coverage notes (avoid regressions)
- Adding a `default:` case in switch creates an uncovered branch (no test covers unknown-but-supported assistant types)
- Removing a `mapContent(filteredContent)` fallback removes the only test path that exercises certain mapContent text-only branches
