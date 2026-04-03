# 16 — OpenAI Responses API (`/v1/responses`) Support

## Background

OpenAI 在 2025 年推出了新一代 **Responses API** (`/v1/responses`)，作为 Chat Completions API 的演进版本。Codex CLI（OpenAI 的命令行编程助手）完全基于此 API 构建，不使用传统的 `/v1/chat/completions`。

Raven 当前支持：
- `/v1/chat/completions` — OpenAI Chat Completions 格式
- `/v1/messages` — Anthropic Messages 格式（带 stream translation）

为支持 Codex CLI 等新一代工具，需要新增 `/v1/responses` 端点。

## Goals

1. **支持 Codex CLI** — Codex 依赖 `/v1/responses` + function calling (shell execution)
2. **复用现有架构** — 遵循 messages handler 的 translation 模式
3. **渐进式实现** — 先支持核心功能，后续迭代扩展

## Non-Goals

- 内置工具（web_search, file_search, code_interpreter）— Raven 不是 OpenAI，这些需要服务端实现
- `previous_response_id` 状态管理 — 需要服务端存储，MVP 阶段不支持
- Computer Use — 需要特殊运行环境

---

## API 差异对比

| 特性 | `/v1/chat/completions` | `/v1/responses` |
|------|------------------------|-----------------|
| 输入字段 | `messages: Message[]` | `input: string \| InputItem[]` |
| 系统提示 | messages 里 role=system | `instructions` 参数 |
| 多轮对话 | 手动管理 messages | `previous_response_id`（服务端存储） |
| 输出访问 | `choices[0].message.content` | `output[].content[].text` / `output_text` |
| 函数调用 | `tools` + `tool_choice` | 同，但 strict by default |
| 流式事件 | `data: {...}\n\n` | `event: type\ndata: {...}\n\n`（53 种事件） |
| finish_reason | `stop`, `tool_calls`, `length` | `response.completed` 事件 |

### 请求格式

```typescript
// /v1/responses request
interface ResponsesRequest {
  model: string                              // required
  input: string | InputItem[]                // required (替代 messages)
  instructions?: string                      // system prompt
  tools?: Tool[]                             // function definitions
  tool_choice?: "auto" | "required" | "none" | { type: "function", name: string }
  stream?: boolean
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  reasoning?: { effort: "minimal" | "low" | "medium" | "high" }
  store?: boolean                            // 是否存储（default: true）
  previous_response_id?: string              // 多轮链接
  include?: string[]                         // 额外返回字段
}

interface InputItem {
  type: "message"
  role: "user" | "assistant" | "system"
  content: string | ContentPart[]
}

interface ContentPart {
  type: "input_text" | "input_image" | "input_file"
  // ... type-specific fields
}
```

### 响应格式

```typescript
// /v1/responses response (non-streaming)
interface ResponsesResponse {
  id: string                                 // "resp_xxx"
  object: "response"
  created_at: number
  status: "completed" | "incomplete" | "failed"
  model: string
  output: OutputItem[]
  usage: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
  error?: { code: string; message: string }
}

interface OutputItem {
  type: "message" | "function_call" | "reasoning"
  id: string
  status: "completed" | "in_progress"
  role?: "assistant"
  content?: ContentBlock[]
  name?: string           // for function_call
  arguments?: string      // for function_call (JSON string)
  call_id?: string        // for function_call
}

interface ContentBlock {
  type: "output_text" | "refusal"
  text?: string
  refusal?: string
  annotations?: Annotation[]
}
```

### Streaming 事件（核心子集）

Responses API 定义了 53 种 SSE 事件，Codex CLI 主要依赖以下事件：

