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

### Atomic Commit Strategy

每个 commit 必须：
1. **独立可编译** — `bun run typecheck` 通过
2. **独立可测试** — 新增代码有对应测试，`bun run test` 通过
3. **独立可回滚** — 不依赖后续 commit 才能工作
4. **单一职责** — 一个 commit 只做一件事

### Phase 1: Types (Commit 1-2)

---

#### Commit 1: Add Responses API request/response types

```
feat(proxy): add OpenAI Responses API types

Add TypeScript type definitions for the OpenAI Responses API:
- Request types: ResponsesRequest, ResponsesInputItem, ResponsesContentPart
- Response types: ResponsesResponse, ResponsesOutputItem, ResponsesUsage
- Tool types: ResponsesTool, ResponsesToolChoice
- Streaming state: ResponsesStreamState
```

**Files Changed:**
| File | Change | Lines |
|------|--------|-------|
| `src/routes/responses/responses-types.ts` | new | ~180 |

**Test Requirement:**
- G1: `bun run typecheck` passes (type compilation)

**Verification:**
```bash
bun run typecheck  # 0 errors
```

---

#### Commit 2: Add Responses API streaming event types

```
feat(proxy): add OpenAI Responses API streaming event types

Add SSE event type definitions for streaming responses:
- Lifecycle: ResponsesCreatedEvent, ResponsesCompletedEvent, ResponsesFailedEvent
- Text: ResponsesTextDeltaEvent, ResponsesTextDoneEvent
- Function calls: ResponsesFunctionArgsDeltaEvent, ResponsesFunctionArgsDoneEvent
- Output items: ResponsesOutputItemAddedEvent, ResponsesOutputItemDoneEvent
```

**Files Changed:**
| File | Change | Lines |
|------|--------|-------|
| `src/routes/responses/responses-types.ts` | extend | +120 |

**Test Requirement:**
- G1: `bun run typecheck` passes

---

### Phase 2: Request Translation (Commit 3-4)

---

#### Commit 3: Implement Responses → OpenAI request translation

```
feat(proxy): implement Responses → OpenAI request translation

Translate OpenAI Responses API requests to Chat Completions format:
- translateResponsesToOpenAI() main entry point
- translateInputToMessages() handles string and array input
- translateTools() converts function definitions
- translateToolChoice() maps tool_choice variants
- instructions field → system message
```

**Files Changed:**
| File | Change | Lines |
|------|--------|-------|
| `src/routes/responses/request-translation.ts` | new | ~150 |
| `test/routes/responses/request-translation.test.ts` | new | ~200 |

**Test Cases (12):**
```typescript
describe("translateResponsesToOpenAI", () => {
  it("translates simple string input to user message")
  it("translates array input with multiple messages")
  it("adds instructions as system message at index 0")
  it("handles instructions + input combination")
  it("translates tools array to OpenAI format")
  it("translates tool_choice: auto")
  it("translates tool_choice: required → required")
  it("translates tool_choice: none")
  it("translates tool_choice with specific function name")
  it("handles input_text content parts")
  it("handles input_image content parts with base64")
  it("preserves model name unchanged")
})
```

**Test Requirement:**
- L1: 12 tests pass, 100% coverage on request-translation.ts

**Verification:**
```bash
bun test test/routes/responses/request-translation.test.ts
```

---

#### Commit 4: Add request translation edge cases and validation

```
feat(proxy): add Responses request validation and edge cases

Handle edge cases in request translation:
- Empty input validation → 400 error
- Missing model validation → 400 error
- Null/undefined field handling
- function_call_output input items (tool results)
- Reasoning effort mapping (if upstream supports)
```

**Files Changed:**
| File | Change | Lines |
|------|--------|-------|
| `src/routes/responses/request-translation.ts` | extend | +60 |
| `test/routes/responses/request-translation.test.ts` | extend | +80 |

**Test Cases (8):**
```typescript
describe("translateResponsesToOpenAI edge cases", () => {
  it("throws on empty input string")
  it("throws on empty input array")
  it("throws on missing model")
  it("handles null optional fields gracefully")
  it("handles undefined optional fields gracefully")
  it("translates function_call_output to tool message")
  it("maps reasoning.effort to reasoning_effort")
  it("ignores reasoning when effort is not set")
})
```

---

### Phase 3: Response Translation (Commit 5-6)

---

#### Commit 5: Implement OpenAI → Responses response translation (non-streaming)

