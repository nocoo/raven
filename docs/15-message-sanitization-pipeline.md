# 15 - Message Sanitization for Copilot Compatibility

## Overview

Claude Code CLI 发送的 Anthropic 格式消息包含多种 Copilot API 不支持的字段和 block 类型。本文档设计一套清洗逻辑，在翻译过程中过滤掉不兼容的内容，确保请求不会因 400 Bad Request 而失败。

## Background

### 问题来源

从 Claude Code 源码分析，以下字段/类型会出现在请求中但 Copilot 不支持：

| 类别 | 字段/类型 | 来源 |
|------|-----------|------|
| **Content Block Types** | `server_tool_use`, `mcp_tool_use`, `mcp_tool_result`, `tool_reference`, `thinking`, `redacted_thinking`, `web_search_tool_result`, `web_fetch_tool_result`, `code_execution_tool_result`, `bash_code_execution_tool_result`, `text_editor_code_execution_tool_result`, `container_upload`, `connector_text`, `search_result`, `citations`, `citation` | Claude Code 历史消息 |
| **Block Metadata** | `cache_control`, `citations` (on text blocks) | Claude Code caching |
| **Message Metadata** | `cache_control` (on message level) | Claude Code caching |
| **Tool Use Fields** | `caller` (tool search beta) | Tool search feature |
| **Tool Schema Fields** | `cache_control`, `defer_loading`, `strict`, `eager_input_streaming` | Claude Code tool definitions |

### 当前实现状态

Raven 已实现部分清洗逻辑：

| 功能 | 状态 | 位置 |
|------|------|------|
| OPT-1: 清理孤儿 `tool_result` | ✅ | `non-stream-translation.ts` |
| OPT-2: 重排 `tool_result` 顺序 | ✅ | `non-stream-translation.ts` |
| OPT-3: 过滤空白 streaming chunks | ✅ | `stream-translation.ts` |
| Thinking block → text 合并 | ✅ | `handleAssistantMessage()` |
| Server-side tool 识别 | ✅ | `isServerSideTool()` |
| Server-side tool 拦截执行 | ✅ | `handler.ts` (web_search) |

**缺失**：
- Anthropic-only content block types 过滤
- Block/message level metadata 清理
- Tool schema 扩展字段清理

---

## Design

### 设计原则

1. **效率优先** — 单次遍历完成所有清洗，避免多层管道的重复遍历
2. **可测试** — 每个清洗规则独立可测，95%+ 覆盖率
3. **不破坏现有功能** — Server-side tool 处理流程不受影响
4. **类型安全** — 使用 TypeScript 严格类型检查

### 架构

不采用多层管道模式，而是在翻译过程中**内联清洗**：

```
┌─────────────────────────────────────────────────────────────────┐
│ translateToOpenAI(payload)                                      │
│                                                                 │
│  1. sanitizeToolDefinitions(payload.tools)  // 清理 tool schema │
│  2. translateAnthropicMessagesToOpenAI()                        │
│     └─ handleAssistantMessage()                                 │
│        └─ filterContentBlocks() // 过滤不支持的 block types     │
│     └─ handleUserMessage()                                      │
│        └─ filterContentBlocks() // 过滤不支持的 block types     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 清洗规则

#### Rule 1: Content Block Type Filtering

过滤不被 OpenAI/Copilot 支持的 content block types。

**支持的类型 (allowlist)**:
- `text` — 保留
- `image` — 保留（翻译为 `image_url`）
- `tool_use` — 保留（翻译为 `tool_calls`）
- `tool_result` — 保留（翻译为 `tool` message）
- `thinking` — 保留（合并到 text content）

**过滤的类型 (blocklist)**:
```typescript
const UNSUPPORTED_CONTENT_TYPES = new Set([
  // Server-side tool related
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  // MCP related
  "mcp_tool_use",
  "mcp_tool_result",
  // Tool search beta
  "tool_reference",
  // Extended thinking (opaque)
  "redacted_thinking",
  // Container/connector
  "container_upload",
  "connector_text",
  // Search/citations
  "search_result",
  "citations",
  "citation",
])
```

**实现位置**: `filterContentBlocks()` helper，在 `handleAssistantMessage()` 和 `handleUserMessage()` 中调用。

#### Rule 2: Block Metadata Cleaning

清理 content block 上的 Anthropic-only metadata：

```typescript
const BLOCK_METADATA_TO_STRIP = ["cache_control", "citations"]

function stripBlockMetadata(block: AnthropicContentBlock): void {
  for (const field of BLOCK_METADATA_TO_STRIP) {
    delete (block as any)[field]
  }
}
```

**实现位置**: 在 `filterContentBlocks()` 中对保留的 block 执行。

#### Rule 3: Tool Use Field Cleaning

清理 `tool_use` block 上的扩展字段：

```typescript
const TOOL_USE_FIELDS_TO_STRIP = ["caller"]  // tool search beta

