# 14 - Extended Thinking Support

## Overview

为 Raven 添加 Claude Extended Thinking (思考模式) 支持。需要区分 **三条独立路径**：

| 路径 | 入口 | 处理方式 |
|------|------|----------|
| **Anthropic Direct** | `provider.format === "anthropic"` | 原样透传，无需改动 |
| **OpenAI Upstream (reasoning capable)** | `provider.format === "openai"` + `provider.supports_reasoning === true` | 翻译为 `reasoning_effort` |
| **OpenAI Upstream (default)** | `provider.format === "openai"` + `supports_reasoning === false`（默认） | Drop + Warn |
| **Copilot (默认)** | 无 provider 匹配 | Drop + Warn，不发送 |

## 当前代码路径分析

```
handleCompletion()
├── resolveProvider(model) 匹配到 provider?
│   ├── provider.format === "anthropic"
│   │   └── handleAnthropicPassthrough()
│   │       └── sendAnthropicDirect(payload)  // ✅ 原样透传，thinking 已支持
│   │
│   └── provider.format === "openai"
│       ├── provider.supports_reasoning === true?
│       │   └── translateToOpenAI(payload, { targetFormat: "openai-reasoning" })
│       │       └── handleOpenAIUpstream()    // ✅ 翻译 thinking → reasoning_effort
│       │
│       └── supports_reasoning === false（默认）
│           └── translateToOpenAI(payload, { targetFormat: "openai" })
│               └── handleOpenAIUpstream()    // ⚠️ Drop thinking + warn
│
└── 无匹配 (默认 Copilot)
    └── translateToOpenAI(payload, { targetFormat: "copilot" })
        └── createChatCompletions()           // ⚠️ Drop thinking + warn
```

---

## 路径 A: Anthropic Direct — 无需改动

**现状**: `sendAnthropicDirect()` 已经将 `payload` 原样 `JSON.stringify()` 发送，包括 `thinking` 参数。流式响应也直接透传 SSE 事件。

**验证点**:
- `thinking` 参数透传 ✅
- `thinking_delta` / `signature_delta` 事件透传 ✅
- `thinking` / `redacted_thinking` content block 透传 ✅

**Action**: 无需代码改动，仅需添加测试覆盖。

---

## 路径 B: OpenAI Upstream (reasoning capable) — 翻译 `thinking` → `reasoning_effort`

**目标**: 对于显式声明 `supports_reasoning: true` 的 OpenAI-compatible provider，将 Anthropic `thinking` 参数翻译为 OpenAI `reasoning_effort`。

### B.0 Provider Capability 配置

**为什么需要显式开启**: OpenAI 官方 `reasoning_effort` 仅支持特定 reasoning 模型（o1, o3 等），并非所有 OpenAI-compatible upstream 都支持。按 `format === "openai"` 一刀切会导致部分 upstream 返回 4xx。

**粒度约束**: `supports_reasoning` 是 provider 级别开关，会对该 provider 下所有匹配的模型生效。由于 provider 可绑定多个 `model_patterns`（包括 glob），**只应对 reasoning-only provider 开启该开关**。

典型配置模式：
- ✅ 为 reasoning 模型创建独立 provider：`model_patterns: ["openai/o1", "openai/o3-mini"]` + `supports_reasoning: true`
- ❌ 不要在混合 provider 上开启：`model_patterns: ["openai/*"]` + `supports_reasoning: true` — 会导致 gpt-4o 等非 reasoning 模型收到 `reasoning_effort` 参数而报错

**未来演进**: 如需更细粒度控制，可将能力下沉到 model pattern 级别（如 `reasoning_patterns: ["o1*", "o3*"]`），但当前阶段 provider 级别足够覆盖主要用例。

**Provider 配置扩展**:

```typescript
// packages/proxy/src/db/providers.ts

/** Full DB row. */
export interface ProviderRecord {
  // ... existing fields ...
  supports_reasoning: number // 0 | 1, default 0
}

/** Public projection — masks api_key. */
export interface ProviderPublic {
  // ... existing fields ...
  supports_reasoning: boolean
}

/** Create input. */
export interface CreateProviderInput {
  // ... existing fields ...
  supports_reasoning?: boolean
}

/** Update input — all fields optional. */
export interface UpdateProviderInput {
  // ... existing fields ...
  supports_reasoning?: boolean
}
```

**DB Schema Migration** (幂等，接入 `initProviders()` 启动路径):

```typescript
// packages/proxy/src/db/providers.ts

// 1. 更新 CREATE_TABLE 包含新列（新数据库实例使用）
const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS providers (
  -- ... existing columns ...
  supports_reasoning INTEGER NOT NULL DEFAULT 0,
  -- ...
);
`

// 2. 更新 initProviders() 添加幂等迁移（已有数据库实例使用）
export function initProviders(db: Database): void {
  db.exec(CREATE_TABLE)
  
  // Migration: add supports_reasoning column (idempotent)
  const safeAddColumn = (sql: string) => {
    try { db.exec(sql) } catch (e) {
      if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e
    }
  }
  safeAddColumn("ALTER TABLE providers ADD COLUMN supports_reasoning INTEGER NOT NULL DEFAULT 0")
}
```

**注意**: 使用与 `packages/proxy/src/db/requests.ts:112-116` 相同的 `safeAddColumn()` 模式，确保：
1. 新数据库实例：`CREATE TABLE` 包含完整 schema
2. 已有数据库实例：`ALTER TABLE` 幂等添加列，现有记录默认值为 0

**API Validation** (`packages/proxy/src/routes/upstreams.ts`):

```typescript
const createProviderSchema = z.object({
  // ... existing fields ...
  supports_reasoning: z.boolean().optional().default(false),
})

const updateProviderSchema = z.object({
  // ... existing fields ...
  supports_reasoning: z.boolean().optional(),
})
```

**Dashboard Types** (`packages/dashboard/src/lib/types.ts`):

```typescript
export interface ProviderPublic {
  // ... existing fields ...
  supports_reasoning: boolean;
}

export interface CreateProviderInput {
  // ... existing fields ...
  supports_reasoning?: boolean;
}

export interface UpdateProviderInput {
  // ... existing fields ...
  supports_reasoning?: boolean;
}
```

**Dashboard UI** (`packages/dashboard/src/app/settings/upstreams/upstreams-content.tsx`):
- 每个 OpenAI-format provider 增加 "Supports Reasoning" toggle
- 仅当 `format === "openai"` 时显示该选项

**示例配置** (API payload):

```json
{
  "name": "openrouter-reasoning",
  "format": "openai",
  "base_url": "https://openrouter.ai/api/v1",
  "api_key": "sk-or-...",
  "model_patterns": ["openai/o1", "openai/o3-mini"],
  "supports_reasoning": true
}
```

### B.1 请求翻译

**映射规则** (参考 mai-agents):

| Anthropic `thinking.budget_tokens` | OpenAI `reasoning_effort` |
|-----------------------------------|---------------------------|
| `>= 10000` | `"high"` |
| `>= 5000` | `"medium"` |
| `>= 2000` | `"low"` |
| `< 2000` | `"minimal"` |
| `type: "disabled"` / 缺失 | 不发送 |

**实现位置**: `translateToOpenAI()` — 根据 `targetFormat` 决定行为

```typescript
// non-stream-translation.ts
type TargetFormat = "openai-reasoning" | "openai" | "copilot"

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
  options?: { targetFormat?: TargetFormat }
): ExtendedChatCompletionsPayload {
  // ... existing code ...

  // Thinking translation (only for reasoning-capable OpenAI upstreams)
  if (options?.targetFormat === "openai-reasoning" && payload.thinking?.type === "enabled") {
    const budget = payload.thinking.budget_tokens ?? 0
    if (budget >= 10000) {
      optional.reasoning_effort = "high"
    } else if (budget >= 5000) {
      optional.reasoning_effort = "medium"
    } else if (budget >= 2000) {
      optional.reasoning_effort = "low"
    } else {
      optional.reasoning_effort = "minimal"
    }
  }
  // For "openai" (non-reasoning) and "copilot": thinking is dropped

  return { ...base, ...optional, serverSideToolNames }
}
```

**调用点修改**:

```typescript
// handler.ts
if (provider.format === "openai") {
  const targetFormat = provider.supports_reasoning ? "openai-reasoning" : "openai"
  const openAIPayload = translateToOpenAI(anthropicPayload, { targetFormat })
  return handleOpenAIUpstream(...)
}

