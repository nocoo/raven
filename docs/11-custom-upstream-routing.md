# 11 — Custom Upstream Routing

将特定模型路由到自定义上游 API，而非默认的 GitHub Copilot。解决 Copilot 不认识的模型（如 `glm-5`）返回 502 的问题。

**动机**：Claude Code 启动时可通过 `--model` 指定任意模型名。当该模型不在 Copilot 模型列表中时，上游直接 502。需要一个可配置的路由层，让不同模型走不同的上游 provider。

**已验证**：智谱 API `https://open.bigmodel.cn/api/anthropic/v1/messages` 完全兼容 Anthropic 协议（streaming + non-streaming）。

---

## 现状分析

当前所有请求都通过 `createChatCompletions()` 发往 Copilot：

```
Client → apiKeyAuth → handler
  ├── /v1/messages          → translateToOpenAI → createChatCompletions → translateToAnthropic
  └── /v1/chat/completions  → createChatCompletions (passthrough)
```

**单一上游瓶颈在** `services/copilot/create-chat-completions.ts` — URL、headers、auth 全部硬编码 Copilot。

---

## 路由设计

在 handler 的入口处插入 `resolveProvider(model)` 检查，命中则走自定义通道，否则走原有 Copilot 流程（零侵入）。

```
Client → apiKeyAuth → resolveProvider(model)
  ├── match + provider.format === "anthropic"
  │     └── client = anthropic → PASSTHROUGH（原始 payload 直发，无翻译）
  │     └── client = openai    → 400 error（V1 不做反向翻译）
  ├── match + provider.format === "openai"
  │     └── client = openai    → PASSTHROUGH（原始 payload 直发）
  │     └── client = anthropic → translateToOpenAI → sendOpenAI → translateToAnthropic
  └── no match → Copilot flow（完全不变）
```

### 模型匹配规则（运行时路由）

**两段匹配算法**：先扫全部精确规则，再扫全部 glob 规则，确保精确匹配始终优先于 glob。

```
resolveProvider(model):
  Pass 1 — exact: 遍历所有 provider 的所有 pattern，仅比较 exact（不含 *）
    命中 → 返回
  Pass 2 — glob:  遍历所有 provider 的所有 pattern，仅比较 glob（含 *）
    命中 → 返回
  未命中 → 返回 null（走 Copilot）
```

同一段内多个 provider 都能匹配时，按 `created_at` 升序（先创建的优先）首个生效。`getEnabledProviders()` 查询显式 `ORDER BY created_at ASC`。

**查重规则**（创建/更新 provider 时）：

查重直接查 DB 全量 `listProviders(db)`（含已禁用），不走 `state.providers` 缓存，防止禁用 provider 绕过唯一性约束：

1. 精确模型名（非 glob）不得与 Copilot 已有模型重复（通过 `state.models` 校验）
2. 精确模型名不得与**任何**其他 provider（含禁用）的精确模型名重复
3. Glob 模式不做查重（它们是 fallback，精确匹配两段算法保证优先级）
4. 查重不通过时返回 400 + 明确告知冲突的模型名和所属 provider

### V1 限制

OpenAI 格式客户端 → Anthropic 格式 provider 返回 400 + 引导消息。原因：反向翻译（OpenAI → Anthropic payload）复杂度高，V1 不做。

---

## 数据层

### 新表：`providers`

```sql
CREATE TABLE IF NOT EXISTS providers (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  format         TEXT NOT NULL CHECK(format IN ('openai', 'anthropic')),
  api_key        TEXT NOT NULL,
  model_patterns TEXT NOT NULL DEFAULT '[]',
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
```

| Column | 说明 |
|--------|------|
| `id` | ULID-like（与 `db/keys.ts` 相同的生成方式） |
| `name` | 人类可读标签，如 "Zhipu GLM" |
| `base_url` | Provider 根路径，如 `https://open.bigmodel.cn/api/anthropic` |
| `format` | `"openai"` 或 `"anthropic"` — 决定请求路径和头部 |
| `api_key` | 明文存储（个人工具，与 `github_token` 同等安全等级） |
| `model_patterns` | JSON 数组 `["glm-5", "glm-*"]` |
| `enabled` | 0/1，允许快速禁用而不删除 |