| 事件 | 用途 | 关键字段 |
|------|------|----------|
| `response.created` | 响应开始 | `response` (初始对象) |
| `response.in_progress` | 生成中 | `response` |
| `response.output_item.added` | 新输出项 | `output_index`, `item` |
| `response.content_part.added` | 新内容块 | `item_id`, `content_index`, `part` |
| `response.output_text.delta` | **文本增量** | `item_id`, `content_index`, `delta` |
| `response.output_text.done` | 文本完成 | `item_id`, `content_index`, `text` |
| `response.function_call_arguments.delta` | 函数参数增量 | `item_id`, `delta` |
| `response.function_call_arguments.done` | 函数调用完成 | `item_id`, `name`, `arguments` |
| `response.output_item.done` | 输出项完成 | `item` |
| `response.completed` | **最终响应** | `response` (含 usage) |
| `response.failed` | 失败 | `response.error` |
| `error` | 传输错误 | `code`, `message` |

SSE 格式：
```
event: response.output_text.delta
data: {"item_id":"msg_xxx","output_index":0,"content_index":0,"delta":"Hello","sequence_number":5}

event: response.completed
data: {"response":{...完整响应...},"sequence_number":99}
```

---

## Architecture

### 复用现有模式

参照 `/v1/messages` 的实现架构：

```
┌─────────────────────────────────────────────────────────────────┐
│                     /v1/responses handler                       │
├─────────────────────────────────────────────────────────────────┤
│  1. Parse ResponsesRequest                                      │
│  2. translateResponsesToOpenAI() → ChatCompletionsPayload       │
│  3. Call createChatCompletions() (existing Copilot service)     │
│  4. translateOpenAIToResponses() or stream translation          │
└─────────────────────────────────────────────────────────────────┘
```

### 文件结构

```
packages/proxy/src/routes/responses/
├── route.ts                    # Hono router 定义
├── handler.ts                  # 主处理逻辑（参考 messages/handler.ts）
├── responses-types.ts          # TypeScript 类型定义
├── request-translation.ts      # Responses → OpenAI 转换
├── response-translation.ts     # OpenAI → Responses 转换（非流式）
└── stream-translation.ts       # OpenAI chunks → Responses events（流式）
```

### 类型定义

```typescript
// responses-types.ts

// ===== Request Types =====

export interface ResponsesRequest {
  model: string
  input: string | ResponsesInputItem[]
  instructions?: string | null
  tools?: ResponsesTool[] | null
  tool_choice?: ResponsesToolChoice | null
  stream?: boolean | null
  max_output_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  reasoning?: { effort: "minimal" | "low" | "medium" | "high" } | null
  store?: boolean | null
  previous_response_id?: string | null
  include?: string[] | null
}

export interface ResponsesInputItem {
  type: "message"
  role: "user" | "assistant" | "system"
  content: string | ResponsesContentPart[]
}

export interface ResponsesTextPart {
  type: "input_text"
  text: string
}

export interface ResponsesImagePart {
  type: "input_image"
  image_url?: string
  image_data?: string  // base64
  media_type?: string
}

export type ResponsesContentPart = ResponsesTextPart | ResponsesImagePart

export interface ResponsesTool {
  type: "function"
  name: string
  description?: string | null
  parameters: Record<string, unknown>
  strict?: boolean
}

export type ResponsesToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; name: string }

// ===== Response Types =====

export interface ResponsesResponse {
  id: string
  object: "response"
  created_at: number
  status: "completed" | "incomplete" | "failed"
  model: string
  output: ResponsesOutputItem[]
  usage: ResponsesUsage
  error?: ResponsesError | null
}

export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

export interface ResponsesError {
  code: string
  message: string
}

export type ResponsesOutputItem =
  | ResponsesMessageOutput
  | ResponsesFunctionCallOutput

export interface ResponsesMessageOutput {
  type: "message"
  id: string
  status: "completed" | "in_progress"
  role: "assistant"
  content: ResponsesOutputContent[]
}

export interface ResponsesOutputContent {
  type: "output_text"
  text: string
  annotations: unknown[]
}

export interface ResponsesFunctionCallOutput {
  type: "function_call"
  id: string
  status: "completed" | "in_progress"
  name: string
  arguments: string
  call_id: string
}

// ===== Streaming Event Types =====

export interface ResponsesStreamState {
  responseId: string
  model: string
  createdAt: number
  sequenceNumber: number
  outputItems: Map<number, { id: string; type: string }>
  contentParts: Map<string, { index: number; text: string }>
  functionCalls: Map<number, { id: string; name: string; arguments: string }>
  inputTokens: number
  outputTokens: number
}

export type ResponsesStreamEvent =
  | { event: "response.created"; data: ResponsesCreatedEventData }
  | { event: "response.in_progress"; data: ResponsesInProgressEventData }
  | { event: "response.output_item.added"; data: ResponsesOutputItemAddedEventData }
  | { event: "response.content_part.added"; data: ResponsesContentPartAddedEventData }
  | { event: "response.output_text.delta"; data: ResponsesTextDeltaEventData }
  | { event: "response.output_text.done"; data: ResponsesTextDoneEventData }
  | { event: "response.function_call_arguments.delta"; data: ResponsesFunctionArgsDeltaEventData }
  | { event: "response.function_call_arguments.done"; data: ResponsesFunctionArgsDoneEventData }
  | { event: "response.output_item.done"; data: ResponsesOutputItemDoneEventData }
  | { event: "response.content_part.done"; data: ResponsesContentPartDoneEventData }
  | { event: "response.completed"; data: ResponsesCompletedEventData }
  | { event: "response.failed"; data: ResponsesFailedEventData }
  | { event: "error"; data: ResponsesErrorEventData }
```