```
feat(proxy): implement OpenAI → Responses response translation

Translate Chat Completions responses to Responses API format:
- translateOpenAIToResponses() main entry point
- Text content → message output item
- Tool calls → function_call output items
- Usage calculation with total_tokens
- Response ID generation (resp_ prefix)
```

**Files Changed:**
| File | Change | Lines |
|------|--------|-------|
| `src/routes/responses/response-translation.ts` | new | ~120 |
| `test/routes/responses/response-translation.test.ts` | new | ~150 |

**Test Cases (10):**
```typescript
describe("translateOpenAIToResponses", () => {
  it("translates text response to message output")
  it("generates resp_ prefixed ID")
  it("sets object to 'response'")
  it("sets status to 'completed'")
  it("translates tool_calls to function_call outputs")
  it("generates fc_ prefixed IDs for function calls")
  it("calculates usage.total_tokens correctly")
  it("handles empty content gracefully")
  it("handles multiple tool calls")
  it("handles mixed text and tool calls")
})
```

**Test Requirement:**
- L1: 10 tests pass, 100% coverage on response-translation.ts

---

#### Commit 6: Add non-streaming handler skeleton

```
feat(proxy): add /v1/responses route and non-streaming handler

Wire up the /v1/responses endpoint:
- route.ts with POST / handler
- handler.ts with handleResponses() entry point
- Non-streaming path: translate → createChatCompletions → translate back
- Register route in app.ts
```

**Files Changed:**
| File | Change | Lines |
|------|--------|-------|
| `src/routes/responses/route.ts` | new | ~20 |
| `src/routes/responses/handler.ts` | new | ~80 |
| `src/app.ts` | modify | +3 |
| `test/routes/responses/handler.test.ts` | new | ~100 |

**Test Cases (6):**
```typescript
describe("handleResponses (non-streaming)", () => {
  it("returns 200 with valid response format")
  it("calls createChatCompletions with translated payload")
  it("returns correct content-type: application/json")
  it("handles text-only response")
  it("handles response with tool calls")
  it("returns 400 on invalid request")
})
```

**Test Requirement:**
- L1: 6 tests pass (mocked upstream)
- Handler tests mock `createChatCompletions`

---

### Phase 4: Stream Translation (Commit 7-9)

---

#### Commit 7: Implement stream translation - lifecycle events

```
feat(proxy): implement Responses stream translation (lifecycle)

Translate OpenAI streaming chunks to Responses SSE events:
- translateChunkToResponsesEvents() main function
- ResponsesStreamState management
- Emit response.created on first chunk
- Emit response.in_progress after created
- Emit response.completed on finish_reason
- sequence_number tracking
```

**Files Changed:**
| File | Change | Lines |
|------|--------|-------|
| `src/routes/responses/stream-translation.ts` | new | ~100 |
| `test/routes/responses/stream-translation.test.ts` | new | ~120 |

**Test Cases (8):**
```typescript
describe("translateChunkToResponsesEvents (lifecycle)", () => {
  it("emits response.created on first chunk")
  it("emits response.in_progress after created")
  it("includes partial response in created event")
  it("emits response.completed on finish_reason=stop")
  it("emits response.completed on finish_reason=tool_calls")
  it("includes usage in completed event")
  it("increments sequence_number monotonically")
  it("initializes state correctly")
})
```

---

#### Commit 8: Implement stream translation - text deltas

```
feat(proxy): implement Responses stream translation (text)

Handle text content streaming:
- Emit response.output_item.added for first text
- Emit response.content_part.added for first content
- Emit response.output_text.delta for each text chunk
- Emit response.output_text.done on finish
- Emit response.content_part.done on finish
- Emit response.output_item.done on finish
```

**Files Changed:**
| File | Change | Lines |
|------|--------|-------|
| `src/routes/responses/stream-translation.ts` | extend | +80 |
| `test/routes/responses/stream-translation.test.ts` | extend | +100 |

**Test Cases (8):**
```typescript
describe("translateChunkToResponsesEvents (text)", () => {
  it("emits output_item.added for first text delta")
  it("emits content_part.added for first text delta")
  it("emits output_text.delta for each text chunk")
  it("accumulates text in state")
  it("emits output_text.done with full text on finish")
  it("emits content_part.done on finish")
  it("emits output_item.done on finish")
  it("handles multiple text chunks correctly")
})
```

---

#### Commit 9: Implement stream translation - function calls

```
feat(proxy): implement Responses stream translation (function calls)

Handle function call streaming:
- Emit response.output_item.added for new function call
- Emit response.function_call_arguments.delta for argument chunks
- Emit response.function_call_arguments.done on finish
- Handle multiple concurrent tool calls by index
- Track function call state separately from text
```