// Default Copilot path
const openAIPayload = translateToOpenAI(anthropicPayload, { targetFormat: "copilot" })
```

### B.2 类型扩展

```typescript
// create-chat-completions.ts
export interface ChatCompletionsPayload {
  // ... existing fields ...
  
  /**
   * Controls reasoning effort for o1/o3 style models.
   * See: https://platform.openai.com/docs/api-reference/chat/create
   */
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
}
```

**注意**: 使用完整的 OpenAI 官方枚举，而非仅映射 Anthropic 翻译会用到的子集。这确保 `ChatCompletionsPayload` 作为通用基础类型的正确性。

### B.3 响应翻译

如果 OpenAI upstream 返回 reasoning 内容（如 o1/o3 模型），需要翻译回 Anthropic `thinking` block。

**问题**: OpenAI reasoning 格式尚未标准化，且 Copilot API 目前不返回 reasoning。

**策略**: Phase 1 暂不实现响应翻译。当 upstream 支持后再添加。

---

## 路径 B': OpenAI Upstream (non-reasoning) — Drop + Warn

**目标**: 对于 `format === "openai"` 但未设置 `supports_reasoning: true` 的 provider，安全降级。

**行为**: 与 Copilot 路径相同 — drop `thinking` 参数并记录警告日志。

```typescript
// handler.ts
if (provider.format === "openai" && !provider.supports_reasoning) {
  if (anthropicPayload.thinking?.type === "enabled") {
    logEmitter.emitLog({
      ts: Date.now(),
      level: "warn",
      type: "request_start",
      requestId,
      msg: "thinking parameter dropped: provider does not declare supports_reasoning",
      data: { 
        provider: provider.name,
        budgetTokens: anthropicPayload.thinking.budget_tokens,
        hint: "Add supports_reasoning: true to provider config if upstream supports reasoning_effort"
      },
    })
  }
}
```

---

## 路径 C: Copilot (默认) — Drop + Warn

**目标**: GitHub Copilot API 不支持 `thinking`，需要优雅降级。

### C.1 Drop `thinking` 参数

`translateToOpenAI()` 默认（`targetFormat: "copilot"` 或未指定）不处理 `thinking`，参数自然被丢弃。

### C.2 Warn 日志

在 handler 中检测并记录警告：

```typescript
// handler.ts
// Default Copilot path
const openAIPayload = translateToOpenAI(anthropicPayload, { targetFormat: "copilot" })

