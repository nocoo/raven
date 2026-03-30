# Multi-Key Management — 设计文档

## 概述

当前 Raven 使用单一 `RAVEN_API_KEY` 环境变量做认证，无法区分不同客户端、无法追踪各 key 用量、无法通过 UI 管理 key 生命周期。本文档设计数据库持久化的多 key 管理系统：key 存 SQLite、Dashboard 提供 CRUD UI 和连接指南、Proxy 负责验证和归因。

**目标：**
- 数据库存储多个 API key（SHA-256 hashed）
- Dashboard 页面管理 key（创建、列表、撤销、删除）+ 连接信息页（URL、端口、协议、代码示例，一键复制）
- Proxy 验证 key 并将请求归因到具体 key
- 向后兼容 `RAVEN_API_KEY` 环境变量

---

## 一、数据库

### `api_keys` 表

在现有 `bun:sqlite` 数据库 `data/raven.db` 中新增表：

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,          -- ULID（复用现有 generateId）
  name         TEXT NOT NULL,             -- 人类可读标签，如 "cursor-mbp"
  key_hash     TEXT NOT NULL UNIQUE,      -- SHA-256 hex，完整 key 的哈希
  key_prefix   TEXT NOT NULL,             -- 前 12 字符 "rk-a1b2c3d4"，用于 UI 展示
  created_at   INTEGER NOT NULL,          -- unix ms
  last_used_at INTEGER,                   -- unix ms，每次验证成功时更新
  revoked_at   INTEGER                    -- unix ms，null = 活跃
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
```

**设计决策：**
- `key_hash` UNIQUE 约束防碰撞
- `revoked_at` 用 timestamp 而非 boolean，可追溯撤销时间
- 不存完整 key — 只在创建时一次性返回
- SHA-256 hash 后做 DB lookup，不需要 timing-safe compare（hash 是单向的）

### Key 格式

`rk-` + 64 hex chars = 67 chars total（256 bit 安全性）

```
rk-a1b2c3d4e5f6789012345678901234567890123456789012345678901234ab
```

### 新文件：`packages/proxy/src/db/keys.ts`

遵循 `db/requests.ts` 的模式（initXxx + 查询函数）：

| 函数 | 说明 |
|------|------|
| `initApiKeys(db)` | CREATE TABLE + INDEX |
| `createApiKey(db, name)` | 生成 key → hash → 插入 → 返回 `{ key, record }` |
| `validateApiKey(db, rawKey)` | hash lookup → 检查未 revoke → 更新 `last_used_at` → 返回 `ApiKeyPublic \| null` |
| `listApiKeys(db)` | 返回所有 key（不含 hash） |
| `revokeApiKey(db, id)` | 设置 `revoked_at` |
| `deleteApiKey(db, id)` | 硬删除 |

hash 使用 `Bun.CryptoHasher("sha256")`。

### 修改：`packages/proxy/src/index.ts`

在 `initDatabase(db)` 后添加 `initApiKeys(db)` 调用。

---

## 二、Proxy 认证中间件

### 修改：`packages/proxy/src/middleware.ts`

> **Updated by doc 09 (Unified Auth).** `multiKeyAuth` has been split into `apiKeyAuth` + `dashboardAuth`.

用 `apiKeyAuth` 和 `dashboardAuth` 替换 `multiKeyAuth`。在 Hono `ContextVariableMap` 中新增 `keyName: string`。

**AI 路由验证流程（`apiKeyAuth` — 无 dev mode）：**

```
请求进入
  ↓
Bearer token 解析
  ↓
1. rk- 前缀: DB hash lookup → 匹配且未 revoke → 放行，keyName = key.name
                              → 不匹配 → 401（不 fallback 到 env）
2. 其他 token: timing-safe compare vs RAVEN_API_KEY → 匹配 → 放行，keyName = "env:default"
                                                    → 不匹配 → 401
3. RAVEN_INTERNAL_KEY 不接受 → 401
```

**管理路由验证流程（`dashboardAuth` — bootstrap dev mode）：**

```
请求进入
  ↓
Dev mode? (!envApiKey && !internalKey && 无 active DB key) → 放行，keyName = "dev"
  ↓ 否
