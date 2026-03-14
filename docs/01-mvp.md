# Raven — MVP 设计文档

## 概述

Raven 是一个 GitHub Copilot 代理服务，结合 copilot-api（能工作但复杂）和 auth2api（极简但不支持 Copilot）的优势，提供稳定、简洁的代理，并附带基于 basalt 设计系统的 Dashboard 进行数据统计。

**核心定位：** 简洁稳定的 GitHub Copilot → OpenAI/Anthropic API 代理 + 数据统计仪表盘

**MVP 范围：** 单 GitHub 账号。多账号支持为 post-MVP 功能。

---

## 一、架构设计

### 整体架构：Bun Workspace Monorepo（双进程）

```
┌─────────────────┐         ┌───────────────┐         ┌──────────────────────┐
│  Claude Code /   │  HTTP   │               │  HTTP   │                      │
│  OpenAI 客户端   ├────────►│  Proxy        ├─────────►│ api.githubcopilot.com│
│                  │◄────────┤  (Bun + Hono) │◄─────────┤                      │
└─────────────────┘         │  :8080        │          └──────────────────────┘
                            │               │
                            │  ┌──────────┐ │
                            │  │ SQLite   │ │
                            │  │ 请求日志  │ │
                            │  └──────────┘ │
                            └───────┬───────┘
                                    │ HTTP API
                                    │ /api/stats/*
                                    │ /api/requests
                            ┌───────┴───────┐
                            │  Dashboard    │
                            │  (Next.js)    │
                            │  :7020        │
                            └───────────────┘
```

> **数据访问路径：** Dashboard 通过 Proxy 的 HTTP API 获取数据，不直接访问 SQLite 文件。
> 这避免了多进程写锁竞争，也便于未来拆服务或换存储。

### 项目结构

```
raven/
├── packages/
│   ├── proxy/                      # Bun + Hono, port 8080
│   │   ├── src/
│   │   │   ├── index.ts            # 入口：启动 server + 初始化 token
│   │   │   ├── config.ts           # env + 默认值
│   │   │   ├── copilot/
│   │   │   │   ├── auth.ts         # GitHub device flow 登录
│   │   │   │   ├── token.ts        # 双层 token 管理
│   │   │   │   ├── client.ts       # 调用 Copilot API
│   │   │   │   ├── headers.ts      # VS Code 伪装 headers
│   │   │   │   └── vscode.ts       # 获取 VS Code 版本号
│   │   │   ├── translate/
│   │   │   │   ├── anthropic-to-openai.ts
│   │   │   │   ├── openai-to-anthropic.ts
│   │   │   │   ├── stream.ts       # 流式翻译状态机
│   │   │   │   └── types.ts
│   │   │   ├── routes/
│   │   │   │   ├── messages.ts     # POST /v1/messages
│   │   │   │   ├── chat.ts         # POST /v1/chat/completions
│   │   │   │   ├── models.ts       # GET /v1/models
│   │   │   │   ├── stats.ts        # GET /api/stats/*
│   │   │   │   └── requests.ts     # GET /api/requests (筛选/排序/分页)
│   │   │   ├── middleware.ts       # API key 认证 + 请求上下文 (request ID, start time)
│   │   │   ├── db/
│   │   │   │   ├── sqlite.ts       # bun:sqlite 初始化
│   │   │   │   ├── schema.ts       # 建表
│   │   │   │   └── requests.ts     # 请求日志 CRUD + 统计
│   │   │   └── util/
│   │   │       ├── sse.ts          # 手工 SSE parser
│   │   │       └── logger.ts       # 结构化日志
│   │   ├── test/                   # 单元测试
│   │   ├── data/                   # SQLite 数据 (gitignored)
│   │   └── package.json
│   │
│   └── dashboard/                  # Next.js + basalt 设计系统, port 7020
│       ├── src/
│       │   ├── app/
│       │   │   ├── layout.tsx      # Root layout (basalt tokens)
│       │   │   ├── globals.css     # basalt 3-tier luminance
│       │   │   ├── page.tsx        # Dashboard 首页
│       │   │   ├── requests/       # 请求日志列表
│       │   │   └── models/         # 模型统计
│       │   ├── components/
│       │   │   ├── ui/             # shadcn/ui (从 surety 复制)
│       │   │   ├── layout/         # AppShell, Sidebar, ThemeToggle
│       │   │   └── charts/         # Recharts 图表组件
│       │   └── lib/
│       │       ├── utils.ts        # cn()
│       │       ├── palette.ts      # 24 色图表调色板
│       │       └── chart-config.ts # Recharts 统一配置
│       ├── test/                   # 单元测试
│       └── package.json
│
├── docs/
│   ├── README.md                   # 文档索引
│   └── 01-mvp.md                   # 本文档
├── package.json                    # workspace root
├── CHANGELOG.md
└── README.md
```

