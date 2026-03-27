# 13 — Server-Side Tools

Anthropic server-side tool 的代理拦截与替换。当 Claude Code 发送 `web_search` (type: `web_search_20250305`) 等 server-side tool 时，proxy 不将其发送到 Copilot upstream（会被拒绝返回 502），而是直接拦截并调用第三方 API（Tavily）执行，再将结果注入后续请求。

---

## 背景

### 问题

Claude Code 在 Anthropic API 中使用 server-side tools，如 `web_search`（type: `web_search_20250305`）。这些工具由 Anthropic 服务端执行，客户端只需在 payload 中声明即可。

Raven proxy 将 Anthropic 请求翻译为 OpenAI 格式发给 Copilot API。然而：

1. **Copilot 不认识 `web_search` function tool** — 发送会导致 `502 JSON Parse error: Unexpected EOF`
2. **非流式响应丢失 tool_calls** — Copilot 非流式 API 返回 `finish_reason: "tool_calls"` 但 `message.tool_calls` 为 null
3. **需要替代搜索后端** — Copilot 无法执行 web search，需要第三方 API 替代

### 方案

在 proxy 层完全拦截 server-side tools，透明替换为第三方实现：

- `web_search` → [Tavily Search API](https://tavily.com/)
- 未来可扩展更多 server-side tools

---

## 架构

### Server-Side Tool 识别

`isServerSideTool()` 通过 Anthropic payload 中 tool 的 `type` 字段识别：

```
type: "web_search_20250305"  →  server-side tool  (regex: /^\w+_\d{8}$/)
type: undefined / "custom"   →  client-side tool
```

翻译到 OpenAI 格式后，server-side tool names 保存在 `ExtendedChatCompletionsPayload.serverSideToolNames` 中传递给 handler。

### 两种模式

#### Pure Server-Side Mode

当请求中**所有 tools 都是 server-side**（如 Claude Code 的 WebSearch 子 agent，只有 `web_search` 一个 tool）：

```
Client → Proxy
  1. 提取 user message 作为搜索 query
  2. 直接调用 Tavily API（不发给 Copilot）
  3. 将搜索结果注入为 user message
  4. 发给 Copilot（无 tools）进行综合回答
  5. 返回最终回答给 Client
```

**关键**：不将 `web_search` tool definition 发给 Copilot，避免 502 错误。

#### Mixed Mode

当请求中**既有 client tools 又有 server-side tools**：

```
Client → Proxy
  1. 剥离 server-side tool definitions
  2. 仅用 client tools 发给 Copilot
  3. 如果 Copilot 返回 server-side tool call → 执行 Tavily → 注入结果 → 循环
  4. 如果 Copilot 返回 client tool call → 直接返回给 Client
  5. 如果无 tool call → 返回最终回答
```

最多循环 5 次，防止无限循环。

### 流式内部消费

由于 Copilot 非流式 API 的 `tool_calls` 字段缺失，`handleServerToolLoop` 内部始终使用 `stream: true` 请求 Copilot，然后通过 `consumeStreamToResponse()` 从 SSE delta chunks 中重建完整的 `ChatCompletionResponse`（包括 tool_calls）。

---

## Settings

### Dashboard UI

Settings 页面 "Server Tools" 区域：

| 设置项 | 说明 |
|--------|------|
| Web Search | 启用/禁用 web_search 拦截 |
| Tavily API Key | 用于 web search 的 Tavily API 密钥 |

### State

```typescript
state.stWebSearchEnabled  // boolean, default false
state.stWebSearchApiKey   // string | null
```

通过 `cacheServerToolSettings(db)` 从 SQLite settings 表同步。

---

## Tavily Integration

### API

`searchTavily(apiKey, params)` 封装了 Tavily Search API v2：

- Endpoint: `https://api.tavily.com/search`
- 返回: `WebSearchToolResult { type, content, citations, encrypted_content }`
- 错误处理: `TavilyError` 区分 auth/rate_limit/server 错误类型

### 结果注入

**Pure mode**: 搜索结果作为 user message 注入：
```
[web_search results for "query"]

{tavily content}
```

**Mixed mode**: 搜索结果作为 `role: "tool"` message 注入（OpenAI protocol），附带对应 `tool_call_id`。

---

## 涉及文件

### Proxy

| File | Change |
|------|--------|
| `src/routes/messages/anthropic-types.ts` | `isServerSideTool()` 识别函数 |
| `src/routes/messages/non-stream-translation.ts` | `translateToOpenAI()` 提取 `serverSideToolNames` |
| `src/routes/messages/handler.ts` | `handleServerToolLoop()` + `consumeStreamToResponse()` |
| `src/lib/server-tools/tavily.ts` | Tavily API 封装 |
| `src/lib/state.ts` | `stWebSearchEnabled`, `stWebSearchApiKey` |
| `src/lib/utils.ts` | `cacheServerToolSettings()` |
| `src/routes/settings.ts` | Settings API 扩展 |

### Dashboard

| File | Change |
|------|--------|
| `src/app/settings/server-tools-content.tsx` | Server Tools 设置 UI |
| `src/app/settings/page.tsx` | 集成 Server Tools 区域 |

### Tests

| File | Tests |
|------|-------|
| `test/routes/server-tools-handler.test.ts` | tool detection, tool_choice rewrite, conditions |
| `test/routes/server-tools-consume-stream.test.ts` | `consumeStreamToResponse` stream reassembly |
| `test/routes/server-tools-loop.test.ts` | `handleServerToolLoop` pure/mixed mode integration |
| `test/routes/server-tools-loop-logic.test.ts` | loop logic: iteration, tool call routing |
| `test/routes/server-tools-tavily.test.ts` | Tavily API mock tests |

---

## Status

- [x] Server-side tool 识别 (`isServerSideTool`)
- [x] Tavily API 封装 + 错误处理
- [x] Pure server-side mode (直接拦截，不发 Copilot)
- [x] Mixed mode (剥离 server tools，拦截 tool calls)
- [x] `consumeStreamToResponse` 流式内部消费
- [x] Dashboard Settings UI
- [x] Debug logging (behind `optToolCallDebug`)
- [x] Unit tests (670 pass, 92.6% coverage)
- [x] Live test 验证 (Claude Code WebSearch → Tavily → 成功返回)