**Files Changed:**
| File | Change | Lines |
|------|--------|-------|
| `src/routes/responses/stream-translation.ts` | extend | +100 |
| `test/routes/responses/stream-translation.test.ts` | extend | +120 |

**Test Cases (10):**
```typescript
describe("translateChunkToResponsesEvents (function calls)", () => {
  it("emits output_item.added for new function call")
  it("includes function name in output_item.added")
  it("emits function_call_arguments.delta for argument chunks")
  it("accumulates arguments in state")
  it("emits function_call_arguments.done with full arguments")
  it("handles multiple concurrent tool calls")
  it("tracks tool calls by index correctly")
  it("handles interleaved text and tool call chunks")
  it("closes function call items on finish")
  it("generates correct call_id")
})
```

---

### Phase 5: Streaming Handler (Commit 10-11)

---

#### Commit 10: Implement streaming handler

```
feat(proxy): implement /v1/responses streaming handler

Add streaming support to the handler:
- Detect stream: true in request
- Use SSE format: "event: {type}\ndata: {json}\n\n"
- Stream through translateChunkToResponsesEvents
- Proper Content-Type: text/event-stream
- Handle stream completion
```

**Files Changed:**
| File | Change | Lines |
|------|--------|-------|
| `src/routes/responses/handler.ts` | extend | +80 |
| `test/routes/responses/handler.test.ts` | extend | +100 |

**Test Cases (8):**
```typescript
describe("handleResponses (streaming)", () => {
  it("returns Content-Type: text/event-stream")
  it("emits events in correct SSE format")
  it("emits response.created as first event")
  it("emits response.output_text.delta for text")
  it("emits response.completed as last event")
  it("handles function call streaming")
  it("closes stream properly on completion")
  it("handles empty response stream")
})
```

---

#### Commit 11: Add stream error handling

```
feat(proxy): add Responses stream error handling

Handle errors during streaming:
- Emit response.failed event on upstream error
- Emit error event on transport errors
- Include error code and message
- Clean up stream state on error
- Handle mid-stream disconnection
```

**Files Changed:**
| File | Change | Lines |
|------|--------|-------|
| `src/routes/responses/handler.ts` | extend | +50 |
| `src/routes/responses/stream-translation.ts` | extend | +30 |
| `test/routes/responses/handler.test.ts` | extend | +60 |

**Test Cases (6):**
```typescript
describe("handleResponses (error handling)", () => {
  it("emits response.failed on upstream error")
  it("includes error code in failed event")
  it("includes error message in failed event")
  it("emits error event on transport error")
  it("closes stream after error event")
  it("handles mid-stream upstream failure")
})
```

---

### Phase 6: Logging & Polish (Commit 12-13)

---

#### Commit 12: Add logging instrumentation

```
feat(proxy): add logging for /v1/responses endpoint

Instrument handler with structured logging:
- request_start with format: "responses", model, stream flag
- request_end with latency, tokens, status
- Debug logging for tool calls (optToolCallDebug)
- Error logging with upstream status
```

**Files Changed:**
| File | Change | Lines |
|------|--------|-------|
| `src/routes/responses/handler.ts` | extend | +40 |
| `test/routes/responses/handler.test.ts` | extend | +40 |

**Test Cases (4):**
```typescript
describe("handleResponses (logging)", () => {
  it("emits request_start log event")
  it("emits request_end log event with latency")
  it("logs tool definitions when optToolCallDebug enabled")
  it("logs error details on failure")
})
```

---

#### Commit 13: Add request validation and error responses

```
feat(proxy): add Responses request validation

Add comprehensive request validation:
- Validate required fields (model, input)
- Return 400 with Responses error format
- Return 429 on rate limit
- Forward upstream errors in Responses format
- Handle unsupported parameters gracefully
```

**Files Changed:**
| File | Change | Lines |
|------|--------|-------|
| `src/routes/responses/handler.ts` | extend | +60 |
| `test/routes/responses/handler.test.ts` | extend | +50 |

