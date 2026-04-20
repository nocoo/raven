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

## Design

### 目标架构

```
Client (Anthropic format)
    ↓
Raven /v1/messages
    ↓
[Preprocessing: rate limit, logging, SOCKS5, etc.]
    ↓
Copilot /v1/messages         ← 原生 Anthropic 协议透传
    ↓
[Postprocessing: logging, metrics]
    ↓
Client
```

### 路由决策

```
handleCompletion()
├── resolveProvider(model) 匹配到 provider?
│   ├── provider.format === "anthropic"
│   │   └── handleAnthropicPassthrough()      // 已有：自定义 Anthropic upstream
│   │
│   └── provider.format === "openai"
│       └── handleOpenAIUpstream()            // 已有：翻译路径
│
└── 无匹配 (默认 Copilot)
    ├── model.startsWith("claude-") && supportsNativeMessages(model)?
    │   └── handleCopilotNativeMessages()     // 🆕 新增：原生透传
    │
    └── 其他模型
        └── createChatCompletions()           // 已有：翻译路径
```

### 核心组件

#### 1. Model Capability Cache

扩展现有 `state.models` 缓存，保留 `supported_endpoints` 信息：

```typescript
// lib/state.ts
interface ModelInfo {
  id: string
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
| Server-side Tools (Tavily) | 拦截循环保持不变 |
| Token Counting | `/v1/count_tokens` 独立 |

### 不透传的字段

以下字段在透传前需要处理：

| 字段 | 处理 |
|------|------|
| `anthropic-beta` header | 过滤为 `ALLOWED_BETAS` 子集 |
| `service_tier` | 移除（Copilot 不支持） |

## Implementation Plan

### Phase 1: Infrastructure

1. **扩展 Models Cache**
   - `get-models.ts`: 保留 `supported_endpoints` 字段
   - `state.ts`: 类型定义更新
   - `route.ts`: 返回 `supported_endpoints` 给客户端

2. **新建 Native Messages Service**
   - `services/copilot/create-native-messages.ts`
   - 单元测试（mock HTTP）

### Phase 2: Handler Integration

3. **路由判断逻辑**
   - `handler.ts`: 添加 `supportsNativeMessages()` 检查
   - 模型前缀判断 + `supported_endpoints` 校验

4. **Handler 实现**
   - `handleCopilotNativeMessages()` 非流式
   - `handleCopilotNativeMessagesStream()` 流式
   - 日志集成

### Phase 3: Reasoning Effort Fallback

5. **错误解析 & 重试**
   - `parseReasoningEffortError()`: 提取支持列表
   - `pickSupportedEffort()`: 选择最近值
   - 重试逻辑 + 降级日志

6. **类型定义**
   - `anthropic-types.ts`: 添加 `output_config` 字段

### Phase 4: Testing & Rollout

7. **E2E Tests**
   - 原生透传基础功能
   - Reasoning effort fallback
   - Beta header 过滤
   - 大上下文 (1M) 验证

8. **Feature Flag (可选)**
   - `RAVEN_NATIVE_MESSAGES=1` 环境变量
   - 逐步灰度切换

## Migration Notes

### Breaking Changes

无。现有客户端无需修改。

### Behavior Changes

| 场景 | Before | After |
|------|--------|-------|
| Claude 模型请求 | 翻译为 OpenAI 格式 | 原生 Anthropic 透传 |
| `output_config.effort` | 被丢弃 | 透传（支持 fallback） |
| `thinking` 参数 | 被丢弃 (Copilot 路径) | 原生支持 |
| `anthropic-beta` header | 透传 | 过滤后透传 |

### Rollback

如遇问题，可通过修改路由判断逻辑回退到翻译路径。

## References

- [copilot-gateway PR #6](https://github.com/Menci/copilot-gateway/pull/6) - Reasoning effort fallback
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [Raven Doc 14 - Extended Thinking](./14-extended-thinking.md) - 现有 thinking 支持