// Warn if thinking was requested but dropped
if (anthropicPayload.thinking?.type === "enabled") {
  logEmitter.emitLog({
    ts: Date.now(),
    level: "warn",
    type: "request_start",
    requestId,
    msg: "thinking parameter dropped: Copilot does not support extended thinking",
    data: { 
      budgetTokens: anthropicPayload.thinking.budget_tokens,
      hint: "Configure an Anthropic provider to use thinking"
    },
  })
}
```

---

## 消息历史中的 Thinking Block 处理

### 问题分析

当消息历史包含之前的 thinking block 时：

1. **Anthropic Direct**: 透传，无问题
2. **OpenAI Upstream / Copilot**: 当前代码将 thinking 合并为文本

```typescript
// non-stream-translation.ts:237-245
const thinkingBlocks = message.content.filter(
  (block): block is AnthropicThinkingBlock => block.type === "thinking",
)
const allTextContent = [
  ...textBlocks.map((b) => b.text),
  ...thinkingBlocks.map((b) => b.thinking),  // 合并为文本
].join("\n\n")
```

### 策略选择

| 策略 | 描述 | 问题 |
|------|------|------|
| **保持现状** | 合并为文本 | signature 丢失，无法验证 |
| **完全丢弃** | 删除 thinking blocks | 上下文丢失 |
| **标记保留** | 添加 `[Thinking: ...]` 标记 | 可读性差 |

**推荐**: **保持现状 + 警告日志**

- 合并为文本是安全的降级行为
- signature 在 Copilot/OpenAI 路径无意义（上游不验证）
- 添加日志提示用户配置 Anthropic provider 以获得完整体验

---

## Implementation Plan

### 原子化提交策略

每个 commit 保持独立可测试，遵循项目 `rules/git-commit.md` 规范。

| # | Commit | 范围 | 测试要求 | 状态 |
|---|--------|------|----------|------|
| 1 | `feat(proxy): extend ChatCompletionsPayload with reasoning_effort type` | 类型扩展 | 类型检查通过 | ✅ |
| 2 | `feat(proxy): add supports_reasoning field to provider schema` | DB types + schema + migration + CRUD | 单元测试：CRUD 操作正确读写新字段 | ✅ |
| 3 | `feat(proxy): add supports_reasoning to upstreams API validation` | zod schemas | 单元测试：API 校验接受/拒绝正确 | ✅ |
| 4 | `feat(dashboard): add supports_reasoning to provider types` | frontend types | 类型检查通过 | ✅ |
| 5 | `feat(dashboard): add Supports Reasoning toggle to upstreams form` | UI toggle | Playwright：toggle 可见性、状态同步 | ✅ |
| 6 | `feat(proxy): add targetFormat option to translateToOpenAI` | 函数签名扩展 | 单元测试：现有行为不变 | ✅ |
| 7 | `feat(proxy): translate thinking to reasoning_effort for reasoning providers` | budget_tokens 映射 | 单元测试：4 档映射 + 边界值 | ✅ |
| 8 | `feat(proxy): drop thinking param for copilot path with warning` | Copilot 降级逻辑 | 单元测试：thinking 被 drop + 日志断言 | ✅ |
| 9 | `feat(proxy): drop thinking for non-reasoning openai providers` | OpenAI 降级逻辑 | 单元测试：supports_reasoning=false 时 drop | ✅ |
| 10 | `test(proxy): add thinking support handler integration tests` | 集成测试 | handler 分支选择 + upstream body 验证 | ✅ (merged into #7-9) |

### Phase 1: 类型扩展 (前置依赖)

**Commit**: #1

**Commit 1 — Type Extension** (`packages/proxy/src/services/copilot/create-chat-completions.ts`):

```typescript
reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
```

**验证**: `bun run typecheck` 通过

**为什么先做类型**: 后续 Commit #7 需要给 `optional.reasoning_effort` 赋值，必须先扩展 `ChatCompletionsPayload` 类型。

### Phase 2: Provider Capability 配置

**Commits**: #2, #3, #4, #5

**Commit 2 — DB Schema** (`packages/proxy/src/db/providers.ts`):

```typescript
// 1. 更新 ProviderRecord/ProviderPublic/CreateProviderInput/UpdateProviderInput
// 2. 更新 CREATE_TABLE 包含 supports_reasoning 列
// 3. 更新 initProviders() 添加 safeAddColumn migration
// 4. 更新 toPublic() 映射 0/1 → boolean
// 5. 更新 createProvider/updateProvider 处理新字段
```

**测试文件**: `packages/proxy/test/db/providers.test.ts`（扩展现有）

```typescript
describe("providers CRUD", () => {
  it("createProvider defaults supports_reasoning to false", () => {
    const p = createProvider(db, { name: "test", ... })
    expect(p.supports_reasoning).toBe(false)
  })

  it("createProvider accepts supports_reasoning: true", () => {
    const p = createProvider(db, { ..., supports_reasoning: true })
    expect(p.supports_reasoning).toBe(true)
  })

  it("updateProvider can toggle supports_reasoning", () => {
    const p1 = createProvider(db, { ... })
    const p2 = updateProvider(db, p1.id, { supports_reasoning: true })
    expect(p2.supports_reasoning).toBe(true)
  })

  it("migration adds column to existing table without error", () => {
    // 模拟旧表结构，调用 initProviders，验证 safeAddColumn 幂等
  })
})
```

**Commit 3 — API Validation** (`packages/proxy/src/routes/upstreams.ts`):

```typescript
// 更新 createProviderSchema 和 updateProviderSchema
```

**测试文件**: `packages/proxy/test/routes/upstreams.test.ts`（扩展现有）

```typescript
describe("POST /upstreams", () => {
  it("accepts payload with supports_reasoning: true", async () => { ... })
  it("accepts payload without supports_reasoning (defaults false)", async () => { ... })
  it("rejects supports_reasoning with non-boolean value", async () => { ... })
})

