# 18 - Native Anthropic Messages Passthrough

## Overview

Copilot API 原生支持 `/v1/messages` endpoint（Anthropic 协议），当前 Raven 对所有 Claude 模型都走翻译路径（Anthropic → OpenAI `/chat/completions`）。本文档描述将 Claude 模型默认切换为原生 `/v1/messages` 透传的方案。

## Background

### 当前架构

```
Client (Anthropic format)
    ↓
Raven /v1/messages
    ↓
translateToOpenAI()          ← 翻译为 OpenAI 格式
    ↓
Copilot /chat/completions    ← OpenAI 协议
    ↓
translateToAnthropic()       ← 翻译回 Anthropic 格式
    ↓
Client
```

**问题**：
1. 翻译过程丢失 Anthropic 特有功能（`output_config`, `thinking` 原生支持等）
2. 双向翻译增加延迟和复杂度
3. 无法利用 Copilot 对 Claude 的原生优化
4. Server-side tools 拦截逻辑与 OpenAI 翻译紧耦合

### 发现

通过直接查询 Copilot `/models` endpoint，确认：

```json
{
  "id": "claude-opus-4.7",
  "supported_endpoints": ["/v1/messages", "/chat/completions"],
  "capabilities": {
    "supports": {
      "reasoning_effort": ["medium"],
      "adaptive_thinking": true,
      "max_thinking_budget": 32000
    }
  }
}
```

**所有 Claude 模型都支持原生 `/v1/messages`**：
- `claude-opus-4.5` / `4.6` / `4.6-1m` / `4.7`
- `claude-sonnet-4` / `4.5` / `4.6`
- `claude-haiku-4.5`

## Design — First Principles Refactor

### 核心原则

1. **单一数据格式原则**：Anthropic 请求应尽量保持 Anthropic 格式，只在必要时翻译
2. **早期拦截原则**：Server-side tools 在 Anthropic payload 阶段处理，无需依赖翻译
3. **模块可测试原则**：每个处理阶段独立，可单独 mock 和测试

### 目标架构

```
Client (Anthropic format)
    ↓
Raven /v1/messages
    ↓
[1] Preprocessing: auth, rate limit, logging
    ↓
[2] Server-side Tool Detection (Anthropic payload)  ← 🆕 提前到翻译之前
    ↓
[3] Route Decision
    ├── Claude model + Copilot → Native Passthrough    ← 🆕 新路径
    ├── Claude model + Custom Anthropic Provider → Passthrough (已有)
    ├── Other model → Translate + OpenAI path (已有)
    └── Custom OpenAI Provider → Translate + Forward (已有)
    ↓
[4] Postprocessing: logging, metrics
    ↓
Client
```

### 简化后的模块划分

| 模块 | 职责 | 输入 | 输出 |
|------|------|------|------|
| `preprocessPayload()` | 模型名规范化、beta header 解析、字段清洗 | AnthropicPayload | PreprocessedRequest |
| `detectServerTools()` | 检测 server-side tools | CleanedPayload | ServerToolContext |
| `routeRequest()` | 决定走哪条路径 | rawModel, copilotModel | RouteDecision |
| `sendNativeMessages()` | Copilot `/v1/messages` 透传 | CleanedPayload, copilotModel | Response |
| `sendTranslatedRequest()` | 翻译 + `/chat/completions` | CleanedPayload, copilotModel | Response |
| `handleServerToolLoop()` | Tavily 等 server-side tool 拦截 | CleanedPayload, sendFn | Response |

**关键变化**：`handleServerToolLoop()` 现在接收一个 `sendFn` 参数，而不是硬编码调用 `createChatCompletions()`。这使得它可以同时支持：
- 原生路径：`sendFn = sendNativeMessages`
- 翻译路径：`sendFn = sendTranslatedRequest`

### 路由决策

**⚠️ 关键：区分 rawModel 和 copilotModel**