API 返回时 `toPublic()` 将 `api_key` 脱敏为前 8 字符 + `...****`，Dashboard 永远看不到完整 key。

### 类型定义

```typescript
// packages/proxy/src/db/providers.ts

export type ProviderFormat = "openai" | "anthropic"

export interface ProviderRecord {
  id: string
  name: string
  base_url: string
  format: ProviderFormat
  api_key: string
  model_patterns: string   // JSON array
  enabled: number          // 0 | 1
  created_at: number
  updated_at: number
}

export interface ProviderPublic {
  id: string
  name: string
  base_url: string
  format: ProviderFormat
  api_key_preview: string  // "6b69d7c2...****"
  model_patterns: string[]
  is_enabled: boolean
  created_at: number
  updated_at: number
}

export interface CreateProviderInput {
  name: string
  base_url: string
  format: ProviderFormat
  api_key: string
  model_patterns: string[]
  is_enabled?: boolean
}

export interface UpdateProviderInput {
  name?: string
  base_url?: string
  format?: ProviderFormat
  api_key?: string
  model_patterns?: string[]
  is_enabled?: boolean
}
```

### CRUD 函数

```typescript
export function initProviders(db: Database): void
export function createProvider(db: Database, input: CreateProviderInput): ProviderPublic
export function listProviders(db: Database): ProviderPublic[]
export function getProvider(db: Database, id: string): ProviderPublic | null
export function updateProvider(db: Database, id: string, input: UpdateProviderInput): ProviderPublic | null
export function deleteProvider(db: Database, id: string): boolean
export function getEnabledProviders(db: Database): ProviderRecord[]  // ORDER BY created_at ASC，含原始 api_key
```

**模式**：完全跟随 `db/keys.ts` — types → schema → init → helpers → CRUD。

**涉及文件**：
- 新建 `packages/proxy/src/db/providers.ts`

---

## State 扩展

```typescript
// packages/proxy/src/lib/state.ts
import type { ProviderRecord } from "~/db/providers"

export interface State {
  // ... existing fields ...
  providers: ProviderRecord[]  // 缓存已启用的 provider 记录
}

export const state: State = {
  // ... existing defaults ...
  providers: [],
}
```

新增缓存函数（与 `cacheVersions()`、`cacheOptimizations()` 同级）：

```typescript
// packages/proxy/src/lib/utils.ts
export function cacheProviders(db: Database): void {
  state.providers = getEnabledProviders(db)
}
```

启动时调用：

```typescript
// packages/proxy/src/index.ts — 在 initSettings(db) 之后
initProviders(db)

// 在 cacheOptimizations(db) 之后
cacheProviders(db)
```

**涉及文件**：
- 修改 `packages/proxy/src/lib/state.ts` — 加 `providers` 字段
- 修改 `packages/proxy/src/lib/utils.ts` — 加 `cacheProviders()`
- 修改 `packages/proxy/src/index.ts` — 加 init + cache 调用

---

## 路由解析器

```typescript
// packages/proxy/src/lib/upstream-router.ts

export interface ResolvedProvider {
  provider: ProviderRecord
  matchedPattern: string
}

/**
 * 两段匹配：先扫精确规则，再扫 glob 规则，确保 exact 始终优先于 glob。
 * 返回 null 表示走默认 Copilot。
 */
export function resolveProvider(model: string): ResolvedProvider | null {
  // Pass 1: exact match only
  for (const provider of state.providers) {
    const patterns: string[] = JSON.parse(provider.model_patterns)
    for (const pattern of patterns) {
      if (!pattern.includes("*") && model === pattern) {
        return { provider, matchedPattern: pattern }
      }
    }
  }

  // Pass 2: glob match only
  for (const provider of state.providers) {
    const patterns: string[] = JSON.parse(provider.model_patterns)
    for (const pattern of patterns) {
      if (pattern.endsWith("*") && model.startsWith(pattern.slice(0, -1))) {
        return { provider, matchedPattern: pattern }
      }
    }
  }

  return null
}
```