describe("PUT /upstreams/:id", () => {
  it("can update supports_reasoning field", async () => { ... })
})
```

**Commit 4 — Dashboard Types** (`packages/dashboard/src/lib/types.ts`):

```typescript
// 同步更新 ProviderPublic/CreateProviderInput/UpdateProviderInput
```

**验证**: `bun run typecheck` 通过

**Commit 5 — Dashboard UI** (`packages/dashboard/src/app/settings/upstreams/upstreams-content.tsx`):

```typescript
// 添加 "Supports Reasoning" Switch，仅 format === "openai" 时显示
```

**测试文件**: `packages/dashboard/e2e/upstreams.spec.ts`（Playwright）

```typescript
test("supports reasoning toggle visible only for openai format", async ({ page }) => {
  // 1. 创建 openai format provider → toggle 可见
  // 2. 创建 anthropic format provider → toggle 不可见
})

test("supports reasoning toggle persists state", async ({ page }) => {
  // 1. 创建 provider with toggle on
  // 2. 刷新页面
  // 3. 验证 toggle 仍为 on
})
```

### Phase 3: 路径分离 + 翻译逻辑

**Commits**: #6, #7

**Commit 6 — targetFormat Option** (`packages/proxy/src/routes/messages/non-stream-translation.ts`):

```typescript
type TargetFormat = "openai-reasoning" | "openai" | "copilot"

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
  options?: { targetFormat?: TargetFormat }
): ExtendedChatCompletionsPayload
```

**测试**: 现有 `packages/proxy/test/translate/anthropic-to-openai.test.ts` 全部通过（行为不变）

**Commit 7 — budget_tokens Mapping + targetFormat Dispatch**:

**测试文件**: `packages/proxy/test/translate/thinking.test.ts`（新建）

```typescript
import { describe, expect, test } from "bun:test"
import { translateToOpenAI } from "../../src/routes/messages/non-stream-translation"