**Test Cases (6):**
```typescript
describe("handleResponses (validation)", () => {
  it("returns 400 on missing model")
  it("returns 400 on missing input")
  it("returns 400 with Responses error format")
  it("returns 429 on rate limit")
  it("forwards upstream 4xx errors")
  it("logs validation failures")
})

---

## 6DQ Test Plan

### Quality Dimension Matrix

| Dimension | Description | Trigger | Target |
|-----------|-------------|---------|--------|
| **L1** | Unit Tests | pre-commit | +76 tests, ≥90% coverage |
| **L2** | API E2E | manual | 4 new test cases |
| **L3** | Playwright | N/A | 无新增（dashboard 无 UI 变更） |
| **G1** | Static Analysis | pre-commit | 0 errors, 0 warnings |
| **G2** | Security | pre-push | osv-scanner + gitleaks pass |
| **D1** | Test Isolation | enforced | 使用 `raven-test.db` |

### L1: Unit Tests (+76 tests)

| Test File | Cases | Coverage |
|-----------|-------|----------|
| `request-translation.test.ts` | 20 | 100% |
| `response-translation.test.ts` | 10 | 100% |
| `stream-translation.test.ts` | 26 | 100% |
| `handler.test.ts` | 20 | 90% |
| **Total** | **76** | **≥90%** |

#### Test Matrix by Commit

| Commit | Test File | New Tests | Cumulative |
|--------|-----------|-----------|------------|
| 3 | request-translation.test.ts | +12 | 12 |
| 4 | request-translation.test.ts | +8 | 20 |
| 5 | response-translation.test.ts | +10 | 30 |
| 6 | handler.test.ts | +6 | 36 |
| 7 | stream-translation.test.ts | +8 | 44 |
| 8 | stream-translation.test.ts | +8 | 52 |
| 9 | stream-translation.test.ts | +10 | 62 |
| 10 | handler.test.ts | +8 | 70 |
| 11 | handler.test.ts | +6 | 76 |
| 12 | handler.test.ts | +4 | 80 |
| 13 | handler.test.ts | +6 | 86 |

#### Verification Command

```bash
# Run all responses tests
bun test test/routes/responses/

# Check coverage
bun test --coverage test/routes/responses/
```

### L2: API E2E Tests (Manual)

遵循 anti-ban protocol，手动执行。添加到 `proxy.e2e.test.ts`：

**新增 4 个 E2E 测试用例：**

```typescript
describe("/v1/responses E2E", () => {
  it("POST /v1/responses returns valid response (non-streaming)")
  it("POST /v1/responses returns SSE stream (streaming)")
  it("POST /v1/responses handles function calling")
  it("POST /v1/responses returns 400 on invalid request")
})
```

**手动验证脚本：**

```bash
#!/bin/bash
# e2e-responses-manual.sh
# Run manually, NOT in CI (anti-ban protocol)

API_KEY="${RAVEN_API_KEY:-rk-test}"
BASE_URL="http://localhost:7024"

echo "=== Test 1: Non-streaming ==="
curl -s "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "input": "Say hello in exactly 3 words"
  }' | jq .

echo -e "\n=== Test 2: Streaming ==="
curl -sN "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "input": "Say hello in exactly 3 words",
    "stream": true
  }' | head -20

echo -e "\n=== Test 3: Function calling ==="
curl -s "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.6",
    "input": "What is 2+2? Use the calculator tool.",
    "tools": [{
      "type": "function",
      "name": "calculator",
      "description": "Evaluate a math expression",
      "parameters": {
        "type": "object",
        "properties": {"expression": {"type": "string"}},
        "required": ["expression"]
      }
    }],
    "tool_choice": "auto"
  }' | jq .

echo -e "\n=== Test 4: Validation error ==="
curl -s "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": "missing model"}' | jq .
```

### L3: Playwright (N/A)

Dashboard 无 UI 变更，L3 不需要新增测试。

现有 25 个 Playwright 测试继续通过即可。

### G1: Static Analysis

每个 commit 必须通过：

```bash
bun run lint          # ESLint strict, 0 warnings
bun run typecheck     # TypeScript strict, 0 errors
```

**Pre-commit hook 自动执行。**

### G2: Security

Pre-push hook 执行：

```bash
bun run gate:security  # osv-scanner + gitleaks
```

**新文件不引入安全风险（纯 TypeScript，无依赖变更）。**

### D1: Test Isolation

所有测试使用隔离数据库：

```bash
RAVEN_DB_PATH=data/raven-test.db bun run test:e2e
```

**Verification:**
```bash
# 确认 raven.db 未被修改
ls -la packages/proxy/data/raven.db
ls -la packages/proxy/data/raven-test.db  # 测试数据在这里
```

---

## Commit Checklist

每个 commit 提交前必须通过：

```bash
# 1. Type check
bun run typecheck

