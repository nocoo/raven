# 16 — OpenAI Responses API (`/v1/responses`) Support

## Background

GitHub Copilot 后端原生支持 `/responses` 端点（与 OpenAI Responses API 兼容）。Codex CLI 等新一代工具完全基于此 API 构建。

## Goals

**极简 passthrough** — 直接转发请求到 Copilot `/responses` 端点，原样返回响应/SSE 流。

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     /v1/responses handler                       │
├─────────────────────────────────────────────────────────────────┤
│  1. Forward payload to Copilot /responses                       │
│  2. Return response (JSON or SSE stream passthrough)            │
│  3. On error: forwardError() 保留状态码，封装 error.message     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                  https://api.githubcopilot.com/responses
```

**成功响应与 SSE 事件原样透传；错误响应保留 HTTP 状态码，但按 `forwardError()` 格式封装为 `{ error: { message, type } }`。**

---

## 上游契约假设

Raven 依赖以下上游行为，**不做协议修复**：

| 条件 | 期望上游行为 | Raven 行为 |
|------|-------------|-----------|
| `stream: true` | 返回 `Content-Type: text/event-stream`，SSE 格式 | 原样透传 SSE |
| `stream: false` 或省略 | 返回单个 JSON response object | 原样返回 JSON |
| 上游 4xx/5xx | 返回错误体 | `forwardError()` 保留状态码，上游 body 作为 `error.message` |
| 上游违反契约 | — | 直接转发/报错，不做修复 |

---

## Implementation

### File Structure

```
packages/proxy/src/routes/responses/
├── route.ts                    # Hono router
├── handler.ts                  # Passthrough handler

packages/proxy/src/services/copilot/
└── create-responses.ts         # Upstream fetch wrapper
```

### Core Service

```typescript
// services/copilot/create-responses.ts

import { events } from "../../util/sse"
import { copilotBaseUrl, copilotHeaders } from "../../lib/api-config"
import { HTTPError } from "../../lib/error"
import { state } from "../../lib/state"

export interface ResponsesPayload {
  model: string
  input: unknown
  stream?: boolean
  [key: string]: unknown  // Passthrough all fields
}

export const createResponses = async (payload: ResponsesPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = hasVisionContent(payload)
  const isAgentCall = hasAgentHistory(payload)

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw await HTTPError.fromResponse("Failed to create responses", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return await response.json()
}

function hasVisionContent(payload: ResponsesPayload): boolean {
  if (!Array.isArray(payload.input)) return false
  return payload.input.some((item: unknown) => {
    if (typeof item !== "object" || item === null) return false
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) return false
    return content.some((part: unknown) => {
      if (typeof part !== "object" || part === null) return false
      return (part as Record<string, unknown>).type === "input_image"
    })
  })
}

function hasAgentHistory(payload: ResponsesPayload): boolean {
  if (!Array.isArray(payload.input)) return false
  return payload.input.some((item: unknown) => {
    if (typeof item !== "object" || item === null) return false
    const role = (item as Record<string, unknown>).role
    const type = (item as Record<string, unknown>).type
    return role === "assistant" || type === "function_call" || type === "function_call_output"
  })
}
```

### Handler

```typescript
// routes/responses/handler.ts

import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import { createResponses, type ResponsesPayload } from "../../services/copilot/create-responses"
import { forwardError } from "../../lib/error"

export const handleResponses = async (c: Context) => {
  let payload: ResponsesPayload

  try {
    payload = await c.req.json<ResponsesPayload>()
  } catch {
    return c.json({ error: { message: "Invalid JSON", type: "invalid_request_error" } }, 400)
  }

  try {
    const response = await createResponses(payload)

    // Streaming: passthrough SSE events
    if (payload.stream && isAsyncIterable(response)) {
      return streamSSE(c, async (stream) => {
        for await (const chunk of response) {
          await stream.writeSSE({
            event: chunk.event,
            data: typeof chunk.data === "string" ? chunk.data : JSON.stringify(chunk.data),
          })
        }
      })
    }

    // Non-streaming: return JSON
    return c.json(response)
  } catch (error) {
    // 使用现有 forwardError() 保持错误响应格式一致
    return forwardError(c, error)
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value) && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
}
```

### Route

```typescript
// routes/responses/route.ts