describe("thinking support - translateToOpenAI", () => {
  describe("targetFormat: openai-reasoning", () => {
    describe("budget_tokens to reasoning_effort mapping", () => {
      test("maps budget_tokens to correct reasoning_effort values", () => {
        const cases = [
          { budget: 10000, expected: "high" },
          { budget: 15000, expected: "high" },
          { budget: 5000, expected: "medium" },
          { budget: 9999, expected: "medium" },
          { budget: 2000, expected: "low" },
          { budget: 4999, expected: "low" },
          { budget: 1999, expected: "minimal" },
          { budget: 1000, expected: "minimal" },
          { budget: 0, expected: "minimal" },
        ]

        for (const { budget, expected } of cases) {
          const input = {
            model: "o1",
            max_tokens: 1024,
            messages: [{ role: "user", content: "Hello" }],
            thinking: { type: "enabled", budget_tokens: budget },
          }
          const output = translateToOpenAI(input, { targetFormat: "openai-reasoning" })
          expect(output.reasoning_effort).toBe(expected)
        }
      })
    })

    test("does not set reasoning_effort when thinking.type is disabled", () => { ... })
    test("does not set reasoning_effort when thinking is absent", () => { ... })
  })

  describe("targetFormat: openai (non-reasoning)", () => {
    test("drops thinking param, reasoning_effort is undefined", () => {
      const input = {
        model: "gpt-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
        thinking: { type: "enabled", budget_tokens: 5000 },
      }
      const output = translateToOpenAI(input, { targetFormat: "openai" })
      expect(output.reasoning_effort).toBeUndefined()
    })
  })

  describe("targetFormat: copilot", () => {
    test("drops thinking param, reasoning_effort is undefined", () => {
      const input = {
        model: "gpt-4",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
        thinking: { type: "enabled", budget_tokens: 5000 },
      }
      const output = translateToOpenAI(input, { targetFormat: "copilot" })
      expect(output.reasoning_effort).toBeUndefined()
    })
  })
})
```

### Phase 4: Handler 日志 + 路径分发

**Commits**: #8, #9

**Commit 8 — Copilot Drop** (`packages/proxy/src/routes/messages/handler.ts`):

**测试文件**: `packages/proxy/test/routes/messages-handler-thinking.test.ts`（新建）

```typescript
import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { logEmitter } from "../../src/util/log-emitter"

describe("thinking support - handler Copilot path", () => {
  test("logs warning when thinking is dropped", async () => {
    const logSpy = spyOn(logEmitter, "emitLog")
    // ... invoke handler with no provider match ...
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      msg: expect.stringContaining("thinking parameter dropped"),
      data: expect.objectContaining({ hint: expect.stringContaining("Anthropic provider") }),
    }))
  })

  test("does not log when thinking is absent", async () => { ... })
  test("does not log when thinking.type is disabled", async () => { ... })
})
```

**Commit 9 — OpenAI Non-reasoning Drop**:

```typescript
describe("thinking support - handler OpenAI non-reasoning path", () => {
  test("logs warning with provider name when supports_reasoning is false", async () => {
    const logSpy = spyOn(logEmitter, "emitLog")
    // ... invoke handler with provider { format: "openai", supports_reasoning: false } ...
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      data: expect.objectContaining({ provider: "test-provider" }),
    }))
  })
})
```

### Phase 5: Handler 集成测试

**Commit**: #10

**测试文件**: `packages/proxy/test/routes/messages-handler-thinking.integration.test.ts`（新建）

这是最关键的测试层，验证 handler.ts 正确根据 provider/capability 选择 targetFormat 并发送正确的 upstream body。

采用与 `messages-handler-upstream.test.ts` 相同的测试模式：设置 `state.providers` + `spyOn(globalThis, "fetch")` 断言真正发出的 upstream request。

```typescript
import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { Hono } from "hono"
import { handleCompletion } from "../../src/routes/messages/handler"
import { state } from "../../src/lib/state"
import { logEmitter } from "../../src/util/log-emitter"
import type { ProviderRecord } from "../../src/db/providers"

// ===========================================================================
// Helpers (同 messages-handler-upstream.test.ts)
// ===========================================================================

function makeApp(): Hono {
  const app = new Hono()
  app.post("/v1/messages", handleCompletion)
  return app
}

function req(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function mockFetchJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function makeOpenAIResponse() {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1234567890,
    model: "o1",
    choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

function makeAnthropicResponse() {
  return {
    id: "msg-1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hi!" }],
    model: "claude-3-5-sonnet-20241022",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  }
}

// ===========================================================================
// Setup / teardown
// ===========================================================================

const savedProviders = state.providers
const savedModels = state.models
const savedToken = state.copilotToken
let fetchSpy: ReturnType<typeof spyOn>
let logSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  state.models = null
  state.copilotToken = "test-token"
  fetchSpy = spyOn(globalThis, "fetch")
  logSpy = spyOn(logEmitter, "emitLog")
})

afterEach(() => {
  state.providers = savedProviders
  state.models = savedModels
  state.copilotToken = savedToken
  fetchSpy.mockRestore()
  logSpy.mockRestore()
})