### Translation 逻辑

#### Request Translation (Responses → OpenAI)

```typescript
// request-translation.ts

export function translateResponsesToOpenAI(
  payload: ResponsesRequest
): ChatCompletionsPayload {
  return {
    model: payload.model,
    messages: translateInputToMessages(payload.input, payload.instructions),
    max_tokens: payload.max_output_tokens ?? null,
    temperature: payload.temperature ?? null,
    top_p: payload.top_p ?? null,
    stream: payload.stream ?? null,
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
    // reasoning → reasoning_effort (if supported by upstream)
  }
}

function translateInputToMessages(
  input: string | ResponsesInputItem[],
  instructions?: string | null
): Message[] {
  const messages: Message[] = []

  // instructions → system message
  if (instructions) {
    messages.push({
      role: "system",
      content: instructions,
      name: null,
      tool_calls: null,
      tool_call_id: null,
    })
  }

  // input → user/assistant messages
  if (typeof input === "string") {
    messages.push({
      role: "user",
      content: input,
      name: null,
      tool_calls: null,
      tool_call_id: null,
    })
  } else {
    for (const item of input) {
      if (item.type === "message") {
        messages.push({
          role: item.role === "system" ? "system" : item.role,
          content: translateContent(item.content),
          name: null,
          tool_calls: null,
          tool_call_id: null,
        })
      }
    }
  }

  return messages
}
```

#### Response Translation (OpenAI → Responses)

```typescript
// response-translation.ts

export function translateOpenAIToResponses(
  response: ChatCompletionResponse,
  requestId: string
): ResponsesResponse {
  const output: ResponsesOutputItem[] = []
  const choice = response.choices[0]

  if (choice?.message) {
    // Text content → message output
    if (choice.message.content) {
      output.push({
        type: "message",
        id: `msg_${requestId}`,
        status: "completed",
        role: "assistant",
        content: [{
          type: "output_text",
          text: choice.message.content,
          annotations: [],
        }],
      })
    }

    // Tool calls → function_call outputs
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        output.push({
          type: "function_call",
          id: `fc_${tc.id}`,
          status: "completed",
          name: tc.function.name,
          arguments: tc.function.arguments,
          call_id: tc.id,
        })
      }
    }
  }

  return {
    id: `resp_${requestId}`,
    object: "response",
    created_at: response.created,
    status: "completed",
    model: response.model,
    output,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
    },
  }
}
```

#### Stream Translation (OpenAI chunks → Responses events)