模型名存在两种用途，不能混用：
- **rawModel**：客户端传入的原始模型名，用于 provider 路由和 Anthropic passthrough
- **copilotModel**：规范化后的模型名，仅用于 Copilot 路由和发送

```typescript
// preprocessPayload() 输出
interface PreprocessedRequest {
  payload: AnthropicMessagesPayload      // 清洗后的 payload（保留 rawModel）
  rawModel: string                        // 原始模型名，用于 provider 匹配
  copilotModel: string                    // 规范化后，仅用于 Copilot
  anthropicBeta: string | null           // 过滤后的 beta header
  serverToolContext: ServerToolContext   // server-side tool 检测结果
}

function preprocessPayload(
  rawPayload: AnthropicMessagesPayload,
  rawBeta: string | null,
): PreprocessedRequest {
  const rawModel = rawPayload.model
  
  // 1. Copilot 模型名规范化（仅用于 Copilot 路径）
  const copilotModel = translateModelName(rawModel, rawBeta)
  
  // 2. Beta header 过滤
  const anthropicBeta = filterAnthropicBeta(rawBeta)
  
  // 3. Payload 清洗（移除 service_tier 等不支持字段，保留原始 model）
  const payload = sanitizePayload(rawPayload)
  
  // 4. Server-side tool 检测（在翻译之前！）
  const serverToolContext = detectServerTools(payload)
  
  return { payload, rawModel, copilotModel, anthropicBeta, serverToolContext }
}
```

转换示例（仅影响 Copilot 路径）：
- `claude-opus-4-6-20250820` → `claude-opus-4.6`
- `claude-opus-4-6` + `anthropic-beta: context-1m-*` → `claude-opus-4.6-1m`
- `claude-opus-4-6[1m]` → `claude-opus-4.6-1m`

```
handleCompletion()
├── preprocessPayload() → { payload, rawModel, copilotModel, serverToolContext }
│
├── resolveProvider(rawModel) 匹配到 provider?  ← 用 rawModel 匹配！
│   ├── provider.format === "anthropic"
│   │   └── handleAnthropicPassthrough(payload)  ← payload 保留原始 model
│   └── provider.format === "openai"
│       └── handleOpenAIUpstream()               // 已有：翻译路径
│
└── 无匹配 (默认 Copilot)
    ├── supportsNativeMessages(copilotModel)?    ← 用 copilotModel 判断！
    │   └── handleCopilotNative(payload, copilotModel)  ← 发送时用 copilotModel
    └── 其他模型
        └── handleCopilotTranslated(payload, copilotModel)
```

**注意**：
- `resolveProvider()` 必须用 `rawModel`，否则自定义 Anthropic provider 的 `model_patterns` 会失配
- Anthropic passthrough 必须保留原始 `payload.model`，因为上游期望的模型名可能与 Copilot 不同
- 只有 Copilot 路径使用 `copilotModel`

### Server-side Tools — 统一拦截层

**🆕 关键重构**：将 server-side tools 拦截从 OpenAI payload 层提升到 Anthropic payload 层。

```typescript
// 通用的 server-side tool 拦截，与底层传输协议无关
async function withServerToolInterception<T>(
  payload: AnthropicMessagesPayload,
  serverToolContext: ServerToolContext,
  sendRequest: (p: AnthropicMessagesPayload) => Promise<T>,
  requestId: string,
): Promise<T | AnthropicResponse> {
  if (!serverToolContext.hasServerSideTools) {
    return sendRequest(payload)
  }
  
  // Pure mode: 所有 tools 都是 server-side
  if (serverToolContext.allServerSide) {
    return handlePureServerSideTools(payload, serverToolContext, requestId)
  }
  
  // Mixed mode: 过滤 server-side tools，循环拦截
  return handleMixedServerTools(payload, serverToolContext, sendRequest, requestId)
}
```