**设计选择**：
- 两段匹配保证精确规则始终优先于 glob，不受 provider 插入顺序和 pattern 数组顺序影响
- 纯函数，读取 `state.providers`（已由 `cacheProviders()` 预加载），无 DB 访问
- `state.providers` 为空时（默认）直接返回 `null`，所有现有测试不受影响

**涉及文件**：
- 新建 `packages/proxy/src/lib/upstream-router.ts`

---

## 上游调用服务

### Anthropic 直发

```typescript
// packages/proxy/src/services/upstream/send-anthropic.ts

export async function sendAnthropicDirect(
  provider: ProviderRecord,
  payload: AnthropicMessagesPayload,
): Promise<AnthropicResponse | AsyncGenerator<ServerSentEvent>> {
  const url = `${provider.base_url.replace(/\/$/, "")}/v1/messages`
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.api_key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    // throw 携带上游状态码的错误，用于日志记录
  }

  return payload.stream ? events(response) : await response.json()
}
```

### OpenAI 直发

```typescript
// packages/proxy/src/services/upstream/send-openai.ts

export async function sendOpenAIDirect(
  provider: ProviderRecord,
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionResponse | AsyncGenerator<ServerSentEvent>> {
  const url = `${provider.base_url.replace(/\/$/, "")}/v1/chat/completions`
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${provider.api_key}`,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) { /* throw */ }

  return payload.stream ? events(response) : await response.json()
}
```

**关键差异**：
| | Anthropic | OpenAI |
|---|---|---|
| URL 路径 | `/v1/messages` | `/v1/chat/completions` |
| 认证头 | `x-api-key` | `Authorization: Bearer` |
| 额外头 | `anthropic-version: 2023-06-01` | — |
| SSE 解析 | 相同 `events()` | 相同 `events()` |

**涉及文件**：
- 新建 `packages/proxy/src/services/upstream/send-anthropic.ts`
- 新建 `packages/proxy/src/services/upstream/send-openai.ts`

---

## Handler 集成

### `/v1/messages` handler（Anthropic 格式客户端）

在 `routes/messages/handler.ts` 的 `handleCompletion()` 中，`translateToOpenAI()` 之前插入路由检查：

```typescript
// packages/proxy/src/routes/messages/handler.ts

import { resolveProvider } from "~/lib/upstream-router"
import { sendAnthropicDirect } from "~/services/upstream/send-anthropic"
import { sendOpenAIDirect } from "~/services/upstream/send-openai"

export async function handleCompletion(c: Context) {
  // ... existing: startTime, requestId, rateLimit, parse payload, derive identity ...

  const resolved = resolveProvider(model)

  if (resolved) {
    const { provider } = resolved

    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_start", requestId,
      msg: `POST /v1/messages ${model} → ${provider.name}`,
      data: {
        path: "/v1/messages", format: "anthropic", model, stream,
        provider: provider.name, providerFormat: provider.format,
        matchedPattern: resolved.matchedPattern,
        accountName, sessionId, clientName, clientVersion,
      },
    })

    if (provider.format === "anthropic") {
      // PASSTHROUGH: Anthropic → Anthropic provider（零翻译）
      return handleAnthropicPassthrough(c, provider, anthropicPayload, { startTime, requestId, model, stream, ... })
    } else {
      // TRANSLATE: Anthropic → OpenAI provider（复用现有翻译）
      const openAIPayload = translateToOpenAI(anthropicPayload)
      return handleProviderOpenAI(c, provider, openAIPayload, { startTime, requestId, model, stream, ... })
    }
  }

  // --- 以下为现有 Copilot 流程，完全不变 ---
  logEmitter.emitLog({ ... }) // existing request_start
  const openAIPayload = translateToOpenAI(anthropicPayload)
  const response = await createChatCompletions(openAIPayload)
  // ...
}
```

#### `handleAnthropicPassthrough()`（Anthropic → Anthropic）

```typescript
async function handleAnthropicPassthrough(c, provider, payload, meta) {
  try {
    const response = await sendAnthropicDirect(provider, payload)

    if (!payload.stream) {
      // 非流式：response 是 AnthropicResponse，直接返回
      const anthropicResponse = response as AnthropicResponse
      // 提取 usage，记录 request_end
      return c.json(anthropicResponse)
    }

    // 流式：response 是 SSE 事件生成器，逐事件透传
    return streamSSE(c, async (sseStream) => {
      for await (const event of response) {
        await sseStream.writeSSE({
          event: event.event ?? undefined,
          data: event.data,
        })
        // 从 event.data 提取 usage/metrics 用于日志
      }
      // finally: log request_end
    })
  } catch (error) {
    // log request_end with error
    throw error
  }
}
```

#### `handleProviderOpenAI()`（Anthropic → translate → OpenAI provider）

复用现有的 `translateToOpenAI()` + `translateToAnthropic()` / `translateChunkToAnthropicEvents()`，仅替换 `createChatCompletions()` 为 `sendOpenAIDirect()`。

### `/v1/chat/completions` handler（OpenAI 格式客户端）

在 `routes/chat-completions/handler.ts` 中同理：

```typescript
const resolved = resolveProvider(model)

