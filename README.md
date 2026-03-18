<p align="center"><img src="logo.png" width="128" height="128"/></p>

<h1 align="center">raven</h1>

<p align="center"><strong>GitHub Copilot 反向代理，支持 Anthropic/OpenAI 双格式实时翻译</strong><br>本地代理 · 格式翻译 · 请求统计 · 可视化仪表盘</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun_≥1.3-f9f1e1?logo=bun" alt="Bun">
  <img src="https://img.shields.io/badge/proxy-Hono-e36002?logo=hono" alt="Hono">
  <img src="https://img.shields.io/badge/dashboard-Next.js_16-000?logo=nextdotjs" alt="Next.js">
  <img src="https://img.shields.io/badge/tests-487_passing-brightgreen" alt="Tests">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

---

## 这是什么

raven 是一个运行在本地的 GitHub Copilot API 反向代理。它让你可以用 Anthropic 的 `/v1/messages` 格式调用 Copilot 上游的模型（Claude、GPT、o-series），自动完成 Anthropic ↔ OpenAI 格式的双向翻译，包括流式 SSE 响应的实时转换。同时提供 OpenAI 原生格式的 `/v1/chat/completions` 透传通道。

附带一个 Next.js 统计仪表盘，可视化展示请求量、token 消耗、延迟分布、模型使用比例，以及 Copilot 账户的订阅配额信息。

```
┌──────────────────────────────────────────────────┐
│  Client (Claude Code / Cursor / etc.)            │
│  POST /v1/messages (Anthropic)                   │
│  POST /v1/chat/completions (OpenAI)              │
└────────────────────┬─────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │   raven proxy :7033 │
          │  ┌───────────────┐  │
          │  │  翻译层        │  │
          │  │ Anthropic↔OAI │  │
          │  └───────┬───────┘  │
          │  ┌───────▼───────┐  │
          │  │  SQLite 日志   │  │
          │  └───────────────┘  │
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  GitHub Copilot API │
          │  api.githubcopilot  │
          └─────────────────────┘

          ┌─────────────────────┐
          │  dashboard :7032    │
          │  Next.js 16         │
          │  请求统计 / 模型分析  │
          │  Copilot 账户信息    │
          └─────────────────────┘
```

> **定位**：研究性个人项目，设计为本地运行。

## 功能

### Proxy

- **Anthropic 格式入口** — `POST /v1/messages`，自动翻译为 OpenAI 格式转发 Copilot，响应翻译回 Anthropic 格式
- **OpenAI 格式透传** — `POST /v1/chat/completions`，直接转发并采集 metrics
- **流式 SSE 翻译** — 状态机实现 OpenAI SSE chunks → Anthropic stream events 的实时转换
- **双层认证** — GitHub OAuth Device Flow + Copilot JWT 自动刷新，token 持久化到磁盘
- **请求日志** — 所有请求自动记录到 SQLite（模型、tokens、延迟、TTFT、状态码）
- **统计查询 API** — 概览、时序、模型分布、最近请求，支持过滤/排序/分页
- **Copilot 上游可见性** — 内存缓存真实模型列表和订阅配额，支持按需刷新
- **版本自动检测** — 从本地 VS Code / Cursor / Insiders / VSCodium 安装中读取版本号，用于伪装请求头
- **版本设置** — 通过 dashboard 或 API 手动覆盖 VS Code / Copilot Chat 版本号，持久化到 SQLite

### Dashboard

- **概览页** — 请求量、token 消耗、延迟、错误率的 stat cards + 面积图/柱状图/折线图
- **实时日志** — WebSocket → SSE 桥接的实时日志流，支持按级别/请求 ID 过滤
- **模型统计** — 饼图（请求分布）+ 柱状图（token 消耗）+ 详情表
- **Copilot 模型** — 按厂商分组的模型表格，一键复制 model ID
- **Copilot 账户** — 订阅信息、SVG 环形进度条展示配额、特性开关列表
- **版本设置** — 查看当前生效版本及来源（本地检测/AUR/回退），支持手动覆盖和重置
- **连接信息** — 所有端点地址、可用模型列表、API Key 管理