import { Hono } from "hono"
import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", handleResponses)
```

### App Registration

```typescript
// app.ts (添加)

import { responsesRoutes } from "./routes/responses/route"

// ...existing routes...
app.route("/v1/responses", responsesRoutes)
```

---

## Non-Goals

Raven 作为 passthrough 代理，**不做**：

- 请求/响应翻译
- 字段验证（交给上游）
- 内置工具过滤
- previous_response_id 管理
- Model capability 检查（交给上游返回错误）
- 错误体原样透传（错误响应按 `forwardError()` 封装）

---

## Codex CLI 配置指南

### 配置文件（推荐）

Codex CLI 使用 provider-based 配置体系。在 `~/.codex/config.toml` 中定义 Raven provider：

```toml
# 默认使用 Raven provider
model_provider = "raven"
model = "gpt-5.4"

# 可选：上下文窗口配置
model_context_window = 1000000
model_auto_compact_token_limit = 900000

# 定义 Raven provider
[model_providers.raven]
name = "Raven Proxy"
base_url = "http://localhost:7024/v1"
wire_api = "responses"
env_key = "RAVEN_API_KEY"  # 可选，Raven 未配置 API key 时可省略
```

### Profile 配置

使用 profile 切换不同模型：

```toml
# 默认配置
model_provider = "raven"
model = "gpt-5.4"

[model_providers.raven]
name = "Raven Proxy"
base_url = "http://localhost:7024/v1"
wire_api = "responses"

# GPT 模型 profile
[profiles.raven-gpt]
model_provider = "raven"
model = "gpt-5.4"

# Claude 模型 profile
[profiles.raven-claude]
model_provider = "raven"
model = "claude-sonnet-4"
```

使用：
```bash
codex -p raven-gpt "your prompt"
codex -p raven-claude "your prompt"
```

### 环境变量（可选）

如果 Raven 配置了 `RAVEN_API_KEY`：

```bash
# 设置 API key（对应 provider 的 env_key）
export RAVEN_API_KEY="your-raven-api-key"
```

**注意**：`OPENAI_BASE_URL` 是内置 OpenAI provider 的覆盖变量，不适用于自定义 provider。使用 Raven 应通过 `model_providers.raven` 配置 `base_url`。

### 命令行参数

```bash
# 临时覆盖 model
codex -c 'model="gpt-5-mini"' "your prompt"

# 使用 profile
codex -p raven-claude "your prompt"
```

### API Key 登录

如果 Raven 配置了 API key 认证：

```bash
# 通过 stdin 传入 API key
echo "your-raven-api-key" | codex login --with-api-key
```

### 调试验证

```bash
# 检查当前配置
cat ~/.codex/config.toml

# 检查登录状态
codex login status

# 验证连接（简单请求）
codex -c 'model="gpt-5-mini"' "say hello"
```

### 常见问题

| 问题 | 解决方案 |
|------|----------|
| 连接被拒绝 | 确认 Raven 在 7024 端口运行：`curl http://localhost:7024/health` |
| 401 Unauthorized | 检查 provider 的 `env_key` 对应环境变量（如 `RAVEN_API_KEY`）和 Raven 的 API key 配置 |
| Model not found | 使用 `/v1/models` 检查可用模型：`curl http://localhost:7024/v1/models` |

---

## Implementation Plan（更新）

### Atomic Commits (4 commits)

#### Commit 1: Add create-responses service ✅

```
feat(proxy): add Copilot /responses service

Add upstream service for Responses API passthrough:
- createResponses() fetches from Copilot /responses
- Support streaming and non-streaming modes
- Vision and agent context detection
```

| File | Change |
|------|--------|
| `src/services/copilot/create-responses.ts` | new |
| `test/services/copilot/create-responses.test.ts` | new |