if (resolved) {
  const { provider } = resolved

  if (provider.format === "openai") {
    // PASSTHROUGH: OpenAI → OpenAI provider
    return handleProviderOpenAIPassthrough(c, provider, payload, meta)
  } else {
    // V1: OpenAI → Anthropic provider 不支持
    return c.json({
      error: {
        message: `Model "${model}" routes to "${provider.name}" (Anthropic format). Use /v1/messages endpoint instead.`,
        type: "invalid_request_error",
      },
    }, 400)
  }
}
```

### 日志集成

log event `data` 新增两个可选字段：

```typescript
{
  // ... existing fields ...
  provider?: string        // provider.name，Copilot 时为 undefined
  providerFormat?: string  // provider.format，Copilot 时为 undefined
}
```

`request-sink.ts` 已有的字段映射忽略未知 key，所以 **不需要改 DB schema**。这些字段会出现在 terminal 日志和 WebSocket 实时流中。

**涉及文件**：
- 修改 `packages/proxy/src/routes/messages/handler.ts` — 加路由检查 + passthrough/translate 函数
- 修改 `packages/proxy/src/routes/chat-completions/handler.ts` — 加路由检查 + passthrough/400

---

## 管理 API

### Proxy 路由

```typescript
// packages/proxy/src/routes/providers.ts

export function createProvidersRoute(db: Database): Hono {
  const route = new Hono()

  route.get("/providers", ...)         // 列表（masked api_key）
  route.get("/providers/:id", ...)     // 单条
  route.post("/providers", ...)        // 创建（校验 + 模型查重）
  route.put("/providers/:id", ...)     // 部分更新（校验 + 模型查重）
  route.delete("/providers/:id", ...)  // 硬删除

  return route
}
```

所有写操作后调用 `cacheProviders(db)` 刷新内存缓存。

**字段校验**：
- `name`：非空
- `base_url`：非空 + `new URL()` 通过
- `format`：必须是 `"openai"` 或 `"anthropic"`
- `api_key`：非空
- `model_patterns`：非空数组

**模型查重逻辑**（在 `POST` 和 `PUT` 中执行，查 DB 全量含禁用）：

```typescript
function validateModelPatterns(
  db: Database,
  patterns: string[],
  excludeProviderId?: string,  // 更新时排除自身
): { ok: true } | { ok: false; error: string } {
  const exactModels = patterns.filter((p) => !p.includes("*"))

  // 1. 与 Copilot 模型查重
  const copilotIds = new Set(state.models?.data.map((m) => m.id) ?? [])
  for (const model of exactModels) {
    if (copilotIds.has(model)) {
      return { ok: false, error: `Model "${model}" already exists in Copilot` }
    }
  }

  // 2. 与所有 provider（含禁用）的精确模型名查重，查 DB 全量
  const allProviders = listProviders(db)
  const otherProviders = allProviders.filter((p) => p.id !== excludeProviderId)
  for (const other of otherProviders) {
    const otherExact = other.model_patterns.filter((p) => !p.includes("*"))
    for (const model of exactModels) {
      if (otherExact.includes(model)) {
        return { ok: false, error: `Model "${model}" already claimed by provider "${other.name}"` }
      }
    }
  }

  return { ok: true }
}
```

### App 接入

```typescript
// packages/proxy/src/app.ts
import { createProvidersRoute } from "./routes/providers"