## 安装与首次运行

### 环境要求

- [Bun](https://bun.sh/) ≥ 1.3
- Git
- GitHub 账号（需有 [Copilot](https://github.com/features/copilot) 订阅）

### 1. 克隆并安装

```bash
git clone https://github.com/nocoo/raven.git
cd raven
bun install
```

### 2. 配置 API Key

AI API 端点（`/v1/messages`、`/v1/chat/completions` 等）**始终需要 API Key 认证**。推荐先配置再启动：

```bash
# Proxy 端
cp packages/proxy/.env.example packages/proxy/.env.local
# 编辑 RAVEN_API_KEY=<你的密钥>

# Dashboard 端（用于 dashboard → proxy 内部通信）
cp packages/dashboard/.env.example packages/dashboard/.env.local
# 编辑 RAVEN_INTERNAL_KEY=<另一个密钥> 或复用 RAVEN_API_KEY
```

也可以不配 env key，通过 Dashboard 的 Connect 页面创建 DB-managed key（首次启动时 Dashboard 管理接口免认证）。

### 3. 启动

```bash
bun run dev          # 同时启动 proxy (:7033) + dashboard (:7032)
```

首次运行 proxy 会自动完成以下初始化：

| 自动步骤 | 说明 |
|----------|------|
| 创建 `data/` 目录 | 存放 SQLite 和 token 文件 |
| 创建 `data/raven.db` | SQLite 数据库（WAL 模式），自动建表 |
| 创建 `data/github_token` | GitHub OAuth token 文件（权限 `0600`） |

### 4. GitHub 授权（首次必需）

首次启动时，终端会输出类似提示：

```
Please enter the code "ABCD-1234" in https://github.com/login/device/code
```

1. 用浏览器打开 https://github.com/login/device/code
2. 输入终端显示的验证码
3. 授权 raven 访问你的 GitHub 账号

授权完成后 proxy 自动继续启动，token 持久化到 `data/github_token`。后续重启无需重复授权。

### 5. 配置客户端

Proxy 启动后，将客户端指向 raven：

<details><summary><strong>Claude Code</strong></summary>

```bash
# Anthropic 格式
claude config set --global apiUrl http://localhost:7033/v1
```

</details>

<details><summary><strong>Cursor / 其他支持 OpenAI 格式的客户端</strong></summary>

```
Base URL: http://localhost:7033/v1
```

</details>

打开 Dashboard 查看统计：http://localhost:7032

---

## Dashboard 认证模式

Dashboard 支持两种运行模式：

### Local 模式（默认）

**零配置**。不设置 Google OAuth 环境变量时，dashboard 自动以 local 模式运行：

- 所有页面直接可访问，无需登录
- 侧边栏显示 "Local" / "Local mode"，无登出按钮
- 访问 `/login` 会自动重定向到首页

适合本地个人使用，也是 `bun run dev` 的默认行为。

### Google OAuth 模式

需要登录认证时（例如将 dashboard 暴露在网络上），启用 Google OAuth：

1. 创建 dashboard 环境变量文件：

   ```bash
   cp packages/dashboard/.env.example packages/dashboard/.env.local
   ```

2. 在 [Google Cloud Console](https://console.cloud.google.com/apis/credentials) 创建 OAuth 2.0 凭据：
   - 应用类型：Web application
   - 授权重定向 URI：`http://localhost:7032/api/auth/callback/google`

3. 填入凭据和密钥：

   ```bash
   # packages/dashboard/.env.local
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   NEXTAUTH_SECRET=$(openssl rand -base64 32)
   ```

   三个变量**全部设置**后 dashboard 才会切换到 OAuth 模式。任一缺失则保持 local 模式。

4. （可选）限制可登录的邮箱，逗号分隔：

   ```
   ALLOWED_EMAILS=alice@example.com,bob@example.com
   ```

5. 重启 dashboard，访问任何页面会跳转到 Google 登录页。

### 自定义 Hostname / HTTPS

如需通过自定义域名或 HTTPS 反向代理访问：

- 设置 `RAVEN_BASE_URL` 为 proxy 的公开地址（例如 `https://raven.example.com`），`/api/connection-info` 会返回该地址
- 设置 `NEXTAUTH_URL` 为 dashboard 的公开地址
- 启用 `USE_SECURE_COOKIES=true`（如果 HTTPS）

## 命令一览

| 命令 | 说明 |
|------|------|
| `bun run dev` | 同时启动 proxy + dashboard |
| `bun run dev:proxy` | 仅启动 proxy（:7033） |
| `bun run dev:dashboard` | 仅启动 dashboard（:7032） |
| `bun run test` | 运行 proxy 单元测试（487 tests） |
| `bun run test:all` | 运行所有 workspace 测试 |
| `bun run test:perf` | 性能基准测试（翻译层 + SSE 解析） |
| `bun run test:e2e` | E2E 测试（需 proxy 运行中） |
| `bun run lint` | ESLint 检查 |
| `bun run typecheck` | TypeScript 类型检查 |

## 项目结构

```
raven/
├── packages/
│   ├── proxy/                   # Bun + Hono API 代理
│   │   ├── src/
│   │   │   ├── routes/          # 路由（chat, messages, models, settings）
│   │   │   ├── services/        # Copilot API 客户端、本地版本检测
│   │   │   ├── db/              # SQLite（requests, api_keys, settings）
│   │   │   ├── lib/             # 状态、认证、工具函数
│   │   │   ├── ws/              # WebSocket 实时日志
│   │   │   └── util/            # SSE 解析、日志系统
│   │   └── test/                # 单元测试、性能、E2E
│   └── dashboard/               # Next.js 16 统计仪表盘
│       └── src/
│           ├── app/             # 页面（概览、日志、模型、设置）
│           ├── components/      # UI 组件（Radix UI 封装）
│           └── lib/             # 工具函数、类型、图表配置
├── docs/                        # 设计文档
├── .husky/                      # Git hooks
└── eslint.config.js             # 共享 ESLint 配置
```

## 技术栈

| 层 | 技术 |
|------|------|
| 运行时 | [Bun](https://bun.sh/) ≥ 1.3 |
| Proxy 框架 | [Hono](https://hono.dev/) 4 |
| Dashboard 框架 | [Next.js](https://nextjs.org/) 16 + [React](https://react.dev/) 19 |
| UI 组件 | [Radix UI](https://www.radix-ui.com/) + [Tailwind CSS](https://tailwindcss.com/) 4 |
| 图表 | [Recharts](https://recharts.org/) |
| 认证 | [NextAuth.js](https://next-auth.js.org/) |
| 数据库 | [SQLite](https://www.sqlite.org/) (WAL mode, via `bun:sqlite`) |
| 测试 | [bun:test](https://bun.sh/docs/test/writing) + [Vitest](https://vitest.dev/) |
| 代码质量 | [ESLint](https://eslint.org/) + [Prettier](https://prettier.io/) + [Husky](https://typicode.github.io/husky/) |

## 开发

### 环境变量参考

Proxy 和 Dashboard 的环境变量模板见 `.env.example`。AI API 端点需要 API Key 认证（无 key 则 401），Dashboard 管理端点在首次运行时免认证。

```bash
cp packages/proxy/.env.example packages/proxy/.env.local
cp packages/dashboard/.env.example packages/dashboard/.env.local
```

#### Proxy (`packages/proxy`)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RAVEN_PORT` | `7033` | 监听端口 |
| `RAVEN_API_KEY` | _(空)_ | AI API 认证，空 = 需通过 dashboard 创建 DB key |
| `RAVEN_INTERNAL_KEY` | _(空)_ | Dashboard → Proxy 管理凭证，AI API 不接受 |
| `RAVEN_TOKEN_PATH` | `data/github_token` | GitHub OAuth token 持久化路径 |
| `RAVEN_LOG_LEVEL` | `info` | 最低日志级别：`debug` / `info` / `warn` / `error` |
| `RAVEN_BASE_URL` | _(空)_ | 公开 base URL，空 = `http://localhost:$RAVEN_PORT` |

#### Dashboard (`packages/dashboard`)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NEXTAUTH_URL` | `http://localhost:7032` | NextAuth base URL |
| `NEXTAUTH_SECRET` | _(启用 OAuth 时必填)_ | Session 签名密钥 |
| `GOOGLE_CLIENT_ID` | _(启用 OAuth 时必填)_ | Google OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | _(启用 OAuth 时必填)_ | Google OAuth Client Secret |
| `ALLOWED_EMAILS` | _(空)_ | 邮箱白名单，逗号分隔，空 = 允许所有 |
| `RAVEN_PROXY_URL` | `http://localhost:7033` | Dashboard → Proxy 连接 URL |
| `RAVEN_INTERNAL_KEY` | _(空)_ | Dashboard → Proxy 管理凭证，proxy 原生读取 |
| `USE_SECURE_COOKIES` | _(空)_ | 强制启用 secure cookies |

### Git Hooks

| Hook | 执行内容 | 用途 |
|------|----------|------|
| pre-commit | `bun test` | 每次 commit 前跑单元测试 |
| pre-push | `bun test && bun run test:perf && bun run lint && bun run typecheck` | 全量门控 |

## 测试

| 层 | 内容 | 触发时机 |
|------|------|----------|
| Unit | 487 个测试，全部 mock 上游调用 | pre-commit |
| Perf | SSE 解析、翻译层基准测试 | pre-push |
| E2E | 真实 proxy → Copilot API，每个测试仅 1 个请求 | 手动 |

```bash
bun run test          # 单元测试
bun run test:perf     # 性能基准
bun run test:e2e      # E2E（需 proxy 运行）
```

## 文档

| 编号 | 文档 | 说明 |
|------|------|------|
| 02 | [Key Management](docs/02-key-management.md) | 多 Key 管理系统：数据库 + Dashboard UI + Proxy 验证 |
| 03 | [Unified Logging](docs/03-unified-logging.md) | 统一日志系统：LogEmitter 事件总线 + 三路 fan-out |
| 04 | [Proxy Rewrite](docs/04-proxy-rewrite.md) | Proxy 重写：基于 copilot-api 的整体替换方案 |
| 05 | [Test Coverage](docs/05-test-coverage.md) | 测试覆盖率提升：Hot Path → 全量 95%+ |
| 06 | [Dashboard Test Plan](docs/06-dashboard-test-plan.md) | Dashboard 测试计划 |
| 07 | [Session Tracking](docs/07-session-tracking.md) | Session 识别 + 并行会话统计 UI |
| 08 | [Local Auth Mode](docs/08-dev-auth-mode.md) | Dashboard local 模式：无 Google OAuth 时跳过认证 |
| 09 | [Unified Auth](docs/09-unified-auth.md) | 统一认证架构：分离 AI API 认证与 Dashboard 管理认证 |
| 10 | [Request Optimizations](docs/10-request-optimizations.md) | 可配置的请求优化项：协议兼容性修复，Settings 页面逐一开关 |

<details><summary>Archive</summary>

| 编号 | 文档 | 说明 |
|------|------|------|
| 01 | [MVP 设计文档](docs/archive/01-mvp.md) | 初始 MVP 设计文档（已被 04-proxy-rewrite 取代） |

</details>

## License

[MIT](LICENSE) © 2026