**Tests (6):**
- Non-streaming request returns JSON
- Streaming request returns SSE async iterable
- Vision detection for input_image content
- Agent detection for assistant/function_call history
- Throws HTTPError on upstream failure
- Throws on missing copilot token

---

#### Commit 2: Add /v1/responses handler and route ✅

```
feat(proxy): add /v1/responses passthrough endpoint

Wire up Responses API:
- route.ts with POST /
- handler.ts with stream passthrough
- Register in app.ts
```

| File | Change |
|------|--------|
| `src/routes/responses/route.ts` | new |
| `src/routes/responses/handler.ts` | new |
| `src/app.ts` | modify |
| `test/routes/responses/handler.test.ts` | new |

**Tests (8):**
- Returns 200 for non-streaming request
- Returns Content-Type: text/event-stream for streaming
- Passthrough SSE events with correct format
- Handles function_call streaming
- Returns 400 on invalid JSON body
- Returns upstream status code via forwardError()
- Returns error.message containing upstream body
- Handles empty stream gracefully

---

#### Commit 3: Add logging ✅

```
feat(proxy): add logging for /v1/responses

Instrument handler:
- request_start with format: "responses", model, stream
- request_end with latency, tokens
```

| File | Change |
|------|--------|
| `src/routes/responses/handler.ts` | extend |
| `test/routes/responses/handler.test.ts` | extend |

**Tests (2):**
- Emits request_start log
- Emits request_end log with usage

---

#### Commit 4: Add E2E tests for /v1/responses ✅

```
test(proxy): add E2E tests for /v1/responses endpoint

Add manual E2E tests following anti-ban protocol:
- Non-streaming: verify JSON response structure
- Streaming: verify SSE event format
```

| File | Change |
|------|--------|
| `test/e2e/proxy.e2e.test.ts` | extend |

**Tests (2):**
- POST /v1/responses non-streaming returns valid response
- POST /v1/responses streaming returns SSE events

---

## 6DQ Test Plan

| Dimension | Target |
|-----------|--------|
| **L1** | +16 unit tests |
| **L2** | +2 e2e tests (manual) |
| **G1** | 0 lint/type errors |
| **G2** | osv-scanner + gitleaks pass |
| **D1** | Uses `raven-test.db` |

### L1 Unit Tests

| File | Tests |
|------|-------|
| `create-responses.test.ts` | 6 |
| `handler.test.ts` | 10 |
| **Total** | **16** |

### L2 E2E Tests (Manual)

```typescript
describe("e2e: /v1/responses", () => {
  test("POST /v1/responses non-streaming", async () => {
    const res = await fetch(`${PROXY}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: "Reply with exactly: hello",
        stream: false,
      }),
    })
    expect(res.ok).toBe(true)
    const body = await res.json()
    expect(body.id).toMatch(/^resp_/)
    expect(body.output).toBeArray()
    expect(body.status).toBe("completed")
  })

  test("POST /v1/responses streaming", async () => {
    const res = await fetch(`${PROXY}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: "Reply with exactly: hello",
        stream: true,
      }),
    })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    
    // Verify SSE format: event: xxx\ndata: {...}\n\n
    const text = await res.text()
    expect(text).toContain("event: response.created")
    expect(text).toContain("event: response.completed")
  })
})
```

---

## Implementation Summary

**Completed: 2026-04-04**

| Metric | Target | Actual |
|--------|--------|--------|
| Commits | 4 | 4 |
| Unit Tests | 16 | 25 |
| E2E Tests | 2 | 2 |
| Coverage | 90% | 91.2% |

### Commits

1. `c1a45a4` feat(proxy): add Copilot /responses service
2. `c5ee894` feat(proxy): add /v1/responses route and handler
3. `921119c` feat(proxy): add logging for /v1/responses
4. `464c942` test(proxy): add E2E tests for /v1/responses endpoint

### Test Coverage

| File | Tests |
|------|-------|
| `create-responses.test.ts` | 12 |
| `handler.test.ts` | 13 |
| `proxy.e2e.test.ts` | +2 |
| **Total** | **27** |