Bearer token 解析 → 同 apiKeyAuth + 额外接受 RAVEN_INTERNAL_KEY (keyName = "internal")
```

**关键点：**
- `rk-` 前缀的 key 只走 DB 路径，绝不 fallback 到 env
- 非 `rk-` 的 token 只走 env 路径（保持向后兼容）
- `getActiveKeyCount()` 用 30s TTL 缓存，排除 revoked keys 防止自锁

### 修改：`packages/proxy/src/app.ts`

AI 路由使用 `apiKeyAuth({ db, envApiKey: apiKey })`，管理路由使用 `dashboardAuth({ db, envApiKey: apiKey, internalKey })`。见 doc 09。

---

## 三、请求归因

### 修改：`packages/proxy/src/routes/chat.ts`

1. `LogParams` 新增 `accountName?: string`
2. `StreamContext` 新增 `accountName?: string`
3. `logRequest` 中 `account_name: params.accountName ?? "default"`
4. 所有调用 `logRequest` 的地方传入 `accountName: c.get("keyName")`
5. `handleStreamPassthrough` 的 `ctx` 参数增加 `accountName`

### 修改：`packages/proxy/src/routes/messages.ts`

同 `chat.ts` 的修改：
1. `LogParams` 新增 `accountName?: string`
2. `StreamContext` 新增 `accountName?: string`
3. `logRequest` 中使用 `params.accountName`
4. 所有调用点传入 `c.get("keyName")`

---

## 四、Key CRUD API

### 新文件：`packages/proxy/src/routes/keys.ts`

遵循现有 factory 模式 `createKeysRoute(db) → Hono`：

| Method | Path | 行为 | 响应 |
|--------|------|------|------|
| GET | `/keys` | 列出所有 key | `ApiKeyPublic[]` |
| POST | `/keys` | 创建 key（body: `{ name }` ） | `{ key, ...ApiKeyPublic }`，201 |
| POST | `/keys/:id/revoke` | 软撤销 | `{ ok: true }` |
| DELETE | `/keys/:id` | 硬删除 | `{ ok: true }` |

校验：name 必填、≤ 64 字符、trim 空白。

### 修改：`packages/proxy/src/app.ts`

新增 `app.route("/api", createKeysRoute(db))`。

---

## 五、Dashboard

### 5.1 Proxy 通信

**修改：`packages/dashboard/src/lib/proxy.ts`**

```typescript
const API_KEY = process.env.RAVEN_INTERNAL_KEY ?? process.env.RAVEN_API_KEY ?? "";
```

新增 `RAVEN_INTERNAL_KEY` 作为 dashboard→proxy 专用管理凭证，fallback 到 `RAVEN_API_KEY` 保持兼容。Proxy 原生读取 `RAVEN_INTERNAL_KEY`（见 doc 09），`dashboardAuth` 接受它作为 Bearer token。Dashboard 走 env var timing-safe 路径，不走 DB key 路径。

### 5.2 Types

**修改：`packages/dashboard/src/lib/types.ts`**

```typescript
export interface ApiKeyPublic {
  id: string;
  name: string;
  key_prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface ApiKeyCreated extends ApiKeyPublic {
  key: string; // 完整 key，仅创建时返回
}
```

### 5.3 BFF API Routes

遵循 `src/app/api/requests/route.ts` 的模式：

| 新文件 | 透传到 Proxy |
|--------|-------------|
| `src/app/api/keys/route.ts` | GET + POST → `/api/keys` |
| `src/app/api/keys/[id]/revoke/route.ts` | POST → `/api/keys/:id/revoke` |
| `src/app/api/keys/[id]/route.ts` | DELETE → `/api/keys/:id` |

### 5.4 新增 shadcn 组件

```bash
cd packages/dashboard && npx shadcn@latest add dialog input label
```

### 5.5 Connect 页面（连接信息 + Key 管理）

路由：`/connect`，Sidebar 标签 "Connect"，图标 `Cable`。

页面分两大区：上半部分是连接信息，下半部分是 Key 管理。

#### 区域一：Connection Info

展示 proxy 的连接信息，所有值可一键复制。数据来源：proxy 新增 `/api/connection-info` 端点（返回 base URL、端口、支持的协议和模型列表），dashboard 通过 BFF 透传。

**信息卡片区（grid 布局，复用现有 `InfoRow` 风格）：**

| 字段 | 示例值 | 说明 |
|------|--------|------|
| Base URL | `http://localhost:7024` | 一键复制 |
| OpenAI Endpoint | `http://localhost:7024/v1/chat/completions` | 一键复制 |
| Anthropic Endpoint | `http://localhost:7024/v1/messages` | 一键复制 |
| Models Endpoint | `http://localhost:7024/v1/models` | 一键复制 |

**代码示例区（tab 切换，每个 tab 内有复制按钮）：**

| Tab | 内容 |
|-----|------|
| curl | `curl` 命令示例（streaming chat completion） |
| Python | `openai` SDK 示例（`base_url` 指向 proxy） |
| TypeScript | `@anthropic-ai/sdk` 示例（`baseURL` 指向 proxy） |
| Claude Code | `claude --api-key rk-... --api-base-url http://...` 配置说明 |

代码示例中的 API key 占位符 `rk-...`，如果用户已有 active key 则自动填入第一个 active key 的 `key_prefix...`。

**可用模型列表：** 展示 proxy 支持的所有模型（从 `/v1/models` 获取），每个模型名可一键复制。用 badge/chip 样式排列。

#### 区域二：API Keys

同原 5.5 设计：

**新文件：`src/app/connect/page.tsx`** — Server Component

并行 fetch 两个数据源：
```typescript
const [keysResult, connResult] = await Promise.all([
  safeFetch<ApiKeyPublic[]>("/api/keys"),
  safeFetch<ConnectionInfo>("/api/connection-info"),
]);
```

**新文件：`src/app/connect/connect-content.tsx`** — Client Component

**Key 管理 UI：**
- Section 标题 "API Keys" + 右侧 "Create Key" 按钮
- 表格列：Name | Key（`key_prefix...`）| Created | Last Used | Status | Actions
- Status：Active（green badge）/ Revoked（red badge）
- Actions：Revoke 按钮（active keys）、Delete 按钮（revoked keys）

**创建 Key 对话框流程：**
1. 用户点击 "Create Key" → Dialog 弹出，输入 name
2. POST `/api/keys` → 返回完整 key
3. Dialog 切换到 success 状态：显示完整 key + 复制按钮 + 警告 "This key will not be shown again"
4. 关闭 dialog → `router.refresh()` 刷新表格

### 5.6 Proxy 新增端点：`/api/connection-info`

**修改：`packages/proxy/src/routes/` 新增或扩展**

```typescript
// GET /api/connection-info
{
  base_url: "http://localhost:7024",   // 从 config.port 构建
  endpoints: {
    chat_completions: "/v1/chat/completions",
    messages: "/v1/messages",
    models: "/v1/models",
  },
  models: ["claude-sonnet-4-20250514", "gpt-4o", ...],  // 从 models.ts 导出
}
```

### 5.7 Sidebar

**修改：`packages/dashboard/src/components/layout/sidebar.tsx`**

在 `NAV_ITEMS` 中 Models 和 Copilot Models 之间插入：

```typescript
{ href: "/connect", label: "Connect", icon: Cable },
```

### 5.8 复制功能组件

**新文件：`src/components/copy-button.tsx`**

通用的复制按钮组件，点击后 `navigator.clipboard.writeText()` + 短暂 "Copied!" 反馈（图标从 `Copy` 切换到 `Check`，1.5s 后恢复）。在 Connect 页面的各个可复制元素中复用。

**新文件：`src/components/code-block.tsx`**

带语法高亮（可选）的代码块组件，右上角内嵌 `CopyButton`。用于代码示例区。

---

## 六、向后兼容

**零破坏性：**
- `RAVEN_API_KEY` 继续生效（走 env timing-safe 路径），同时用于 AI API 鉴权和 e2e 测试
- Dashboard 通过 `RAVEN_INTERNAL_KEY ?? RAVEN_API_KEY` 访问 proxy `/api/*` 端点
- AI 路由（`/v1/*`, `/chat/*`, `/embeddings`）始终需要认证，无 dev mode（见 doc 09）
- 管理路由（`/api/*`）的 dev mode 仅在首次启动（无任何 key）时激活（见 doc 09）
- 设置了 `RAVEN_API_KEY` 但 DB 无 key 时，仅 env 路径可用（不会裸奔）
- `/api/*` 管理端点受 `dashboardAuth` 保护
- 现有 `requests` 表数据 `account_name` 保持 "default"，新请求写入实际 key name
- 无需数据迁移
- E2E 测试通过 `RAVEN_API_KEY` 环境变量获取 token

---

## 七、原子化提交

| # | Commit | 文件 |
|---|--------|------|
| 1 | ✅ `feat: add api_keys database schema and query functions` | `db/keys.ts` |
| 2 | ✅ `feat: replace single-key auth with multi-key middleware` | `middleware.ts` |
| 3 | ✅ `feat: add key-based request attribution` | `chat.ts`, `messages.ts` |
| 4 | ✅ `feat: add key management and connection-info api routes` | `routes/keys.ts`, `routes/connection-info.ts`, `app.ts`, `index.ts` |
| 5 | ✅ `test: add unit tests for key management` | `test/unit/db/keys.test.ts`, `test/unit/middleware.test.ts` |
| 6 | ✅ `feat: add connect page with connection info and key management` | dashboard 全部文件（page, content, BFF routes, sidebar, components, types, shadcn） |

---

## 八、验证

1. **单元测试**：`bun run test` — 218 tests 通过，覆盖 multiKeyAuth 三条路径、key CRUD、route 鉴权
2. **E2E 测试**：`RAVEN_API_KEY=<key> bun run test:e2e` — 通过 env key 鉴权访问 proxy
3. **手动验证**：
   - 启动 proxy（设置 `RAVEN_API_KEY`）→ 通过 dashboard 创建 DB key → curl 用新 key 请求 → 验证 `account_name` 正确
   - 撤销 key → 验证返回 401
   - `RAVEN_API_KEY` 仍能正常使用（env:default 路径）
   - 无 key 配置时 dev mode 仍生效
   - Connect 页面：所有 URL 可复制、代码示例正确、模型列表显示