# 2. Unit tests (L1)
bun test test/routes/responses/

# 3. All tests pass
bun run test:all

# 4. Lint (G1)
bun run lint

# 5. Pre-commit hook (自动)
git commit  # 触发 L1 + G1
```

---

## Integration Test: Codex CLI

最终验收测试 — 使用 Codex CLI 验证完整功能：

```bash
# 1. Configure Codex
export OPENAI_BASE_URL=http://localhost:7024
export OPENAI_API_KEY=rk-xxx

# 2. Simple prompt
codex --model claude-sonnet-4.6 "What is 2+2?"

# 3. Code generation (with shell tool)
codex --model claude-sonnet-4.6 "Create a hello world Python script"

# 4. Interactive session
codex --model claude-sonnet-4.6
```

**Expected:**
- Codex 能正常连接 Raven proxy
- 文本响应正常显示
- Shell 命令执行正常（function calling）
- 流式输出实时显示

---

## Commit Summary

| # | Phase | Message | Tests | Status |
|---|-------|---------|-------|--------|
| 1 | Types | `feat(proxy): add OpenAI Responses API types` | G1 | ⬜ |
| 2 | Types | `feat(proxy): add OpenAI Responses API streaming event types` | G1 | ⬜ |
| 3 | Request | `feat(proxy): implement Responses → OpenAI request translation` | +12 L1 | ⬜ |
| 4 | Request | `feat(proxy): add Responses request validation and edge cases` | +8 L1 | ⬜ |
| 5 | Response | `feat(proxy): implement OpenAI → Responses response translation` | +10 L1 | ⬜ |
| 6 | Handler | `feat(proxy): add /v1/responses route and non-streaming handler` | +6 L1 | ⬜ |
| 7 | Stream | `feat(proxy): implement Responses stream translation (lifecycle)` | +8 L1 | ⬜ |
| 8 | Stream | `feat(proxy): implement Responses stream translation (text)` | +8 L1 | ⬜ |
| 9 | Stream | `feat(proxy): implement Responses stream translation (function calls)` | +10 L1 | ⬜ |
| 10 | Handler | `feat(proxy): implement /v1/responses streaming handler` | +8 L1 | ⬜ |
| 11 | Handler | `feat(proxy): add Responses stream error handling` | +6 L1 | ⬜ |
| 12 | Polish | `feat(proxy): add logging for /v1/responses endpoint` | +4 L1 | ⬜ |
| 13 | Polish | `feat(proxy): add Responses request validation` | +6 L1 | ⬜ |

**Total: 13 commits, +86 tests**

---

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| 53 种 SSE 事件难以完全实现 | Codex 可能依赖未实现事件 | Medium | 先实现核心 12 种，按需扩展；监控 Codex 日志 |
| SSE 格式差异导致客户端解析失败 | Codex 无法工作 | Low | 严格遵循 `event:\ndata:\n\n` 格式；参考 OpenAI 官方响应 |
| `previous_response_id` 不支持 | 多轮对话失效 | High | 文档说明限制；Codex 每次都发完整上下文，影响可能较小 |
| 上游 Copilot 模型不支持某些功能 | 请求失败 | Low | 透传错误，不做特殊处理；用户可换模型 |
| 流式响应中断处理不当 | 客户端卡住 | Medium | 实现 response.failed 事件；设置超时 |

---

## Future Work

1. **`previous_response_id` 支持**
   - 新增 SQLite 表 `responses` 存储响应历史
   - 实现响应链接和上下文恢复
   - 考虑 TTL 和存储清理

2. **Reasoning events**
   - `response.reasoning_text.delta` 等事件
   - 需要上游支持 reasoning 输出

3. **更多内置工具代理**
   - `web_search` → Tavily 集成
   - `file_search` → 本地向量存储
   - `code_interpreter` → 沙箱执行

4. **Batch API**
   - `/v1/responses` 批量模式
   - 需要任务队列和异步处理

5. **Responses API for Custom Upstreams**
   - 支持路由到自定义 OpenAI 格式上游
   - 复用现有 upstream-router 机制

---

## References

- [OpenAI Responses API Migration Guide](https://developers.openai.com/api/docs/guides/migrate-to-responses/)
- [Responses API Streaming Events](https://community.openai.com/t/responses-api-streaming-the-simple-guide-to-events/1363122)
- [Codex CLI Local LLM Support Issue](https://github.com/openai/codex/issues/26)
- [LiteLLM Responses API](https://docs.litellm.ai/docs/providers/openai/responses_api)
