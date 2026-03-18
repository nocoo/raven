# 10 — Request Optimizations

可配置的请求优化项集合。每项解决一个已知的 Copilot API 兼容性问题，通过 Settings 页面的 "Optimizations" 区域逐一开关。

**来源**：对同上游（`api.githubcopilot.com`）的 mai-agents 项目进行调研，提取其在微软大规模使用中验证过的 bugfix/workaround。仅保留与 Raven 共享同一上游且 Raven 尚未处理的项。

---

## 已有能力（无需重复）

调研中确认 Raven 已经处理了以下问题，不纳入优化项：

| 问题 | Raven 现状 |
|------|-----------|
| `Copilot-Vision-Request` header | ✅ `create-chat-completions.ts:13-17` 检测 `image_url` 并加 header |
| `cache_read_input_tokens` bridge | ✅ `stream-translation.ts:44-52,160-168` + `non-stream-translation.ts:315-324` 三处均有映射 |
| Anthropic headers 不泄漏 | ✅ `copilotHeaders()` 构造全新 header 集，不 passthrough 入站 headers |

---

## 优化项定义

### OPT-1: Sanitize Orphaned Tool Results

**问题**：Claude Code 的 auto-compaction 可能删掉 `assistant` 消息中的 `tool_use` block，但保留后续 `user` 消息中对应的 `tool_result` block。翻译为 OpenAI 格式后，产生一个 `role: "tool"` 消息引用了不存在的 `tool_call_id`，上游返回 400。

**现状**：`non-stream-translation.ts:89-123` 的 `handleUserMessage()` 直接将所有 `tool_result` 转为 `role: "tool"` 消息，不校验 `tool_use_id` 是否存在。

**修复逻辑**：
1. 在 `translateToOpenAI()` 开始时，扫描所有 `assistant` 消息，收集全部 `tool_use` block 的 `id` 到 `Set<string>`
2. 在 `handleUserMessage()` 处理 `tool_result` 时，检查 `block.tool_use_id` 是否在集合中
3. 不在集合中的 `tool_result` 直接 drop，记录 debug 日志

**涉及文件**：
- `packages/proxy/src/routes/messages/non-stream-translation.ts` — 添加清理逻辑

### OPT-2: Reorder Tool Results

**问题**：Anthropic 协议中，用户可以在单条 `user` 消息中以任意顺序返回 parallel tool calls 的结果。但 Copilot API（OpenAI 格式）要求 `role: "tool"` 消息的顺序严格匹配前一个 `assistant` 消息中 `tool_calls` 数组的顺序。顺序不一致会导致上游 400 或结果错配。

**现状**：`non-stream-translation.ts:93-108` 按 `tool_result` 在原始 content 数组中出现的顺序逐一 push，未做排序。

**修复逻辑**：
1. 在 `handleUserMessage()` 中，当遇到 `tool_result` 块时，查找前一条 `assistant` 消息的 `tool_calls` 数组
2. 按 `tool_calls` 中 `id` 的出现顺序对 `tool_result` 块排序
3. 找不到匹配 `tool_call_id` 的结果放在末尾（防御性）

**涉及文件**：
- `packages/proxy/src/routes/messages/non-stream-translation.ts` — 添加排序逻辑

### OPT-3: Filter Whitespace-Only Streaming Chunks

**问题**：OpenAI → Anthropic 的流式翻译过程中，上游可能发来纯空白 `delta.content`（如 `" "` 或 `"\n"`）。这些翻译为 `content_block_delta` 后，在某些客户端（如 VS Code Copilot 扩展）中渲染出多余的空行。

**现状**：`stream-translation.ts:59` 用 `if (delta.content)` 做 truthy 检查，过滤了 `null`/`undefined`/`""`，但 `" "` 和 `"\n"` 是 truthy 值，会正常通过并产生 delta 事件。

**修复逻辑**：
1. 在 `translateChunkToAnthropicEvents()` 中，当 `delta.content` 存在时增加 `.trim()` 检查
2. 仅过滤同时满足以下三个条件的 chunk：
   - `content.trim() === ""`（纯空白）
   - 没有 `tool_calls`
   - 没有 `finish_reason`
3. fail-open：任何判断异常都 pass through，不阻断流

**涉及文件**：
- `packages/proxy/src/routes/messages/stream-translation.ts` — 添加过滤条件

---

## 设计方案

### 数据层

复用现有 `settings` 表（key-value store）。优化项使用 `opt_` 前缀的 key：

| DB Key | Value | Default |
|--------|-------|---------|
| `opt_sanitize_orphaned_tool_results` | `"true"` / `"false"` | `"false"` |
| `opt_reorder_tool_results` | `"true"` / `"false"` | `"false"` |
| `opt_filter_whitespace_chunks` | `"true"` / `"false"` | `"false"` |

### Proxy State

在 `State` 接口中新增字段，启动时和设置变更时从 DB 加载：

```typescript
// packages/proxy/src/lib/state.ts
export interface State {
  // ... existing fields ...

  // Request optimizations (default: all false)
  optSanitizeOrphanedToolResults: boolean
  optReorderToolResults: boolean
  optFilterWhitespaceChunks: boolean
}
```

### API 层

扩展 `/api/settings` 路由：

- `GET /api/settings` 响应新增 `optimizations` 字段：
  ```json
  {
    "vscode_version": { ... },
    "copilot_chat_version": { ... },
    "optimizations": {
      "sanitize_orphaned_tool_results": { "enabled": false, "key": "opt_sanitize_orphaned_tool_results" },
      "reorder_tool_results": { "enabled": false, "key": "opt_reorder_tool_results" },
      "filter_whitespace_chunks": { "enabled": false, "key": "opt_filter_whitespace_chunks" }
    }
  }
  ```