**优势**：
1. 原生路径和翻译路径共享同一套拦截逻辑
2. `sendRequest` 参数注入使得单元测试可以 mock
3. Server-side tool 逻辑与协议翻译完全解耦

### 核心组件

#### 1. Model Capability Cache

扩展 `services/copilot/get-models.ts` 中的类型定义（`state.models` 自动继承）：

```typescript
// services/copilot/get-models.ts
interface ModelSupports {
  tool_calls: boolean | null
  parallel_tool_calls: boolean | null
  dimensions: boolean | null
  // 🆕 新增
  reasoning_effort?: string[]
  adaptive_thinking?: boolean
  max_thinking_budget?: number
}

export interface Model {
  // ... existing fields ...
  supported_endpoints?: string[]  // 🆕 新增
}
```

#### 2. Native Messages Service

新建 `services/copilot/create-native-messages.ts`:

```typescript
export async function createNativeMessages(
  payload: AnthropicMessagesPayload,
): Promise<AnthropicResponse | AsyncGenerator<ServerSentEvent>>
```

功能：
- 构建 Copilot 认证 headers（复用 `copilotHeaders()`）
- SOCKS5 代理支持（复用 `getProxyUrl()`）
- 请求发送到 `${copilotBaseUrl}/v1/messages`
- 流式响应返回 SSE generator
- 非流式响应返回 `AnthropicResponse`

#### 3. Reasoning Effort Fallback

Copilot 对不同模型支持的 `reasoning_effort` 值不同：

| Model | Supported Efforts |
|-------|-------------------|
| claude-opus-4.7 | `["medium"]` |
| claude-opus-4.6 | TBD |
| claude-sonnet-* | TBD |

当请求的 `output_config.effort` 不被支持时，Copilot 返回：

```json
{
  "error": {
    "message": "output_config.effort \"xhigh\" is not supported by model claude-opus-4.7; supported values: [medium]",
    "code": "invalid_reasoning_effort"
  }
}
```

**Fallback 策略**：
1. 检测 `invalid_reasoning_effort` 错误
2. 解析 `supported values: [...]` 列表
3. 选择最接近的支持值（向下取最近）
4. 自动重试请求
5. 日志记录降级事件

Effort 优先级排序：`max` > `xhigh` > `high` > `medium` > `low`

#### 4. Beta Header Filtering

Copilot 不支持所有 Anthropic beta features。需要过滤 `anthropic-beta` header：

```typescript
const ALLOWED_BETAS = new Set([
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "advanced-tool-use-2025-11-20",
])

function filterAnthropicBeta(header: string | undefined): string | undefined {
  if (!header) return undefined
  const filtered = header.split(",")
    .map(s => s.trim())
    .filter(s => ALLOWED_BETAS.has(s))
  return filtered.length > 0 ? filtered.join(",") : undefined
}
```

**注意**：`context-1m-*` beta 需要特殊处理 — 模型名需要显式使用 `-1m` 后缀。

### 保留功能清单

| 功能 | 保留方式 |
|------|----------|
| API Key 认证 | Middleware 层处理 |
| Rate Limiting | `checkRateLimit()` |
| Request Logging | `logEmitter.emitLog()` |
| SOCKS5 Proxy | `getProxyUrl("copilot", state)` |
| Request/Response Metrics | DB 写入 |
| Server-side Tools (Tavily) | 统一拦截层（见上文 `withServerToolInterception`） |
| Token Counting | `/v1/messages/count_tokens` 独立 |

### 翻译层保留策略

翻译层（`translateToOpenAI()` / `translateToAnthropic()`）**保留**，用于：
1. 非 Claude 模型走 Copilot `/chat/completions`
2. 自定义 OpenAI 格式 providers
3. 未来可能的 OpenAI-native 上游

**删除**翻译层中的 server-side tool 检测逻辑（`serverSideToolNames`），因为已提前到 Anthropic payload 层处理。