```typescript
// stream-translation.ts

export function translateChunkToResponsesEvents(
  chunk: ChatCompletionChunk,
  state: ResponsesStreamState
): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = []
  const choice = chunk.choices[0]
  if (!choice) return events

  // First chunk: emit response.created + response.in_progress
  if (state.sequenceNumber === 0) {
    events.push({
      event: "response.created",
      data: {
        response: buildPartialResponse(state),
        sequence_number: state.sequenceNumber++,
      },
    })
    events.push({
      event: "response.in_progress",
      data: {
        response: buildPartialResponse(state),
        sequence_number: state.sequenceNumber++,
      },
    })
  }

  // Text delta
  if (choice.delta?.content) {
    const outputIndex = ensureMessageOutput(state, events)
    const contentIndex = ensureContentPart(state, events, outputIndex)

    events.push({
      event: "response.output_text.delta",
      data: {
        item_id: state.outputItems.get(outputIndex)!.id,
        output_index: outputIndex,
        content_index: contentIndex,
        delta: choice.delta.content,
        sequence_number: state.sequenceNumber++,
      },
    })
  }

  // Tool call delta
  if (choice.delta?.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      if (tc.id && tc.function?.name) {
        // New function call
        const outputIndex = state.outputItems.size
        const itemId = `fc_${tc.id}`
        state.outputItems.set(outputIndex, { id: itemId, type: "function_call" })
        state.functionCalls.set(tc.index, { id: tc.id, name: tc.function.name, arguments: "" })

        events.push({
          event: "response.output_item.added",
          data: {
            output_index: outputIndex,
            item: {
              type: "function_call",
              id: itemId,
              status: "in_progress",
              name: tc.function.name,
              arguments: "",
              call_id: tc.id,
            },
            sequence_number: state.sequenceNumber++,
          },
        })
      }

      if (tc.function?.arguments) {
        const fc = state.functionCalls.get(tc.index)
        if (fc) {
          fc.arguments += tc.function.arguments
          events.push({
            event: "response.function_call_arguments.delta",
            data: {
              item_id: `fc_${fc.id}`,
              output_index: findOutputIndex(state, `fc_${fc.id}`),
              delta: tc.function.arguments,
              sequence_number: state.sequenceNumber++,
            },
          })
        }
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    // Close all open items
    closeAllOutputItems(state, events)

    // Update usage from final chunk
    if (chunk.usage) {
      state.inputTokens = chunk.usage.prompt_tokens ?? 0
      state.outputTokens = chunk.usage.completion_tokens ?? 0
    }

    events.push({
      event: "response.completed",
      data: {
        response: buildFinalResponse(state),
        sequence_number: state.sequenceNumber++,
      },
    })
  }

  return events
}
```

---

## Implementation Plan

### Phase 1: Types & Request Translation (Commit 1-3)

**Commit 1: Add ResponsesRequest types**
```
feat(proxy): add OpenAI Responses API request types

- Add ResponsesRequest interface
- Add ResponsesInputItem, ResponsesContentPart types
- Add ResponsesTool and ResponsesToolChoice types
```

Files:
- `packages/proxy/src/routes/responses/responses-types.ts` (new)

Tests:
- Type compilation check (tsc --noEmit)

**Commit 2: Add ResponsesResponse types**
```
feat(proxy): add OpenAI Responses API response types

- Add ResponsesResponse interface
- Add ResponsesOutputItem variants (message, function_call)
- Add ResponsesUsage and ResponsesError types
```

Files:
- `packages/proxy/src/routes/responses/responses-types.ts` (extend)

Tests:
- Type compilation check

**Commit 3: Implement request translation**
```
feat(proxy): implement Responses → OpenAI request translation

- translateResponsesToOpenAI() main function
- translateInputToMessages() for input field
- translateTools() and translateToolChoice()
- Handle instructions → system message
```

Files:
- `packages/proxy/src/routes/responses/request-translation.ts` (new)