---

## 二、核心模块设计

### 2.1 Copilot Token 管理 (`proxy/src/copilot/`)

双层 token 系统，参考 copilot-api 但更简洁：

**Layer 1 — GitHub OAuth Token（持久化）**
- 通过 GitHub device flow 获取
- 持久化到 `data/github_token`
- 关键参数：
  - Client ID: `Iv1.b507a08c87ecfe98`
  - Scopes: `read:user`
  - Device flow: `POST https://github.com/login/device/code` → 用户输入 code → 轮询 `POST https://github.com/login/oauth/access_token`

**Layer 2 — Copilot Session JWT（短期，自动刷新）**
- 通过 `GET https://api.github.com/copilot_internal/v2/token` 获取
- 返回 `{ token, expires_at, refresh_in }`
- 自动刷新定时器：`(refresh_in - 60) * 1000` ms
- 仅保存在内存中

**VS Code 伪装 Headers**
```typescript
{
  "authorization": "Bearer <copilot-jwt>",
  "editor-version": "vscode/<动态获取版本>",
  "editor-plugin-version": "copilot-chat/0.26.7",
  "user-agent": "GitHubCopilotChat/0.26.7",
  "copilot-integration-id": "vscode-chat",
  "openai-intent": "conversation-panel",
  "x-github-api-version": "2025-04-01",
  "x-request-id": "<uuid>",
  "x-vscode-user-agent-library-version": "electron-fetch"
}
```

**代码参考：**
- `copilot-api/src/lib/api-config.ts` — headers 定义、Copilot base URL
- `copilot-api/src/lib/token.ts` — 双层 token refresh 逻辑
- `copilot-api/src/services/github/get-device-code.ts` — device flow step 1
- `copilot-api/src/services/github/poll-access-token.ts` — device flow step 2
- `copilot-api/src/services/github/get-copilot-token.ts` — Copilot JWT 获取

### 2.2 Anthropic ↔ OpenAI 翻译 (`proxy/src/translate/`)

**核心复杂度所在**。从 copilot-api 精简而来。

#### 请求翻译 (Anthropic → OpenAI)

| Anthropic 格式 | OpenAI 格式 |
|---|---|
| `system` (string \| TextBlock[]) | `{ role: "system", content: "..." }` |
| `messages[].content` (tool_result) | `{ role: "tool", tool_call_id, content }` |
| `messages[].content` (tool_use) | `{ role: "assistant", tool_calls: [...] }` |
| `messages[].content` (thinking) | 合并到 text content |
| `messages[].content` (image) | `{ type: "image_url", image_url: { url: "data:..." } }` |
| `tools[]` (Anthropic schema) | `tools[]` (OpenAI function schema) |
| `tool_choice.type: "auto"` | `"auto"` |
| `tool_choice.type: "any"` | `"required"` |
| `tool_choice.type: "tool"` | `{ type: "function", function: { name } }` |
| model name `claude-sonnet-4-XXXX` | `claude-sonnet-4` (去掉子版本) |

#### 响应翻译 (OpenAI → Anthropic)

