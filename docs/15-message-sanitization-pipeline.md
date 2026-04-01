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

---

## Implementation Plan

### Commit 1: Add content block filtering

**Files**:
- `packages/proxy/src/routes/messages/non-stream-translation.ts`
  - Add `UNSUPPORTED_CONTENT_TYPES` constant
  - Add `filterContentBlocks()` helper
  - Integrate into `handleAssistantMessage()` and `handleUserMessage()`

**Tests**:
- `packages/proxy/test/translate/content-block-filtering.test.ts`
  - Test each unsupported type is filtered
  - Test supported types are preserved
  - Test mixed content arrays
  - Test edge cases (empty arrays, all filtered, etc.)

### Commit 2: Add block metadata cleaning

**Files**:
- `packages/proxy/src/routes/messages/non-stream-translation.ts`
  - Add `BLOCK_METADATA_TO_STRIP` constant
  - Add `stripBlockMetadata()` helper
  - Call in `filterContentBlocks()`

**Tests**:
- `packages/proxy/test/translate/block-metadata-cleaning.test.ts`
  - Test `cache_control` is stripped from text blocks
  - Test `citations` is stripped from text blocks
  - Test other fields are preserved

### Commit 3: Add tool_use field cleaning

**Files**:
- `packages/proxy/src/routes/messages/non-stream-translation.ts`
  - Add `TOOL_USE_FIELDS_TO_STRIP` constant
  - Add `stripToolUseFields()` helper
  - Call in `handleAssistantMessage()` when processing tool_use

**Tests**:
- `packages/proxy/test/translate/tool-use-cleaning.test.ts`
  - Test `caller` field is stripped
  - Test standard fields preserved (id, name, input)

### Commit 4: Add tool schema cleaning

**Files**:
- `packages/proxy/src/routes/messages/non-stream-translation.ts`
  - Add `TOOL_SCHEMA_FIELDS_TO_STRIP` constant
  - Add `sanitizeToolDefinitions()` function
  - Call in `translateAnthropicToolsToOpenAI()`

**Tests**:
- `packages/proxy/test/translate/tool-schema-cleaning.test.ts`
  - Test each extended field is stripped
  - Test standard fields preserved (name, description, input_schema, type)
  - Test server-side tool detection still works after cleaning

### Commit 5: Integration tests and edge cases

**Files**:
- `packages/proxy/test/translate/sanitization-integration.test.ts`
  - Real Claude Code conversation samples
  - Mixed content with all sanitization rules
  - Verify server-side tool flow unchanged
  - Verify OPT-1/2/3 still work correctly

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

```typescript
// fixtures/claude-code-samples.ts
export const CONVERSATION_WITH_CACHE_CONTROL = { ... }
export const CONVERSATION_WITH_MCP_TOOLS = { ... }
export const CONVERSATION_WITH_TOOL_SEARCH = { ... }
export const CONVERSATION_WITH_THINKING = { ... }
export const CONVERSATION_WITH_WEB_SEARCH = { ... }
```

---

## Rollout

### Phase 1: 默认启用

所有清洗规则默认启用，因为它们只过滤 Copilot 不支持的内容。

### Phase 2: 可配置 (可选)

如果需要调试，可以添加配置项禁用特定规则：

| 配置项 | 默认值 | 描述 |
|--------|--------|------|
| `opt_filter_unsupported_blocks` | `true` | Rule 1 |
| `opt_strip_block_metadata` | `true` | Rule 2 |
| `opt_strip_tool_use_fields` | `true` | Rule 3 |
| `opt_strip_tool_schema_fields` | `true` | Rule 4 |

---

## References

- [Claude Code Source Analysis](#) — 本项目 reference/claude-code 分析
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create)