app.route("/api", createProvidersRoute(db))
```

### Dashboard 透传路由

遵循现有 thin-proxy 模式（与 `api/keys/` 相同）：

```
packages/dashboard/src/app/api/providers/route.ts       → GET, POST
packages/dashboard/src/app/api/providers/[id]/route.ts   → PUT, DELETE
```

### Dashboard 类型

```typescript
// packages/dashboard/src/lib/types.ts — 新增
export type ProviderFormat = "openai" | "anthropic"

export interface ProviderPublic {
  id: string
  name: string
  base_url: string
  format: ProviderFormat
  api_key_preview: string
  model_patterns: string[]
  is_enabled: boolean
  created_at: number
  updated_at: number
}
```

**涉及文件**：
- 新建 `packages/proxy/src/routes/providers.ts`
- 修改 `packages/proxy/src/app.ts` — 挂载路由
- 新建 `packages/dashboard/src/app/api/providers/route.ts`
- 新建 `packages/dashboard/src/app/api/providers/[id]/route.ts`
- 修改 `packages/dashboard/src/lib/types.ts` — 加类型

---

## Dashboard UI

### 侧边栏导航

在 Copilot 组和 Settings 组之间新增独立的 **Providers** 组：

```typescript
// packages/dashboard/src/components/layout/sidebar.tsx
import { Blocks } from "lucide-react"

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Monitor",
    defaultOpen: true,
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/logs", label: "Logs", icon: Terminal },
      { href: "/models", label: "Models", icon: Boxes },
    ],
  },
  {
    label: "Copilot",
    defaultOpen: true,
    items: [
      { href: "/copilot/models", label: "Models", icon: Cpu },
      { href: "/copilot/account", label: "Account", icon: CircleUser },
    ],
  },
  {                                         // ← 新增
    label: "Providers",
    defaultOpen: true,
    items: [
      { href: "/providers", label: "AI Providers", icon: Blocks },
    ],
  },
  {
    label: "Settings",
    defaultOpen: true,
    items: [
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/connect", label: "Connect", icon: Cable },
    ],
  },
]
```

### 新页面：`/providers`

```
packages/dashboard/src/app/providers/page.tsx             — RSC 入口
packages/dashboard/src/app/providers/providers-content.tsx — Client 组件
```

#### RSC 页面

```typescript
// page.tsx — 跟随 settings/page.tsx 模式
export default async function ProvidersPage() {
  const result = await safeFetch<ProviderPublic[]>("/api/providers")
  // error → <FetchError>
  // success → <ProvidersContent providers={result.data} />
}
```

#### Client 组件

**页面结构**：

```
┌─────────────────────────────────────────────────────────────┐
│ AI Providers                                    [+ Add]     │
│ Route specific models to custom API providers.              │
│                                                             │
│ ┌─ Provider Card ──────────────────────────────────────┐    │
│ │ Zhipu GLM                         [Enabled] ✏️ 🗑️  │    │
│ │ https://open.bigmodel.cn/api/anthropic               │    │
│ │ Format: Anthropic    Key: 6b69d7c2...****            │    │
│ │                                                      │    │
│ │ Models:  [glm-5] [glm-*]                            │    │
│ └──────────────────────────────────────────────────────┘    │
│                                                             │
│ ┌─ Provider Card ──────────────────────────────────────┐    │
│ │ DeepSeek                           [Enabled] ✏️ 🗑️  │    │
│ │ https://api.deepseek.com                             │    │
│ │ Format: OpenAI       Key: sk-1234...****             │    │
│ │                                                      │    │
│ │ Models:  [deepseek-chat] [deepseek-reasoner]         │    │
│ └──────────────────────────────────────────────────────┘    │
│                                                             │
│ ┌─ empty state ────────────────────────────────────────┐    │
│ │ No providers configured.                             │    │
│ │ Add a provider to route models to custom APIs.       │    │
│ └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