Tests:
- Unit tests for translateResponsesToOpenAI()
- Test cases: simple string input, array input, with tools, with instructions

### Phase 2: Non-Streaming Response (Commit 4-6)

**Commit 4: Add stream event types**
```
feat(proxy): add OpenAI Responses API streaming event types

- Add ResponsesStreamState interface
- Add ResponsesStreamEvent union type
- Add all event data interfaces (created, delta, done, completed)
```

Files:
- `packages/proxy/src/routes/responses/responses-types.ts` (extend)

Tests:
- Type compilation check

**Commit 5: Implement response translation (non-streaming)**
```
feat(proxy): implement OpenAI → Responses response translation

- translateOpenAIToResponses() for non-streaming
- Handle text content → message output
- Handle tool_calls → function_call outputs
- Build proper response envelope
```

Files:
- `packages/proxy/src/routes/responses/response-translation.ts` (new)

Tests:
- Unit tests for translateOpenAIToResponses()
- Test cases: text only, with tool calls, empty response

**Commit 6: Implement non-streaming handler**
```
feat(proxy): implement /v1/responses non-streaming handler

- Create route.ts with POST /
- Create handler.ts with handleResponses()
- Wire request translation → createChatCompletions → response translation
- Add to app.ts route registration
```

Files:
- `packages/proxy/src/routes/responses/route.ts` (new)
- `packages/proxy/src/routes/responses/handler.ts` (new)
- `packages/proxy/src/app.ts` (modify)

Tests:
- Unit tests for handler with mocked createChatCompletions
- Integration: non-streaming request/response cycle

### Phase 3: Streaming Response (Commit 7-9)

**Commit 7: Implement stream translation core**
```
feat(proxy): implement Responses streaming event translation (core)

- translateChunkToResponsesEvents() main function
- ResponsesStreamState management
- Emit response.created, response.in_progress
- Emit response.output_text.delta
```

Files:
- `packages/proxy/src/routes/responses/stream-translation.ts` (new)

Tests:
- Unit tests for text delta translation
- Test sequence_number incrementing

**Commit 8: Implement stream translation (function calls)**
```
feat(proxy): implement Responses streaming for function calls

- Emit response.output_item.added for function_call
- Emit response.function_call_arguments.delta
- Emit response.function_call_arguments.done
- Handle multiple concurrent tool calls
```

Files:
- `packages/proxy/src/routes/responses/stream-translation.ts` (extend)

Tests:
- Unit tests for function call streaming
- Test multiple tool calls interleaved

**Commit 9: Implement streaming handler**
```
feat(proxy): implement /v1/responses streaming handler

- Add streaming branch in handler.ts
- Use proper SSE format: "event: {type}\ndata: {json}\n\n"
- Emit response.completed with usage
- Handle stream errors → response.failed
```

Files:
- `packages/proxy/src/routes/responses/handler.ts` (extend)

Tests:
- Unit tests for streaming handler
- Test SSE event format

### Phase 4: Logging & Polish (Commit 10-11)

**Commit 10: Add logging instrumentation**
```
feat(proxy): add logging for /v1/responses endpoint

- Emit request_start with format: "responses"
- Emit request_end with latency, tokens, status
- Debug logging for tool calls (optToolCallDebug)
```

Files:
- `packages/proxy/src/routes/responses/handler.ts` (extend)

Tests:
- Verify log events are emitted correctly

**Commit 11: Add error handling**
```
feat(proxy): add error handling for /v1/responses

- Handle upstream errors → response.failed event
- Handle validation errors → 400 response
- Handle rate limit → 429 response
- Forward error details in Responses format
```

Files:
- `packages/proxy/src/routes/responses/handler.ts` (extend)

Tests:
- Unit tests for error scenarios

---

## Test Plan

### L1: Unit Tests

| File | Test Cases | Coverage Target |
|------|------------|-----------------|
| `request-translation.test.ts` | 12 cases | 100% |
| `response-translation.test.ts` | 8 cases | 100% |
| `stream-translation.test.ts` | 15 cases | 100% |
| `handler.test.ts` | 10 cases | 90% |

