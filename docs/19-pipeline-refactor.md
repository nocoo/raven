# Pipeline Architecture Refactor

## Problem Statement

Current proxy architecture has accumulated technical debt:

1. **Controller Overload**: `handleCompletion()` in `/v1/messages` does 7+ concerns:
   - Auth post-flow entry
   - Provider routing
   - Anthropic/OpenAI protocol translation
   - Copilot native branching
   - Server-tools interception
   - Stream conversion
   - Logging/metrics

2. **Asymmetric Protocol Support**: `/v1/messages` supports both Anthropic passthrough and OpenAI translation, but `/v1/chat/completions` rejects Anthropic upstreams. Strategy scattered in handlers.

3. **Duplicated Streaming Pattern**: 5 places have near-identical stream/try-catch/finally/metrics templates.

4. **Redundant Upstream Adapters**: `send-openai.ts` and `send-anthropic.ts` duplicate URL building, header assembly, socks5 handling, error handling.

5. **Route Style Drift**: Messages uses factory + forwardError, chat-completions uses direct Hono + try/catch, responses has no error wrapper.

6. **Runtime JSON.parse**: `resolveProvider()` parses `provider.model_patterns` on every request.

## Design Principles

### Separation of Concerns

**路由决策 (Route Decision)** 和 **协议转换 (Protocol Translation)** 必须严格分离：

- **Route Decision** → 产出明确的 `ExecutorKind`，决定走哪条执行路径
- **Protocol Translation** → 只在已确定的路径内做格式转换，不承担路由职责

### Executor Model (Not Adapter Model)

**关键洞察**：`anthropic → anthropic` 不是一个格子，而是至少两条完全不同的执行路径：

| ExecutorKind | 特性 |
|--------------|------|
| `copilot-native` | Copilot /v1/messages，带 beta 过滤、effort fallback、server-tools 拦截 |
| `custom-anthropic` | 自定义 Anthropic upstream passthrough，原样转发 |
| `copilot-translated` | Copilot /chat/completions，Anthropic→OpenAI 翻译 |
| `custom-openai` | 自定义 OpenAI upstream passthrough |

每个 Executor 是独立的执行单元，内部包含：
- 协议转换（如果需要）
- 特定的 transport 调用
- 特定的 stream 处理
- 特定的错误处理

```typescript
// Route decision 产出
type ExecutorKind =
  | "copilot-native"        // Claude → Copilot /v1/messages
  | "copilot-translated"    // Any → Copilot /chat/completions (translate)
  | "custom-anthropic"      // Any → Custom Anthropic upstream
  | "custom-openai"         // Any → Custom OpenAI upstream

interface RouteDecision {
  kind: ExecutorKind
  provider?: CompiledProvider  // Only for custom-* kinds
  copilotModel?: string        // Only for copilot-* kinds
}
```

### Streaming: Protocol-Specific, Not Unified

**关键洞察**：4 类流的语义完全不同，不应该用一个 runner 统一：

| Stream Type | 终止条件 | Usage 提取 | 错误格式 | 特殊处理 |
|-------------|----------|-----------|---------|---------|
| Anthropic native | message_stop event | message_delta.usage | Anthropic error event | — |
| Anthropic translated | [DONE] marker | Final chunk.usage | Translate to Anthropic | State machine |
| OpenAI passthrough | [DONE] marker | Final chunk.usage | OpenAI error | — |
| OpenAI native | [DONE] marker | stream_options.include_usage | OpenAI error | — |

更好的抽象层次：
- **Stream Pump** — 底层：从 Response 读取 SSE events
- **Protocol Inspector** — 中层：按协议解析 chunk，提取 metrics
- **Stream Emitter** — 上层：按目标协议格式化输出
- **Stream Finalizer** — 收尾：生成 request_end 日志

```typescript
// 不是统一 runner，而是可组合的工具
interface StreamPump {
  /** Read SSE events from response */
  events(response: Response): AsyncGenerator<ServerSentEvent>
}

interface ProtocolInspector<TChunk> {
  /** Parse raw SSE data to typed chunk */
  parse(data: string): TChunk
  /** Extract metrics from chunk */
  extractMetrics(chunk: TChunk): Partial<StreamMetrics>
  /** Check if stream is complete */
  isComplete(chunk: TChunk): boolean
}

interface StreamFinalizer {
  /** Generate request_end log with collected metrics */
  finalize(metrics: StreamMetrics, error?: Error): void
}
```

### Capability Matrix vs Execution Matrix