每个 Provider 以卡片形式展示（而非表格行），信息密度更高，多个 provider 视觉分隔清晰。

**创建对话框**：
- Name（text input，required）
- Base URL（text input，required，URL 校验）
- Format（select：OpenAI Compatible / Anthropic Compatible）
- API Key（password input，required）
- Model Patterns（text input，逗号分隔 → 存为数组，提交时触发查重校验）
- Enabled（switch，default on）

**查重反馈**：提交时如果后端返回 400 + 模型冲突信息，在 Model Patterns 字段下方显示红色错误提示（如 `Model "claude-sonnet-4" already exists in Copilot`）。

**编辑对话框**：同上字段，API Key 显示 placeholder "Enter new key to change"（仅修改时提交）。

**UI 组件**：复用项目已有的 shadcn 组件（Dialog, Button, Input, Select, Switch, Badge）。

### `/v1/models` 扩展 + max_tokens 处理

Provider 模型注入 `/v1/models` 列表，但**不进入 `state.models`**。这意味着：

- Copilot 模型：`state.models` 有完整 capabilities，handler 会自动补齐 `max_tokens`
- Provider 模型：不在 `state.models` 中，handler **不会**自动补齐 `max_tokens`

**这是正确的行为**：provider 的上游 API 各自有不同的 token 上限策略，Raven 不应替上游做假设。客户端（如 Claude Code）应自行设置 `max_tokens`，或由上游 API 按自身默认值处理。

在 `routes/models/route.ts` 中注入时，provider 模型使用简化的 model 对象（不含 capabilities）：

```typescript
const providerModels = state.providers.flatMap((p) => {
  const patterns = JSON.parse(p.model_patterns) as string[]
  return patterns
    .filter((pat) => !pat.includes("*"))
    .map((modelId) => ({
      id: modelId,
      object: "model",
      type: "model",
      created: 0,
      created_at: new Date(0).toISOString(),
      owned_by: p.name,
      display_name: modelId,
    }))
})
// 去重：Copilot 模型优先（查重规则已保证不会重复，此处仅防御性处理）
const copilotIds = new Set(models?.map((m) => m.id) ?? [])
const extraModels = providerModels.filter((m) => !copilotIds.has(m.id))
```

**涉及文件**：
- 新建 `packages/dashboard/src/app/providers/page.tsx`
- 新建 `packages/dashboard/src/app/providers/providers-content.tsx`
- 修改 `packages/dashboard/src/components/layout/sidebar.tsx` — 加 Providers 导航组
- 修改 `packages/proxy/src/routes/models/route.ts` — 注入 provider 模型

---

## 原子化提交计划

### Commit 1: `feat(proxy): add providers database layer`

- 新建 `db/providers.ts`（schema + CRUD）
- 修改 `state.ts`（加 `providers` 字段）
- 修改 `utils.ts`（加 `cacheProviders()`）
- 修改 `index.ts`（init + cache）
- 新建 `test/db/providers.test.ts`（~20 tests）

### Commit 2: `feat(proxy): add upstream router and fetch services`

- 新建 `lib/upstream-router.ts`
- 新建 `services/upstream/send-anthropic.ts`
- 新建 `services/upstream/send-openai.ts`
- 新建 `test/lib/upstream-router.test.ts`（~15 tests）
- 新建 `test/services/upstream/send-anthropic.test.ts`（~8 tests）
- 新建 `test/services/upstream/send-openai.test.ts`（~8 tests）

### Commit 3: `feat(proxy): integrate provider routing into handlers`

- 修改 `routes/messages/handler.ts`（加路由 + passthrough + translate）
- 修改 `routes/chat-completions/handler.ts`（加路由 + passthrough + 400）
- 新建 `test/routes/messages-handler-upstream.test.ts`（~20 tests）
- 新建 `test/routes/completions-handler-upstream.test.ts`（~12 tests）

### Commit 4: `feat(proxy): add providers management API with model dedup`