- `PUT /api/settings` 扩展 validation：`opt_` 前缀的 key 只允许 `"true"` / `"false"` 值（不走 semver 校验）
- `DELETE /api/settings/:key` 已支持通用删除，无需改动

### Dashboard UI

在 Settings 页面的 "Version Overrides" section 下方，新增 "Optimizations" section：

```
┌─────────────────────────────────────────────────────────────┐
│ Settings                                                     │
│                                                              │
│ Version Overrides                                            │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ VS Code Version    [Override]  [1.104.3]               │ │
│ │ ├── input + save + reset                                │ │
│ │ Copilot Chat Version [Local]  [0.28.2]                 │ │
│ │ ├── input + save + reset                                │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                              │
│ Optimizations                                                │
│ Protocol-level fixes from upstream compatibility research.   │
│ Enable individually as needed.                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ○ Sanitize Orphaned Tool Results                    OFF │ │
│ │   Drop tool_result blocks referencing non-existent      │ │
│ │   tool_use IDs after client-side compaction.            │ │
│ ├─────────────────────────────────────────────────────────┤ │
│ │ ○ Reorder Tool Results                              OFF │ │
│ │   Reorder parallel tool results to match the            │ │
│ │   tool_calls array order expected by upstream.          │ │
│ ├─────────────────────────────────────────────────────────┤ │
│ │ ○ Filter Whitespace-Only Chunks                     OFF │ │
│ │   Skip streaming chunks with whitespace-only content    │ │
│ │   that cause blank lines in some clients.               │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**UI 组件**：每个优化项使用 Switch（toggle）控件，不需要 Input。包含：
- Switch + label（右侧）
- description（下方，`text-muted-foreground`）
- 切换后立即 `PUT /api/settings`，无需额外 Save 按钮

**新组件文件**：`packages/dashboard/src/app/settings/optimizations-content.tsx`

### 扩展性

添加新优化项只需：

1. **定义**：在本文档中新增 `OPT-N` 条目
2. **Proxy state**：`State` 接口加字段 + 默认值
3. **Proxy route**：`OPTIMIZATION_KEYS` 数组加 key
4. **Proxy logic**：在对应位置读取 `state.optXxx` 判断是否启用
5. **Dashboard**：`OPTIMIZATION_ITEMS` 数组加条目（label + description + key）

不需要改 DB schema、API 格式、UI 组件。

---

## 原子化提交计划

### Commit 1: `feat: add optimization settings data layer`

扩展 proxy settings 系统支持 boolean 优化项。

**文件**：
- `packages/proxy/src/lib/state.ts` — 添加 3 个 `opt*` boolean 字段，默认 `false`
- `packages/proxy/src/routes/settings.ts` — 扩展 `KNOWN_KEYS` 加入 `opt_` keys，添加 `OPTIMIZATION_KEYS` 数组，修改 validation 逻辑区分 semver vs boolean，扩展 `getSettingsSnapshot()` 返回 `optimizations` 字段
- `packages/proxy/src/lib/utils.ts` — 在 `cacheVersions()`（或新建 `cacheOptimizations()`）中从 DB 加载 `opt_` keys 到 state

### Commit 2: `feat: add optimizations UI section to settings page`

Dashboard 设置页面新增 Optimizations 区域。

**文件**：
- `packages/dashboard/src/lib/types.ts` — 扩展 `SettingsData` 类型，增加 `optimizations` 字段
- `packages/dashboard/src/app/settings/optimizations-content.tsx` — 新建，Switch toggle 列表组件
- `packages/dashboard/src/app/settings/settings-content.tsx` — 微调，确保两个 section 并列（或由 page.tsx 编排）
- `packages/dashboard/src/app/settings/page.tsx` — 引入 `OptimizationsContent`

### Commit 3: `feat: implement OPT-1 sanitize orphaned tool results`

翻译层添加孤立 tool_result 过滤逻辑。

**文件**：
- `packages/proxy/src/routes/messages/non-stream-translation.ts` — 在 `translateToOpenAI()` 中收集 tool_use IDs，在 `handleUserMessage()` 中过滤孤立 tool_result

### Commit 4: `feat: implement OPT-2 reorder tool results`

翻译层添加 tool result 排序逻辑。

**文件**：
- `packages/proxy/src/routes/messages/non-stream-translation.ts` — 在 `handleUserMessage()` 中按前一个 assistant 的 `tool_calls` 顺序排序

### Commit 5: `feat: implement OPT-3 filter whitespace-only chunks`

流式翻译层添加空白 chunk 过滤。

**文件**：
- `packages/proxy/src/routes/messages/stream-translation.ts` — 在 `translateChunkToAnthropicEvents()` 中增加 whitespace-only + no tool_calls + no finish_reason 的过滤条件

### Commit 6: `test: add tests for request optimizations`

为三个优化项添加单元测试。

**文件**：
- `packages/proxy/test/routes/messages/optimizations.test.ts` — 新建，涵盖：
  - OPT-1：孤立 tool_result 被 drop、正常 tool_result 保留
  - OPT-2：乱序 tool_result 被重排
  - OPT-3：纯空白 chunk 被过滤、正常 content 通过、有 tool_calls 的空白 chunk 通过
  - 各项 disabled 时的 passthrough 行为