两个不同的矩阵，不要混淆：

**Capability Matrix** — 协议支持声明（静态）：
```typescript
const CAPABILITY_MATRIX = {
  "anthropic-client": {
    "anthropic-upstream": true,   // ✅ Supported
    "openai-upstream": true,      // ✅ Supported (translate)
  },
  "openai-client": {
    "openai-upstream": true,      // ✅ Supported
    "anthropic-upstream": false,  // ❌ Not supported
  },
}
```

**Execution Matrix** — 路由到具体 Executor（运行时）：
```typescript
function resolveExecutor(
  clientProtocol: "anthropic" | "openai",
  provider: CompiledProvider | null,
  copilotModel: string,
): ExecutorKind {
  if (provider) {
    // Custom upstream
    return provider.format === "anthropic" 
      ? "custom-anthropic" 
      : "custom-openai"
  }
  // Copilot
  if (clientProtocol === "anthropic" && supportsNativeMessages(copilotModel)) {
    return "copilot-native"
  }
  return "copilot-translated"
}
```

## Target Architecture

### Core Pipeline (4 stages)

```
[1] Parse/Preprocess
    ├── Parse request body
    ├── Normalize model name (rawModel → copilotModel)
    ├── Extract metadata (beta headers, client identity)
    └── Detect server-side tools

[2] Route Decision
    ├── Match provider by model pattern (compiled patterns)
    ├── Check capability matrix (reject unsupported combos)
    └── Resolve ExecutorKind

[3] Execute (dispatch to specific executor)
    ├── copilot-native: Native Anthropic + effort fallback + server-tools
    ├── copilot-translated: Translate + OpenAI + server-tools
    ├── custom-anthropic: Passthrough to custom Anthropic
    └── custom-openai: Passthrough to custom OpenAI

[4] Present/Log
    ├── Stream/Response formatting (protocol-specific)
    ├── Metrics extraction
    └── Request log finalization
```

### Provider Runtime Compilation

Move JSON.parse from request time to load time:

```typescript
interface CompiledPattern {
  raw: string
  isExact: boolean
  prefix?: string  // For glob patterns like "gpt-*"
}

interface CompiledProvider extends Omit<ProviderRecord, 'model_patterns'> {
  patterns: CompiledPattern[]
}

function compileProvider(record: ProviderRecord): CompiledProvider {
  const patterns = JSON.parse(record.model_patterns).map((p: string) => ({
    raw: p,
    isExact: !p.includes('*'),
    prefix: p.endsWith('*') ? p.slice(0, -1) : undefined,
  }))
  return { ...record, patterns }
}
```

### Unified Route Wrapper

Single pattern for all routes:

```typescript
function createRoutes(endpoints: RouteEndpoint[]): Hono {
  const routes = new Hono()
  for (const [method, path, handler] of endpoints) {
    routes[method](path, async (c) => {
      try {
        return await handler(c)
      } catch (error) {
        return await forwardError(c, error)
      }
    })
  }
  return routes
}
```

## Implementation Plan

### Phase 1: Provider Compilation (Low risk)

1. Add `CompiledProvider` type and `compileProvider()` function
2. Update state loading to compile providers
3. Update `resolveProvider()` to use compiled patterns
4. Add unit tests

**Files:** `lib/state.ts`, `lib/upstream-router.ts`, `db/providers.ts`

### Phase 2: Unified Route Wrapper (Low risk)

1. Create `lib/route-wrapper.ts`
2. Migrate all route.ts files to use it

**Files:** `lib/route-wrapper.ts` (new), all `route.ts` files

### Phase 3: Controller Decomposition — Route Decision (Medium risk)

**关键步骤**：先把 routeDecision → executor 边界拉出来

1. Create `lib/route-decision.ts` with `resolveExecutor()`
2. Define `ExecutorKind` enum
3. Extract route decision logic from `handleCompletion()`
4. Handler becomes thin orchestration layer

```typescript
// New: lib/route-decision.ts
export function resolveExecutor(
  clientProtocol: "anthropic" | "openai",
  rawModel: string,
  copilotModel: string,
): RouteDecision {
  const provider = resolveProvider(rawModel)
  
  if (provider) {
    if (clientProtocol === "openai" && provider.format === "anthropic") {
      throw new UnsupportedRouteError("OpenAI client → Anthropic upstream")
    }
    return {
      kind: provider.format === "anthropic" ? "custom-anthropic" : "custom-openai",
      provider,
    }
  }
  
  // Copilot path
  if (clientProtocol === "anthropic" && supportsNativeMessages(copilotModel)) {
    return { kind: "copilot-native", copilotModel }
  }
  return { kind: "copilot-translated", copilotModel }
}
```