### 不透传的字段

以下字段在透传前需要处理：

| 字段 | 处理 |
|------|------|
| `anthropic-beta` header | 过滤为 `ALLOWED_BETAS` 子集 |
| `service_tier` | 移除（Copilot 不支持） |

### `/v1/models` API 字段扩展

当前 Raven 的 `/v1/models` 返回简化的 `ModelEntry` 格式，丢失了关键字段。**注意**：不能直接透传 Copilot 原始对象，因为：

1. 现有 `/v1/models` 返回统一的 `ModelEntry` 视图，包含 `display_name`, `context_length`, `max_completion_tokens`
2. 需要合并 Copilot 模型与自定义 provider 模型（去重）
3. provider-only 模型没有 `supported_endpoints` 等字段

**修改方案**：扩展 `ModelEntry` 类型，添加可选字段，而非直接透传

| 字段 | Copilot 原始值 | 当前 ModelEntry | 新增 |
|------|----------------|-----------------|------|
| `id` | ✅ | ✅ | - |
| `display_name` | (从 `name`) | ✅ | - |
| `owned_by` | (从 `vendor`) | ✅ | - |
| `context_length` | (从 `capabilities.limits`) | ✅ | - |
| `max_completion_tokens` | (从 `capabilities.limits`) | ✅ | - |
| `supported_endpoints` | `["/v1/messages", "/chat/completions"]` | ❌ | ✅ 新增 |
| `capabilities` | 完整对象 | ❌ | ✅ 新增（可选） |

```typescript
// routes/models/route.ts - 扩展 ModelEntry
interface ModelEntry {
  id: string
  object: string
  type: string
  created: number
  created_at: string
  owned_by: string
  display_name: string
  context_length?: number | null
  max_completion_tokens?: number | null
  // 🆕 新增字段（Copilot 模型有值，provider 模型为 undefined）
  supported_endpoints?: string[]
  capabilities?: {
    supports?: {
      reasoning_effort?: string[]
      adaptive_thinking?: boolean
      max_thinking_budget?: number
    }
    limits?: {
      max_context_window_tokens?: number
      max_output_tokens?: number
    }
  }
}
```

**兼容性**：新增字段为可选，现有客户端无需修改。Provider 模型不会有这些字段。

### `output_config.effort` 处理

Copilot 对不同模型支持的 `reasoning_effort` 值不同。当客户端请求的 effort 不被支持时，需要自动降级：

**Effort 优先级**（从高到低）：`max` > `xhigh` > `high` > `medium` > `low`

**降级策略**：

```typescript
function pickSupportedEffort(
  requested: string,
  supported: string[]
): string | null {
  const priority = ["max", "xhigh", "high", "medium", "low"]
  const requestedIndex = priority.indexOf(requested)
  
  // 从请求的 effort 开始，向低优先级方向查找第一个支持的值
  for (let i = requestedIndex; i < priority.length; i++) {
    if (supported.includes(priority[i])) {
      return priority[i]
    }
  }
  
  // 如果都不支持，返回 null（移除 output_config）
  return null
}
```

**错误处理流程**：

1. 发送原始请求到 Copilot `/v1/messages`
2. 如果返回 `invalid_reasoning_effort` 错误：
   - 解析错误消息中的 `supported values: [...]`
   - 调用 `pickSupportedEffort()` 选择降级值
   - 修改 `output_config.effort` 或移除整个 `output_config`
   - 自动重试请求
3. 记录降级日志：`logger.warn("Reasoning effort downgraded", { from, to, model })`

**Dashboard 集成**：

`/v1/models` 扩展后，这些字段可供后续 Dashboard 展示使用（本次重构不包含 Dashboard UI 改动）。

## Implementation Plan

### Phase 1: Preprocessing Layer

1. **提取 `preprocessPayload()` 函数**
   - 从 `handler.ts` 抽取模型名规范化、beta header 过滤
   - 新建 `routes/messages/preprocess.ts`
   - 单元测试：各种模型名变体、beta header 组合