function stripToolUseFields(block: AnthropicToolUseBlock): void {
  for (const field of TOOL_USE_FIELDS_TO_STRIP) {
    delete (block as any)[field]
  }
}
```

**实现位置**: 在 `handleAssistantMessage()` 处理 `tool_use` blocks 时。

#### Rule 4: Tool Schema Cleaning

清理 tool definition 上的 Anthropic-only 字段：

```typescript
const TOOL_SCHEMA_FIELDS_TO_STRIP = [
  "cache_control",
  "defer_loading",
  "strict",
  "eager_input_streaming",
]

function sanitizeToolDefinitions(tools: AnthropicTool[]): void {
  for (const tool of tools) {
    for (const field of TOOL_SCHEMA_FIELDS_TO_STRIP) {
      delete (tool as any)[field]
    }
  }
}
```

**实现位置**: `translateAnthropicToolsToOpenAI()` 开始时调用。

#### Rule 5: Empty Message Dropping

当 assistant message 的所有 content blocks 都被过滤后，整条消息应该被丢弃，避免产生空的 assistant turn：

```typescript
// In handleAssistantMessage()
const filteredContent = filterContentBlocks(message.content)

// If all content was filtered out, drop the entire message
if (filteredContent.length === 0) {
  return []  // Drop the message
}
```

**触发场景**: 历史消息仅包含 `server_tool_use` + `web_search_tool_result` + `redacted_thinking`，全部被过滤后不应留下空 assistant message。

---

## Implementation

### 文件结构

```
packages/proxy/src/routes/messages/non-stream-translation.ts
  - UNSUPPORTED_CONTENT_TYPES        # 不支持的 content block types
  - BLOCK_METADATA_TO_STRIP          # 需要清理的 block metadata
  - TOOL_USE_FIELDS_TO_STRIP         # 需要清理的 tool_use 扩展字段
  - TOOL_SCHEMA_FIELDS_TO_STRIP      # 需要清理的 tool schema 字段
  - filterContentBlocks()            # 过滤 + 清理 metadata
  - stripBlockMetadata()             # 清理 block metadata
  - stripToolUseFields()             # 清理 tool_use 扩展字段
  - sanitizeToolDefinitions()        # 清理 tool schema

packages/proxy/test/translate/sanitization.test.ts
  - filterContentBlocks tests        # 覆盖所有 15 种不支持类型
  - stripBlockMetadata tests         # cache_control, citations
  - stripToolUseFields tests         # caller
  - sanitizeToolDefinitions tests    # 4 种 tool schema 字段
  - translateToOpenAI integration    # 端到端集成测试
```

### 测试覆盖

| 测试类别 | 测试数量 | 覆盖内容 |
|----------|----------|----------|
| Content block filtering | 12 | 所有 15 种不支持类型 |
| Block metadata | 5 | cache_control, citations |
| Tool use fields | 3 | caller |
| Tool schema fields | 7 | 所有 4 种扩展字段 |
| Integration | 10 | 端到端、server-side tool 兼容 |
| **Total** | **37** | |

**覆盖率**: 92.5% lines（阈值 90%）

---

## Server-Side Tool Compatibility

**重要**: Server-side tool 处理流程必须不受影响。

### 检测点保护

`isServerSideTool()` 在 tool schema cleaning 之前被调用：

```typescript
function translateAnthropicToolsToOpenAI(tools) {
  const serverSideToolNames: string[] = []
  
  for (const tool of tools) {
    // 1. 先检测 server-side tool (需要 type 字段)
    if (isServerSideTool(tool)) {
      serverSideToolNames.push(tool.name)
    }
    
    // 2. 再清理 schema (不影响检测结果)
    sanitizeToolDefinitions([tool])
    
    // 3. 翻译
    ...
  }
}
```

### 响应保护

Handler 生成的 `server_tool_use` 和 `web_search_tool_result` blocks 是**输出**，不经过翻译清洗，直接返回给客户端。

---

## Testing Strategy

### Coverage Target: 95%+

| 测试文件 | 覆盖内容 |
|----------|----------|
| `content-block-filtering.test.ts` | Rule 1 所有 block types |
| `block-metadata-cleaning.test.ts` | Rule 2 所有 metadata fields |
| `tool-use-cleaning.test.ts` | Rule 3 tool_use 扩展字段 |
| `tool-schema-cleaning.test.ts` | Rule 4 tool schema 字段 |
| `sanitization-integration.test.ts` | 端到端集成 |
| `server-tools-*.test.ts` | 现有测试确保不 break |

### Test Fixtures

创建真实的 Claude Code 消息样本：

---

## Rollout

所有清洗规则**默认启用且无配置开关**，因为它们只过滤 Copilot 不支持的内容，不需要关闭。

---

## References

- Claude Code 源码分析 — `/Users/nocoo/workspace/reference/claude-code`
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create)