| OpenAI 格式 | Anthropic 格式 |
|---|---|
| `choices[0].message.content` | `content: [{ type: "text", text }]` |
| `choices[0].message.tool_calls` | `content: [{ type: "tool_use", id, name, input }]` |
| `finish_reason: "stop"` | `stop_reason: "end_turn"` |
| `finish_reason: "length"` | `stop_reason: "max_tokens"` |
| `finish_reason: "tool_calls"` | `stop_reason: "tool_use"` |
| `usage.prompt_tokens` | `usage.input_tokens` (减去 cached_tokens) |
| `usage.prompt_tokens_details.cached_tokens` | `usage.cache_read_input_tokens` |

#### 流式翻译状态机

```
StreamState {
  messageStartSent: boolean       // 是否已发 message_start
  contentBlockIndex: number       // 当前 content block 索引
  contentBlockOpen: boolean       // 当前是否有 block 打开
  toolCalls: Record<number, {     // OpenAI tool_call index → Anthropic block info
    id: string
    name: string
    blockIndex: number
  }>
}
```

**事件映射流程：**
1. 首个 chunk → `message_start` (含 input_tokens 和 cache_read_input_tokens)
2. `delta.content` → 如果 tool block 打开则先 `content_block_stop` → `content_block_start(text)` + `content_block_delta(text_delta)`
3. `delta.tool_calls` (新 tool) → 关闭前一个 block → `content_block_start(tool_use)` + `content_block_delta(input_json_delta)`
4. `delta.tool_calls` (续参数) → `content_block_delta(input_json_delta)`
5. `finish_reason` → `content_block_stop` + `message_delta(stop_reason)` + `message_stop`

**代码参考：**
- `copilot-api/src/routes/messages/non-stream-translation.ts` — 完整双向翻译 (357行，可精简)
- `copilot-api/src/routes/messages/stream-translation.ts` — 流式状态机 (191行，核心逻辑)
- `copilot-api/src/routes/messages/anthropic-types.ts` — Anthropic 类型定义

### 2.3 请求日志数据库 (`proxy/src/db/`)

使用 `bun:sqlite`，WAL 模式，参考 surety 的 DB pattern。

```sql
-- 请求日志表
CREATE TABLE IF NOT EXISTS requests (
  id              TEXT PRIMARY KEY,      -- ULID (时间排序)
  timestamp       INTEGER NOT NULL,      -- unix ms
  path            TEXT NOT NULL,         -- "/v1/messages" | "/v1/chat/completions"
  client_format   TEXT NOT NULL,         -- "anthropic" | "openai"
  model           TEXT NOT NULL,         -- 请求的 model
  resolved_model  TEXT,                  -- 上游返回的 model
  stream          INTEGER NOT NULL,      -- 0 | 1
  input_tokens    INTEGER,              -- 输入 token 数
  output_tokens   INTEGER,              -- 输出 token 数
  latency_ms      INTEGER NOT NULL,     -- 总耗时
  ttft_ms         INTEGER,              -- 首 token 时间 (仅流式)
  status          TEXT NOT NULL,         -- "success" | "error"
  status_code     INTEGER NOT NULL,     -- 返回给客户端的 HTTP 状态码
  upstream_status INTEGER,              -- 上游状态码
  error_message   TEXT,                 -- 错误信息
  account_name    TEXT NOT NULL DEFAULT 'default'  -- MVP 固定为 GitHub username 或 "default"
);

CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
```

**数据库初始化参考：**
- `surety/src/db/index.ts` — Bun/Node 双运行时 SQLite 初始化、WAL 模式
- `surety/src/db/schema.ts` — Drizzle ORM schema 定义模式

**MVP 阶段不用 Drizzle ORM，直接用 `bun:sqlite` 裸 SQL**，保持极简。

**日志采集职责划分：**
- **middleware**：API key 验证、注入请求上下文（request ID、start time）
- **route handler**（`messages.ts`、`chat.ts`）：在拿到完整上游响应后调用 `db.insertRequest()` 写入日志
- **流式场景**：在 stream 消费完毕的 finally/cleanup 回调中，汇总 `resolved_model`、`usage`、`ttft_ms`、`upstream_status` 后写入

> middleware 无法获取 `resolved_model`、token usage、`ttft_ms` 等数据——这些分散在响应流的不同 chunk 中，只能在 route/client 层采集。

### 2.4 统计 API (`proxy/src/routes/stats.ts`)

