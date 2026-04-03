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
│  1. Validate model supports /responses                          │
│  2. Forward payload to Copilot /responses                       │
│  3. Return response (JSON or SSE stream passthrough)            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                  https://api.githubcopilot.com/responses
```

**不做翻译**：请求和响应原样透传，Raven 只是代理层。

---

## Implementation

### File Structure

```
packages/proxy/src/routes/responses/
├── route.ts                    # Hono router
├── handler.ts                  # Passthrough handler
└── types.ts                    # Minimal type definitions (optional)

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

export const handleResponses = async (c: Context) => {
  const payload = await c.req.json<ResponsesPayload>()

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

## Implementation Plan

### Atomic Commits (3 commits)

#### Commit 1: Add create-responses service

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

#### Commit 2: Add /v1/responses handler and route

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
- Returns upstream error format on failure
- Handles empty stream gracefully
- Respects stream: false
- Respects stream: true

---

#### Commit 3: Add logging

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

## 6DQ Test Plan

| Dimension | Target |
|-----------|--------|
| **L1** | +16 unit tests |
| **L2** | +2 e2e tests (manual) |
| **G1** | 0 lint/type errors |
| **G2** | osv-scanner + gitleaks pass |
| **D1** | Uses `raven-test.db` |

### L1 Tests

| File | Tests |
|------|-------|
| `create-responses.test.ts` | 6 |
| `handler.test.ts` | 10 |
| **Total** | **16** |

### L2 E2E Tests (Manual)

```typescript
test("POST /v1/responses non-streaming", async () => {
  const res = await fetch(`${PROXY}/v1/responses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: "gpt-5-mini",
      input: "Say hello",
      stream: false,
    }),
  })
  expect(res.ok).toBe(true)
  const body = await res.json()
  expect(body.output).toBeDefined()
})

test("POST /v1/responses streaming", async () => {
  const res = await fetch(`${PROXY}/v1/responses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: "gpt-5-mini",
      input: "Say hello",
      stream: true,
    }),
  })
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  // Verify SSE format: event: xxx\ndata: {...}\n\n
})
```

---

## Non-Goals

Raven 作为 passthrough 代理，**不做**：

- 请求/响应翻译
- 字段验证（交给上游）
- 内置工具过滤
- previous_response_id 管理
- Model capability 检查（除非上游返回错误）

上游返回什么，Raven 就返回什么。