#### Request Translation Tests

```typescript
describe("translateResponsesToOpenAI", () => {
  it("translates simple string input to user message")
  it("translates array input with multiple messages")
  it("adds instructions as system message")
  it("translates tools array")
  it("translates tool_choice: auto")
  it("translates tool_choice: required")
  it("translates tool_choice with specific function")
  it("handles input_text content parts")
  it("handles input_image content parts")
  it("handles missing optional fields")
  it("preserves model name")
  it("translates reasoning.effort to reasoning_effort")
})
```

#### Response Translation Tests

```typescript
describe("translateOpenAIToResponses", () => {
  it("translates text response to message output")
  it("translates tool_calls to function_call outputs")
  it("builds correct response envelope")
  it("calculates usage correctly")
  it("handles empty response")
  it("handles multiple tool calls")
  it("generates correct IDs")
  it("sets status to completed")
})
```

#### Stream Translation Tests

```typescript
describe("translateChunkToResponsesEvents", () => {
  // Lifecycle events
  it("emits response.created on first chunk")
  it("emits response.in_progress after created")
  it("emits response.completed on finish_reason")

  // Text streaming
  it("emits output_item.added for first text")
  it("emits content_part.added for first text")
  it("emits output_text.delta for text content")
  it("emits output_text.done on finish")
  it("emits content_part.done on finish")
  it("emits output_item.done on finish")

  // Function call streaming
  it("emits output_item.added for new function call")
  it("emits function_call_arguments.delta for arguments")
  it("emits function_call_arguments.done on finish")
  it("handles multiple concurrent tool calls")

  // State management
  it("increments sequence_number correctly")
  it("tracks output items by index")
})
```

### L2: E2E Tests (Manual)

遵循 anti-ban protocol，手动执行：

```bash
# 1. Non-streaming
curl -s http://localhost:7024/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "input": "Say hello in 3 words"
  }'

# 2. Streaming
curl -s http://localhost:7024/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "input": "Say hello in 3 words",
    "stream": true
  }'

# 3. With tools (function calling)
curl -s http://localhost:7024/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "input": "What is 2+2?",
    "tools": [{
      "type": "function",
      "name": "calculator",
      "description": "Calculate math",
      "parameters": {"type": "object", "properties": {"expr": {"type": "string"}}}
    }]
  }'
```

### L3: Codex CLI Integration Test

```bash
# Configure Codex to use Raven
export OPENAI_BASE_URL=http://localhost:7024
export OPENAI_API_KEY=rk-xxx

# Run Codex
codex --model claude-sonnet-4.6 "Create a hello world Python script"
```

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| 53 种事件难以完全实现 | Codex 可能依赖未实现事件 | 先实现核心子集，按需添加 |
| SSE 格式差异 | 客户端解析失败 | 严格遵循 `event:\ndata:\n\n` 格式 |
| `previous_response_id` 不支持 | 多轮对话失效 | 文档说明限制，建议客户端管理 |
| 上游模型不支持 | 某些 Copilot 模型可能不支持工具 | 透传错误，不做特殊处理 |

---

## Future Work

1. **`previous_response_id` 支持** — 需要 SQLite 表存储响应历史
2. **Reasoning events** — `response.reasoning_text.delta` 等
3. **更多内置工具** — web_search proxy（如果 Tavily 集成成功）
4. **Batch API** — `/v1/responses` 批量模式

---

## References

- [OpenAI Responses API Migration Guide](https://developers.openai.com/api/docs/guides/migrate-to-responses/)
- [Responses API Streaming Events](https://community.openai.com/t/responses-api-streaming-the-simple-guide-to-events/1363122)
- [Codex CLI Local LLM Support Issue](https://github.com/openai/codex/issues/26)
- [LiteLLM Responses API](https://docs.litellm.ai/docs/providers/openai/responses_api)