// ===========================================================================
// Tests
// ===========================================================================

describe("thinking support - handler integration", () => {
  const basePayload = {
    model: "o1",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
  }

  describe("provider.format === openai && supports_reasoning === true", () => {
    beforeEach(() => {
      state.providers = [{
        id: "p1",
        name: "OpenAI-Reasoning",
        base_url: "https://openai.example.com",
        format: "openai",
        api_key: "test-key",
        model_patterns: '["o1*"]',
        enabled: 1,
        supports_reasoning: 1,
        created_at: 1,
        updated_at: 1,
      }]
    })

    test("sends reasoning_effort to upstream", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

      const app = makeApp()
      await app.request(req({
        ...basePayload,
        thinking: { type: "enabled", budget_tokens: 10000 },
      }))

      // 断言真正发出的 fetch 请求
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe("https://openai.example.com/v1/chat/completions")

      const body = JSON.parse(init.body as string)
      expect(body.reasoning_effort).toBe("high")
    })

    test("does not produce warning log", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

      const app = makeApp()
      await app.request(req({
        ...basePayload,
        thinking: { type: "enabled", budget_tokens: 10000 },
      }))

      expect(logSpy).not.toHaveBeenCalledWith(expect.objectContaining({ level: "warn" }))
    })
  })

  describe("provider.format === openai && supports_reasoning === false", () => {
    beforeEach(() => {
      state.providers = [{
        id: "p1",
        name: "OpenAI-NoReasoning",
        base_url: "https://openai.example.com",
        format: "openai",
        api_key: "test-key",
        model_patterns: '["o1*"]',
        enabled: 1,
        supports_reasoning: 0,  // false
        created_at: 1,
        updated_at: 1,
      }]
    })

    test("does NOT send reasoning_effort to upstream", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

      const app = makeApp()
      await app.request(req({
        ...basePayload,
        thinking: { type: "enabled", budget_tokens: 10000 },
      }))

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string)
      expect(body.reasoning_effort).toBeUndefined()
    })

    test("produces warning log with provider name", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

      const app = makeApp()
      await app.request(req({
        ...basePayload,
        thinking: { type: "enabled", budget_tokens: 5000 },
      }))

      expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
        level: "warn",
        msg: expect.stringContaining("does not declare supports_reasoning"),
        data: expect.objectContaining({ provider: "OpenAI-NoReasoning", budgetTokens: 5000 }),
      }))
    })
  })

  describe("no provider match (Copilot fallback)", () => {
    beforeEach(() => {
      state.providers = []  // no providers
    })

    test("does NOT send reasoning_effort to Copilot upstream", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

      const app = makeApp()
      await app.request(req({
        ...basePayload,
        model: "gpt-4o",  // no provider match
        thinking: { type: "enabled", budget_tokens: 10000 },
      }))

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string)
      expect(body.reasoning_effort).toBeUndefined()
    })

    test("produces warning log suggesting Anthropic provider", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

      const app = makeApp()
      await app.request(req({
        ...basePayload,
        model: "gpt-4o",
        thinking: { type: "enabled", budget_tokens: 5000 },
      }))

      expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
        level: "warn",
        msg: expect.stringContaining("Copilot does not support"),
        data: expect.objectContaining({ hint: expect.stringContaining("Anthropic provider") }),
      }))
    })
  })

  describe("provider.format === anthropic (passthrough)", () => {
    beforeEach(() => {
      state.providers = [{
        id: "p1",
        name: "AnthropicProvider",
        base_url: "https://anthropic.example.com",
        format: "anthropic",
        api_key: "test-key",
        model_patterns: '["claude-*"]',
        enabled: 1,
        supports_reasoning: 0,
        created_at: 1,
        updated_at: 1,
      }]
    })

    test("sends thinking param unchanged to Anthropic upstream", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeAnthropicResponse()))

      const app = makeApp()
      await app.request(req({
        ...basePayload,
        model: "claude-3-5-sonnet-20241022",
        thinking: { type: "enabled", budget_tokens: 10000 },
      }))

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe("https://anthropic.example.com/v1/messages")

      const body = JSON.parse(init.body as string)
      expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10000 })
    })

    test("does not produce warning log", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeAnthropicResponse()))

      const app = makeApp()
      await app.request(req({
        ...basePayload,
        model: "claude-3-5-sonnet-20241022",
        thinking: { type: "enabled", budget_tokens: 10000 },
      }))

      expect(logSpy).not.toHaveBeenCalledWith(expect.objectContaining({ level: "warn" }))
    })
  })

  describe("message history with thinking blocks", () => {
    beforeEach(() => {
      state.providers = []  // Copilot path
    })

    test("merges thinking blocks to text for Copilot path", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchJson(makeOpenAIResponse()))

      const app = makeApp()
      await app.request(req({
        ...basePayload,
        model: "gpt-4o",
        messages: [
          { role: "user", content: "Hi" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Let me think..." },
              { type: "text", text: "Here is my answer" },
            ],
          },
        ],
      }))

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string)
      
      // OpenAI format: assistant message content is a string
      const assistantMsg = body.messages.find((m: { role: string }) => m.role === "assistant")
      expect(assistantMsg.content).toContain("Let me think...")
      expect(assistantMsg.content).toContain("Here is my answer")
    })
  })
})
```

### Phase 6 (Future): 响应 Reasoning 翻译

当 Copilot/OpenAI 支持返回 reasoning 内容后，实现响应翻译。需要：
- 定义 upstream reasoning 字段规范
- 翻译为 Anthropic `thinking_delta` / `thinking` block
- 处理 signature（如果 upstream 提供）

---

## 测试覆盖总结

| 层级 | 测试类型 | 文件 | 覆盖内容 |
|------|----------|------|----------|
| L1 | 单元测试 | `packages/proxy/test/db/providers.test.ts` | CRUD + migration 幂等 |
| L1 | 单元测试 | `packages/proxy/test/routes/upstreams.test.ts` | API validation |
| L1 | 单元测试 | `packages/proxy/test/translate/thinking.test.ts` | translateToOpenAI 三种 targetFormat |
| L1 | 单元测试 | `packages/proxy/test/routes/messages-handler-thinking.test.ts` | handler 日志逻辑 |
| L1 | 集成测试 | `packages/proxy/test/routes/messages-handler-thinking.integration.test.ts` | **handler 分支选择 + upstream body 验证** |
| L3 | Playwright | `packages/dashboard/e2e/upstreams.spec.ts` | UI toggle 行为 |
| G1 | 类型检查 | `bun run typecheck` | 前后端类型同步 |

**关键覆盖点**: 集成测试 `messages-handler-thinking.integration.test.ts` 验证：
1. `supports_reasoning === true` 时 upstream body 包含 `reasoning_effort`
2. `supports_reasoning === false` 时 upstream body 不包含 `reasoning_effort` 且产生日志
3. 无 provider 命中走 Copilot 时不发送 `reasoning_effort`
4. Anthropic passthrough 时 `thinking` 原样透传

**覆盖率目标**: 新增代码 90%+，与项目现有标准一致。

---

## Configuration

| 配置项 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| `OPT_THINKING_LOG_DROPPED` | boolean | `true` | 是否记录 thinking 被 drop 的警告 |

**注意**: 不需要 "是否传递 thinking" 的开关，因为行为由 provider format 决定。

---

## 不在范围内

以下明确不在本设计范围：

1. **Anthropic Direct SSE 解析**: 已经工作，无需改动
2. **响应 thinking block 生成**: Copilot 不返回，OpenAI 格式未定
3. **Signature 存储/验证**: Copilot/OpenAI 路径无意义
4. **消息历史 thinking block 精确保留**: 合并为文本是可接受的降级

---

## References

- [Anthropic Extended Thinking Docs](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- [OpenAI Reasoning Effort](https://platform.openai.com/docs/guides/reasoning)
- mai-agents `translate_anthropic_thinking_to_reasoning_effort()` 实现