- 新建 `routes/providers.ts`（CRUD 路由 + 模型查重）
- 修改 `app.ts`（挂载）
- 新建 `test/routes/providers.test.ts`（~22 tests，含查重场景）

### Commit 5: `feat(dashboard): add providers page`

- Dashboard API 透传路由
- Dashboard 类型
- Providers 页面 + Client 组件
- 侧边栏导航
- Dashboard 测试（~8 tests）

### Commit 6: `feat(proxy): inject provider models into /v1/models`

- 修改 `routes/models/route.ts`

---

## 测试策略

### L1 — 单元测试（~120 new tests）

| 模块 | 测试文件 | 预估 |
|------|----------|------|
| DB CRUD | `test/db/providers.test.ts` | ~20 |
| 路由解析 | `test/lib/upstream-router.test.ts` | ~15 |
| Anthropic 直发 | `test/services/upstream/send-anthropic.test.ts` | ~8 |
| OpenAI 直发 | `test/services/upstream/send-openai.test.ts` | ~8 |
| Messages handler | `test/routes/messages-handler-upstream.test.ts` | ~20 |
| Completions handler | `test/routes/completions-handler-upstream.test.ts` | ~12 |
| 管理 API + 查重 | `test/routes/providers.test.ts` | ~22 |
| Dashboard API | `test/api/providers-routes.test.ts` | ~8 |

**关键不变量**：`state.providers` 默认为 `[]`，`resolveProvider()` 返回 `null`，所有现有 495+ tests 零修改通过。

### L2 — E2E 验证（手动）

1. 启动 proxy → Dashboard → Providers
2. 添加 provider：name="Zhipu GLM", base_url=`https://open.bigmodel.cn/api/anthropic`, format=anthropic, patterns=`["glm-5"]`
3. `curl POST localhost:7024/v1/messages` with `model: "glm-5"` → 验证响应
4. 同上但 `stream: true` → 验证 SSE 事件正确透传
5. `model: "claude-sonnet-4"` → 仍走 Copilot（回归）
6. 尝试添加 `model: "claude-sonnet-4"` 到新 provider → 400 查重拒绝
7. 添加第二个 provider（如 DeepSeek）→ 验证多 provider 路由

### G1 — 静态分析

所有新文件通过 `eslint` + `tsc --noEmit`，pre-commit hook 自动覆盖。

---

## 示例配置

### 智谱 GLM（Anthropic 兼容）

```json
{
  "name": "Zhipu GLM",
  "base_url": "https://open.bigmodel.cn/api/anthropic",
  "format": "anthropic",
  "api_key": "6b69d7c250824791b6a4a4e96f7f6f6a.yGkynhsFJyaxtkds",
  "model_patterns": ["glm-5", "glm-*"],
  "is_enabled": true
}
```

请求流：
1. Claude Code 发送 `model: "glm-5"` 到 `POST /v1/messages`
2. `resolveProvider("glm-5")` → 命中 "Zhipu GLM"（精确匹配 `"glm-5"`）
3. provider.format === "anthropic" && 客户端格式 === anthropic → **PASSTHROUGH**
4. 直发原始 Anthropic payload 到 `https://open.bigmodel.cn/api/anthropic/v1/messages`
5. 设置 `x-api-key` header
6. 响应直接透传回客户端（零翻译损耗）

### DeepSeek（OpenAI 兼容）

```json
{
  "name": "DeepSeek",
  "base_url": "https://api.deepseek.com",
  "format": "openai",
  "api_key": "sk-...",
  "model_patterns": ["deepseek-chat", "deepseek-reasoner"],
  "is_enabled": true
}
```

请求流（从 Anthropic 格式客户端）：
1. Claude Code 发送 `model: "deepseek-chat"` 到 `POST /v1/messages`
2. `resolveProvider("deepseek-chat")` → 命中 "DeepSeek"
3. provider.format === "openai" && 客户端格式 === anthropic → **TRANSLATE**
4. `translateToOpenAI()` → `sendOpenAIDirect()` 发到 `https://api.deepseek.com/v1/chat/completions`
5. 响应经 `translateToAnthropic()` / `translateChunkToAnthropicEvents()` 翻译回 Anthropic 格式