Dashboard 调用的 JSON 端点：

| 端点 | 用途 |
|---|---|
| `GET /api/stats/overview` | 总请求数、总 token、平均延迟、错误率 |
| `GET /api/stats/timeseries?interval=hour&range=24h` | 按时间聚合的请求量/token/延迟 |
| `GET /api/stats/models` | 各模型使用量、延迟、token |
| `GET /api/stats/recent?limit=50` | 最近 N 条请求日志 |

### 2.5 请求查询 API (`proxy/src/routes/requests.ts`)

正式的请求日志查询接口，支持筛选、排序和分页：

```
GET /api/requests?model=xxx&status=xxx&format=xxx&sort=timestamp&order=desc&cursor=xxx&limit=50
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `model` | string | 按模型筛选 (可选) |
| `status` | string | `"success"` \| `"error"` (可选) |
| `format` | string | `"anthropic"` \| `"openai"` (可选) |
| `sort` | string | `"timestamp"` \| `"latency_ms"` \| `"tokens"` (默认 `"timestamp"`) |
| `order` | string | `"asc"` \| `"desc"` (默认 `"desc"`) |
| `cursor` | string | ULID，用于 cursor-based 分页 (可选) |
| `limit` | number | 每页条数，默认 50，最大 200 |

响应：
```json
{
  "data": [ /* request records */ ],
  "next_cursor": "01JWXYZ...",
  "has_more": true
}
```

> `GET /api/stats/recent?limit=50` 为简化别名，内部复用同一查询逻辑。

### 2.6 Dashboard (`dashboard/`)

**主色调：深色系 (Raven 主题)**，将 surety 的 Vermilion 替换为深蓝/石墨蓝。

**从 surety 直接复用的文件和模式：**

| 文件/模式 | 来源路径 | 说明 |
|---|---|---|
| `globals.css` | `surety/src/app/globals.css` | basalt 3-tier luminance token (改主色调) |
| `layout.tsx` | `surety/src/app/layout.tsx` | Inter + DM Sans, dark mode FOUC 防护 |
| `AppShell` | `surety/src/components/layout/app-shell.tsx` | Sidebar + floating island 布局 |
| `Sidebar` | `surety/src/components/layout/sidebar.tsx` | 可折叠侧边栏 |
| `ThemeToggle` | `surety/src/components/layout/theme-toggle.tsx` | 三态主题切换 |
| `ChartCard` | `surety/src/components/charts/chart-card.tsx` | 图表卡片容器 |
| `palette.ts` | `surety/src/lib/palette.ts` | 24 色图表调色板 |
| `chart-config.ts` | `surety/src/lib/chart-config.ts` | Recharts 统一配置 |
| `utils.ts` | `surety/src/lib/utils.ts` | cn() 工具函数 |
| shadcn/ui 组件 | `surety/src/components/ui/` | Button, Card, Badge, Table, Sheet 等 |

**Dashboard 页面：**

1. **首页 (`/`)** — 概览
   - 4 个 StatCard：总请求数、总 token、平均延迟、错误率
   - 请求量时序图 (AreaChart / BarChart)
   - Token 消耗时序图
   - 错误率趋势

2. **请求日志 (`/requests`)** — 参考 surety 的 policies 表格模式
   - 数据来源：`GET /api/requests` (带筛选/排序/分页)
   - 可筛选：按 model、status、format
   - 可排序：按 timestamp、latency、tokens
   - Cursor-based 分页
   - 详情展开

3. **模型统计 (`/models`)** — 各模型对比
   - 饼图：模型请求占比
   - 柱状图：各模型 token 消耗
   - 表格：延迟 P50/P95/P99

---

## 三、依赖清单

### proxy/package.json

```json
{
  "dependencies": {
    "hono": "^4.x"
  }
}
```

**其余全部手写：**
- `bun:sqlite` — 内置，无需依赖
- SSE 解析 — 手写 ~80 行
- HTTP 调用 — 原生 `fetch`
- ULID — 手写 ~20 行
- 日志 — `console.log` JSON 封装

**1 个运行时依赖。**

### dashboard/package.json

```json
{
  "dependencies": {
    "next": "^16.x",
    "react": "^19.x",
    "react-dom": "^19.x",
    "recharts": "^3.x",
    "radix-ui": "^1.x",
    "lucide-react": "^0.5x",
    "tailwind-merge": "^3.x",
    "clsx": "^2.x",
    "class-variance-authority": "^0.7.x"
  }
}
```

---

## 四、四层测试设计

### 测试架构

| 层 | 内容 | 触发时机 |
|---|---|---|
| **L1 — UT** | 翻译函数、流式状态机、token 管理、DB 查询、ULID 生成、SSE 解析 | pre-commit (覆盖率 ≥ 90%) |
| **L2 — Lint** | TypeScript strict mode, ESLint zero-warning | pre-commit |
| **L3 — API E2E** | 所有 proxy 端点 + stats 端点 (mock upstream) | pre-push |
| **L4 — BDD E2E** | Claude Code 完整对话流程 (需要真实 Copilot token) | 按需 |

### 端口约定

| 服务 | 用途 | 端口 |
|---|---|---|
| Proxy dev | 开发 | 8080 |
| Dashboard dev | 开发 | 7020 |
| Proxy API E2E | L3 测试 | 18080 |
| Dashboard API E2E | L3 测试 | 17020 |

### L1 重点测试对象

**proxy:**
- `translate/anthropic-to-openai.ts` — 所有消息类型转换 (system, text, tool_use, tool_result, thinking, image)
- `translate/openai-to-anthropic.ts` — 响应转换 (text, tool_use, stop_reason, usage)
- `translate/stream.ts` — 流式状态机 (text only, tool only, text+tool 交错, finish_reason)
- `copilot/token.ts` — token 有效性检查、refresh 触发
- `db/requests.ts` — 插入、查询、统计聚合
- `util/sse.ts` — SSE 解析 (完整行、跨 chunk 分割、[DONE])
- `middleware.ts` — API key 验证、timing-safe 比较、请求上下文注入

**dashboard:**
- ViewModel 纯函数 — 数据聚合、格式化

### Husky 配置

```
pre-commit: bun test + bun lint (覆盖率检查 ≥ 90%)
pre-push: bun test:e2e (API E2E)
```

---

## 五、原子化提交计划

### Phase 1 — 项目骨架 (4 commits)

| # | Commit | 文件 |
|---|---|---|
| 1.1 | `init: bun workspace monorepo 初始化` | `package.json`, `packages/proxy/package.json`, `packages/dashboard/package.json`, `tsconfig.json`, `.gitignore` |
| 1.2 | `feat(proxy): Hono server 骨架 + 配置加载` | `packages/proxy/src/index.ts`, `packages/proxy/src/config.ts`, `packages/proxy/src/routes/`, `packages/proxy/test/` |
| 1.3 | `feat(proxy): API key 认证中间件` | `packages/proxy/src/middleware.ts`, `packages/proxy/test/middleware.test.ts` |
| 1.4 | `chore: husky + lint 配置` | `.husky/`, `eslint.config.js`, lint 相关 |

### Phase 2 — Copilot 认证 (3 commits)

| # | Commit | 文件 |
|---|---|---|
| 2.1 | `feat(proxy): GitHub device flow 登录` | `packages/proxy/src/copilot/auth.ts`, `packages/proxy/test/copilot/auth.test.ts` |
| 2.2 | `feat(proxy): 双层 token 管理 + 自动刷新` | `packages/proxy/src/copilot/token.ts`, `packages/proxy/src/copilot/headers.ts`, `packages/proxy/src/copilot/vscode.ts`, `packages/proxy/test/copilot/token.test.ts` |
| 2.3 | `feat(proxy): Copilot API client + OpenAI 直通` | `packages/proxy/src/copilot/client.ts`, `packages/proxy/src/routes/chat.ts`, `packages/proxy/src/routes/models.ts`, `packages/proxy/src/util/sse.ts`, `packages/proxy/test/` |

### Phase 3 — Anthropic 翻译 (3 commits)

| # | Commit | 文件 |
|---|---|---|
| 3.1 | `feat(proxy): Anthropic → OpenAI 请求翻译` | `packages/proxy/src/translate/types.ts`, `packages/proxy/src/translate/anthropic-to-openai.ts`, `packages/proxy/test/translate/` |
| 3.2 | `feat(proxy): OpenAI → Anthropic 响应翻译 (非流式)` | `packages/proxy/src/translate/openai-to-anthropic.ts`, `packages/proxy/test/translate/` |
| 3.3 | `feat(proxy): 流式翻译状态机 + /v1/messages 端点` | `packages/proxy/src/translate/stream.ts`, `packages/proxy/src/routes/messages.ts`, `packages/proxy/test/translate/stream.test.ts` |

### Phase 4 — 数据库 + 统计 (3 commits)

| # | Commit | 文件 |
|---|---|---|
| 4.1 | `feat(proxy): SQLite 请求日志 + 统计查询` | `packages/proxy/src/db/sqlite.ts`, `packages/proxy/src/db/schema.ts`, `packages/proxy/src/db/requests.ts`, `packages/proxy/test/db/` |
| 4.2 | `feat(proxy): route handler 日志采集集成` | `packages/proxy/src/routes/messages.ts`, `packages/proxy/src/routes/chat.ts` — 在响应/流消费完毕后写入 DB |
| 4.3 | `feat(proxy): /api/stats/* + /api/requests 端点` | `packages/proxy/src/routes/stats.ts`, `packages/proxy/src/routes/requests.ts`, `packages/proxy/test/routes/` |

### Phase 5 — Dashboard (4 commits)

| # | Commit | 文件 |
|---|---|---|
| 5.1 | `init(dashboard): Next.js + basalt 设计系统基础` | `packages/dashboard/src/app/layout.tsx`, `packages/dashboard/src/app/globals.css`, `packages/dashboard/src/components/ui/`, `packages/dashboard/src/components/layout/`, `packages/dashboard/src/lib/` |
| 5.2 | `feat(dashboard): 概览首页 (stat cards + 时序图)` | `packages/dashboard/src/app/page.tsx`, `packages/dashboard/src/components/charts/`, 首页 ViewModel |
| 5.3 | `feat(dashboard): 请求日志列表页` | `packages/dashboard/src/app/requests/page.tsx`, 筛选/排序逻辑 |
| 5.4 | `feat(dashboard): 模型统计页` | `packages/dashboard/src/app/models/page.tsx` |

### Phase 6 — 加固 + 发布 (3 commits)

| # | Commit | 文件 |
|---|---|---|
| 6.1 | `feat(proxy): 重试逻辑 + 错误处理 + 优雅关机` | 更新 `packages/proxy/src/routes/`, `packages/proxy/src/copilot/client.ts` |
| 6.2 | `chore: Dockerfile + docker-compose` | `Dockerfile`, `docker-compose.yml` |
| 6.3 | `docs: README + CHANGELOG + 发布 v0.1.0` | `README.md`, `CHANGELOG.md`, `docs/` |

---

## 六、验证方案

### 功能验证

1. **Proxy OpenAI 直通：**
   ```bash
   curl -X POST http://localhost:8080/v1/chat/completions \
     -H "Authorization: Bearer sk-raven-test" \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"hello"}]}'
   ```

2. **Claude Code 集成：**
   ```bash
   ANTHROPIC_BASE_URL=http://localhost:8080 claude
   # 验证：正常对话、工具调用、流式输出
   ```

3. **数据库日志：**
   ```bash
   # 请求完成后
   sqlite3 database/raven.db "SELECT * FROM requests ORDER BY timestamp DESC LIMIT 5"
   ```

4. **Dashboard：**
   - 浏览器打开 `http://localhost:7020`
   - 验证 stat cards 数据正确
   - 验证图表渲染

5. **Token 自动刷新：**
   - 运行超过 token 有效期，观察日志中的 refresh 记录
   - 确认无中断

### 测试命令

```bash
# L1: 单元测试
bun test

# L2: Lint
bun lint

# L3: API E2E (proxy)
bun test:e2e

# L4: BDD E2E (按需，需要真实 token)
bun test:e2e:bdd
```