**Files:** `lib/route-decision.ts` (new), `routes/messages/handler.ts`

### Phase 4: Controller Decomposition — Executors (Medium risk)

1. Create `routes/messages/executors/` directory
2. Extract each path into its own executor:
   - `copilot-native.ts` — from `native-handler.ts`
   - `copilot-translated.ts` — from `handler.ts` translated path
   - `custom-anthropic.ts` — from `handler.ts` Anthropic passthrough
   - `custom-openai.ts` — from `handler.ts` OpenAI upstream
3. Handler dispatches to executor based on RouteDecision

```typescript
// routes/messages/handler.ts (after refactor)
export async function handleCompletion(c: Context) {
  // [1] Parse/Preprocess
  const { payload, rawModel, copilotModel, ... } = preprocess(c)
  
  // [2] Route Decision
  const decision = resolveExecutor("anthropic", rawModel, copilotModel)
  
  // [3] Execute (dispatch)
  switch (decision.kind) {
    case "copilot-native":
      return executeCopilotNative(c, payload, decision, ctx)
    case "copilot-translated":
      return executeCopilotTranslated(c, payload, decision, ctx)
    case "custom-anthropic":
      return executeCustomAnthropic(c, payload, decision, ctx)
    case "custom-openai":
      return executeCustomOpenAI(c, payload, decision, ctx)
  }
}
```

**Files:** `routes/messages/executors/*.ts` (new), `routes/messages/handler.ts`

### Phase 5: Transport Unification (Low-Medium risk)

**在 executor 边界稳定后**，收敛 transport 层：

1. Create `lib/transport.ts` with unified fetch wrapper
2. Each executor 提供 `buildUrl()`, `buildHeaders()`, `sanitizePayload()`
3. Transport 提供通用 `send()`, `handleError()`, `parseResponse()`

```typescript
// lib/transport.ts
interface TransportConfig {
  url: string
  headers: Record<string, string>
  body: unknown
  stream: boolean
  proxyUrl?: string
}

async function send(config: TransportConfig): Promise<Response> {
  const response = await fetch(config.url, {
    method: "POST",
    headers: config.headers,
    body: JSON.stringify(config.body),
    ...(config.proxyUrl ? { proxy: config.proxyUrl } : {}),
  })
  if (!response.ok) {
    throw await HTTPError.fromResponse("Upstream error", response)
  }
  return response
}
```

**Files:** `lib/transport.ts` (new), `services/upstream/*.ts`

### Phase 6: Stream Tools (Low risk)

**在 executor 内部**，提取可复用的 stream 工具（不是统一 runner）：

1. `lib/stream-pump.ts` — SSE event parsing
2. `lib/stream-metrics.ts` — metrics extraction helpers
3. `lib/stream-finalizer.ts` — request_end log generation

每个 executor 按需组合这些工具，而不是被迫用统一接口。

## Migration Strategy

- Phase 1-2: Pure infrastructure, no behavior change
- Phase 3-4: Core refactor, same tests must pass
- Phase 5-6: Internal cleanup, executor-specific

每个 phase 完成后运行完整测试套件验证。

## Testability Requirements

### 核心原则：关键逻辑 100% UT 覆盖

每个模块必须可独立单元测试，不依赖 HTTP 层或真实上游。

### Phase 1-2: 基础设施测试

| 模块 | 测试重点 | 覆盖要求 |
|------|----------|----------|
| `compileProvider()` | Pattern 解析正确性 | 100% |
| `resolveProvider()` | Exact match 优先于 glob | 100% |
| `createRoutes()` | Error wrapping 行为 | 100% |

```typescript
// test/lib/upstream-router.test.ts
describe("resolveProvider with compiled patterns", () => {
  test("exact match takes priority over glob", () => {
    state.providers = [
      compileProvider({ model_patterns: '["gpt-*"]', ... }),
      compileProvider({ model_patterns: '["gpt-4"]', ... }),
    ]
    const result = resolveProvider("gpt-4")
    expect(result?.matchedPattern).toBe("gpt-4") // exact, not glob
  })
})
```

### Phase 3-4: Route Decision + Executor 测试