2. **Models API 字段扩展**
   - `services/copilot/get-models.ts`: 扩展类型定义
   - `routes/models/route.ts`: 映射新增字段
   - 单元测试：验证字段透传

### Phase 2: Server-side Tools Refactor

3. **统一拦截层**
   - 新建 `routes/messages/server-tools.ts`
   - 实现 `detectServerTools()` + `withServerToolInterception()`
   - 从 `handler.ts` 迁移现有逻辑，改为操作 Anthropic payload
   - 单元测试：pure mode、mixed mode、无 server-side tools

4. **翻译层清理**
   - 删除 `translateToOpenAI()` 中的 `serverSideToolNames` 逻辑
   - 简化 `ExtendedChatCompletionsPayload` 类型

### Phase 3: Native Messages Path

5. **Native Messages Service**
   - 新建 `services/copilot/create-native-messages.ts`
   - 单元测试（mock HTTP）

6. **Handler 集成**
   - 新建 `handleCopilotNative()` 
   - 路由判断：`supportsNativeMessages(canonicalModel)`
   - 日志集成

### Phase 4: Reasoning Effort Fallback

7. **类型定义**
   - `anthropic-types.ts`: 添加 `output_config` 字段到 `AnthropicMessagesPayload`
   ```typescript
   output_config?: {
     effort?: "max" | "xhigh" | "high" | "medium" | "low"
   } | null
   ```

8. **Effort 降级逻辑**
   - `pickSupportedEffort()`: 从 model capabilities 获取支持列表
   - 错误检测 + 自动重试
   - 单元测试

### Phase 5: Testing & Rollout

9. **E2E Tests**
   - 原生透传基础功能
   - Server-side tools（原生路径 + 翻译路径）
   - Reasoning effort fallback
   - 大上下文 (1M) 验证

10. **Feature Flag (可选)**
    - `RAVEN_NATIVE_MESSAGES=1` 环境变量

## Migration Notes

### Breaking Changes

无。现有客户端无需修改。

- `/v1/models` 返回字段增加（添加可选的 `supported_endpoints`、`capabilities.supports`），向后兼容
- 现有 `display_name`, `context_length`, `max_completion_tokens` 保持不变
- Provider-only 模型无新字段（undefined），不影响现有逻辑

### Behavior Changes

| 场景 | Before | After |
|------|--------|-------|
| Claude 模型请求 | 翻译为 OpenAI 格式 | 原生 Anthropic 透传 |
| `output_config.effort` | 被丢弃 | 透传（自动降级到支持值） |
| `thinking` 参数 | 被丢弃 (Copilot 路径) | 原生支持 |
| `anthropic-beta` header | 透传 | 过滤后透传 |
| `/v1/models` 响应 | 简化字段 | 扩展字段（添加 `supported_endpoints`, `capabilities.supports`） |
| Server-side Tools | 在 OpenAI payload 层处理 | 在 Anthropic payload 层处理（统一拦截） |

### 代码简化

| 文件 | 变化 |
|------|------|
| `handler.ts` | 提取 `preprocessPayload()`，减少 ~100 行 |
| `non-stream-translation.ts` | 删除 `serverSideToolNames` 逻辑，减少 ~50 行 |
| 新增 `preprocess.ts` | ~80 行，可独立测试 |
| 新增 `server-tools.ts` | ~200 行，可独立测试 |
| 新增 `create-native-messages.ts` | ~100 行，可独立测试 |

### Rollback

如遇问题，可通过修改路由判断逻辑回退到翻译路径。

## References

- [copilot-gateway PR #6](https://github.com/Menci/copilot-gateway/pull/6) - Reasoning effort fallback
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [Raven Doc 14 - Extended Thinking](./14-extended-thinking.md) - 现有 thinking 支持