| 模块 | 测试重点 | 覆盖要求 |
|------|----------|----------|
| `resolveExecutor()` | 所有 ExecutorKind 分支 | 100% |
| Capability matrix | 不支持组合的 reject | 100% |
| 每个 Executor | 独立的协议处理逻辑 | 90%+ |

**关键设计**：Executor 接收纯数据，不依赖 `Context`

```typescript
// routes/messages/executors/copilot-native.ts
export interface ExecutorInput {
  payload: AnthropicMessagesPayload
  copilotModel: string
  anthropicBeta: string | null
  serverToolContext: ServerToolContext
  requestId: string
}

export interface ExecutorOutput {
  response: AnthropicResponse | AsyncGenerator<ServerSentEvent>
  metrics: RequestMetrics
}

// 纯函数，可直接单元测试
export async function executeCopilotNative(
  input: ExecutorInput,
  // 依赖注入：transport 和 service 可 mock
  deps: {
    sendNativeMessages: typeof createNativeMessages
    executeServerTool?: ServerToolExecutorFn
  }
): Promise<ExecutorOutput> {
  // ...
}
```

```typescript
// test/routes/messages/executors/copilot-native.test.ts
describe("executeCopilotNative", () => {
  test("non-streaming returns AnthropicResponse", async () => {
    const mockSend = jest.fn().mockResolvedValue(mockResponse)
    
    const result = await executeCopilotNative(
      { payload: { stream: false, ... }, ... },
      { sendNativeMessages: mockSend }
    )
    
    expect(result.response).toEqual(mockResponse)
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ ... }))
  })
  
  test("effort fallback retries with lower effort", async () => {
    const mockSend = jest.fn()
      .mockRejectedValueOnce(effortError("max"))
      .mockResolvedValueOnce(mockResponse)
    
    const result = await executeCopilotNative(
      { payload: { output_config: { effort: "max" }, ... }, ... },
      { sendNativeMessages: mockSend }
    )
    
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(mockSend.mock.calls[1][0].output_config.effort).toBe("high")
  })
})
```

### Phase 5-6: Transport + Stream Tools 测试

| 模块 | 测试重点 | 覆盖要求 |
|------|----------|----------|
| `transport.send()` | Error handling, proxy config | 100% |
| `stream-pump` | SSE parsing edge cases | 100% |
| `stream-metrics` | Usage extraction per protocol | 100% |

### Handler 测试策略

Handler 只做 orchestration，测试重点是**正确调度**：

```typescript
// test/routes/messages/handler.test.ts
describe("handleCompletion orchestration", () => {
  test("Claude model routes to copilot-native executor", async () => {
    const mockExecutor = jest.fn().mockResolvedValue(mockOutput)
    
    // Inject executor
    const handler = createHandler({ executors: { "copilot-native": mockExecutor } })
    
    await handler(mockContext({ model: "claude-sonnet-4" }))
    
    expect(mockExecutor).toHaveBeenCalled()
  })
  
  test("custom Anthropic provider routes to custom-anthropic executor", async () => {
    state.providers = [compileProvider({ format: "anthropic", model_patterns: '["my-model"]' })]
    const mockExecutor = jest.fn().mockResolvedValue(mockOutput)
    
    const handler = createHandler({ executors: { "custom-anthropic": mockExecutor } })
    
    await handler(mockContext({ model: "my-model" }))
    
    expect(mockExecutor).toHaveBeenCalled()
  })
})
```

### Test Coverage Enforcement

```typescript
// package.json
{
  "scripts": {
    "test:cov": "bun test --coverage",
    "test:cov:check": "bun test --coverage && node scripts/check-coverage.ts"
  }
}

// 新增模块的覆盖率阈值
// scripts/check-coverage.ts
const CRITICAL_MODULES = {
  "lib/route-decision.ts": 100,
  "lib/upstream-router.ts": 100,
  "routes/messages/executors/*.ts": 90,
  "lib/transport.ts": 100,
}
```

### Integration Test Layer

E2E 测试保持现有覆盖，但核心逻辑不依赖 E2E 验证：

```
Unit Tests (100% 核心逻辑)
    ↓
Integration Tests (模块组合)
    ↓
E2E Tests (端到端验证)
```

## Success Metrics

1. **Handler LOC**: `handleCompletion()` 从 ~400 行降到 <100 行（纯 orchestration）
2. **Route decision isolation**: 路由逻辑集中在 `route-decision.ts`
3. **Executor independence**: 每个 executor 可独立测试
4. **No JSON.parse in hot path**: Provider patterns 编译时解析
5. **Consistent route style**: 所有 route.ts 用同一模式
