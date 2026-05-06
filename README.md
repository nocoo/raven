<p align="center"><img src="logo.png" width="128" height="128"/></p>

<h1 align="center">raven</h1>

<p align="center"><strong>GitHub Copilot 反向代理，支持 Anthropic/OpenAI 双格式实时翻译</strong><br>本地代理 · 格式翻译 · 请求统计 · 可视化仪表盘</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun_≥1.3-f9f1e1?logo=bun" alt="Bun">
  <img src="https://img.shields.io/badge/proxy-Hono_4-e36002?logo=hono" alt="Hono">
  <img src="https://img.shields.io/badge/dashboard-Next.js_16-000?logo=nextdotjs" alt="Next.js">
  <img src="https://img.shields.io/badge/tests-1540_passing-brightgreen" alt="Tests">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

---

## 这是什么

raven 是一个运行在本地的 GitHub Copilot API 反向代理。它让你可以用 Anthropic 的 `/v1/messages` 格式调用 Copilot 上游的模型（Claude、GPT、o-series），自动完成 Anthropic ↔ OpenAI 格式的双向翻译，包括流式 SSE 响应的实时转换。同时提供 OpenAI 原生格式的 `/v1/chat/completions` 和 `/v1/responses` 透传通道，以及 `/v1/embeddings` 嵌入接口。

Claude 模型默认走原生 Anthropic `/v1/messages` 协议直连 Copilot，跳过翻译层，获得最佳兼容性（支持 Extended Thinking、1M 上下文等原生特性）。

附带一个 Next.js 统计仪表盘，可视化展示请求量、token 消耗、延迟分布、模型使用比例，以及 Copilot 账户的订阅配额信息。

```
┌──────────────────────────────────────────────────────┐
│  Client (Claude Code / Cursor / Codex CLI / etc.)    │
│  POST /v1/messages      (Anthropic)                  │
│  POST /v1/chat/completions (OpenAI)                  │
│  POST /v1/responses     (OpenAI Responses)           │
│  POST /v1/embeddings    (Embeddings)                 │
└────────────────────┬─────────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │   raven proxy :7024 │
          │  ┌───────────────┐  │
          │  │ 路由 + 翻译层   │  │
          │  │ Anthropic↔OAI │  │
          │  │ Native 直通    │  │
          │  └───────┬───────┘  │
          │  ┌───────▼───────┐  │
          │  │  SQLite 日志   │  │
          │  └───────────────┘  │
          └──────┬───────┬──────┘
                 │       │
     ┌───────────▼┐  ┌───▼──────────────┐
     │ GitHub     │  │ 第三方 Provider   │
     │ Copilot API│  │ (自定义上游路由)   │
     └────────────┘  └──────────────────┘

          ┌─────────────────────┐
          │  dashboard :7023    │
          │  Next.js 16         │
          │  请求统计 / 模型分析  │
          │  设置 / 连接管理      │
          └─────────────────────┘
```

> **定位**：研究性个人项目，设计为本地运行。

## 功能

### Proxy

- **Anthropic 格式入口** — `POST /v1/messages`，自动翻译为 OpenAI 格式转发 Copilot，响应翻译回 Anthropic 格式
- **原生 Anthropic 直通** — Claude 模型默认走 Copilot 原生 `/v1/messages` 端点，零翻译开销，完整支持 Extended Thinking、1M 上下文窗口、`output_config.effort` 等原生特性
- **OpenAI 格式透传** — `POST /v1/chat/completions`，直接转发并采集 metrics
- **OpenAI Responses API** — `POST /v1/responses`，支持 Codex CLI 等使用 Responses API 的客户端
- **Embeddings** — `POST /v1/embeddings`，文本嵌入接口
- **流式 SSE 翻译** — 状态机实现 OpenAI SSE chunks → Anthropic stream events 的实时转换
- **自定义上游路由** — 按模型名（精确/Glob 模式）将请求路由到第三方 API 提供商（如智谱 GLM），支持 OpenAI / Anthropic 两种协议格式
- **Tavily 网络搜索** — 拦截 Claude Code 的 `web_search` server-side tool，替换为 Tavily API 执行，返回 Anthropic 原生 `web_search_tool_result` 格式；支持纯服务端模式和混合模式
- **SOCKS5 代理中继** — 通过 SOCKS5 代理隐藏出口 IP，支持 per-upstream 路由策略，Dashboard 可视化配置
- **IP 白名单** — 限制 API 访问来源 IP，防止未授权访问
- **双层认证** — GitHub OAuth Device Flow + Copilot JWT 自动刷新，token 持久化到磁盘
- **请求日志** — 所有请求自动记录到 SQLite（模型、tokens、延迟、TTFT、状态码）
- **统计查询 API** — 概览、时序、模型分布、最近请求，支持过滤/排序/分页
- **Copilot 上游可见性** — 内存缓存真实模型列表和订阅配额，支持按需刷新
- **版本伪装** — 自动检测本地 VS Code / Cursor 版本号，用于伪装请求头；支持通过 Dashboard 手动覆盖

### Dashboard

- **概览页** — 请求量、token 消耗、延迟、错误率的 stat cards + 面积图/柱状图/折线图
- **实时日志** — WebSocket → SSE 桥接的实时日志流，支持按级别/请求 ID 过滤
- **请求历史** — 分页浏览历史请求，支持过滤和详情查看
- **模型统计** — 饼图（请求分布）+ 柱状图（token 消耗）+ 详情表
- **Copilot 模型** — 按厂商分组的模型表格，一键复制 model ID
- **Copilot 账户** — 订阅信息、环形进度条展示配额、特性开关列表
- **设置页** — 统一设置入口：
  - 请求优化项（协议兼容性开关）
  - 搜索工具配置（Tavily API Key、搜索深度）
  - SOCKS5 代理配置与连接测试
  - IP 白名单管理
  - 声音通知配置
  - 调试面板
  - 版本覆盖
- **自定义上游** — 可视化配置第三方 API 提供商，增删改 + 启用/禁用，冲突检测
- **连接信息** — 端点地址、可用模型列表、API Key 管理（创建/吊销/复制）

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
bun run dev          # 同时启动 proxy (:7024) + dashboard (:7023)
```

首次运行 proxy 会自动完成以下初始化：

| 自动步骤 | 说明 |
|----------|------|
| 创建用户目录 | macOS: `~/Library/Application Support/raven/`<br>Linux: `~/.config/raven/` (token), `~/.local/share/raven/` (db) |
| 创建 `raven.db` | SQLite 数据库（WAL 模式），自动建表 |
| 创建 `github_token` | GitHub OAuth token 文件（权限 `0600`） |

**目录迁移**：如果检测到旧的 `./data/` 目录，会自动迁移文件到新位置。

### 4. GitHub 授权（首次必需）

首次启动时，终端会输出类似提示：

```
Please enter the code "ABCD-1234" in https://github.com/login/device/code
```

1. 用浏览器打开 https://github.com/login/device/code
2. 输入终端显示的验证码
3. 授权 raven 访问你的 GitHub 账号

授权完成后 proxy 自动继续启动，token 持久化到用户目录。后续重启无需重复授权。

### 5. 配置客户端

Proxy 启动后，将客户端指向 raven：

<details><summary><strong>Claude Code</strong></summary>

在 `~/.zshrc`（或你使用的 shell 配置文件）中添加：

```bash
export ANTHROPIC_BASE_URL=http://localhost:7024
export ANTHROPIC_API_KEY=<你的 RAVEN_API_KEY>
```

然后 `source ~/.zshrc` 或重开终端。

**首次启动交互模式的额外步骤：**

Claude Code 交互模式会对 `ANTHROPIC_API_KEY` 进行审批确认。首次运行 `claude` 时会弹出 "Do you want to use this API key?" 对话框，**选择 Yes**。

如果之前误选了 No，key 会被加入拒绝列表，需要手动修复 `~/.claude.json`：

```jsonc
// 将 key 的后 20 位字符从 rejected 移到 approved
"customApiKeyResponses": {
  "approved": ["<key 的后 20 位>"],
  "rejected": []
}
```

> **注意**：`claude --print`（非交互模式）不需要这个审批步骤，直接读取环境变量即可。

</details>

<details><summary><strong>Codex CLI</strong></summary>

```bash
export OPENAI_BASE_URL=http://localhost:7024/v1
export OPENAI_API_KEY=<你的 RAVEN_API_KEY>
```

Codex CLI 使用 OpenAI Responses API (`/v1/responses`)，raven 完整支持。

</details>

<details><summary><strong>Cursor / 其他支持 OpenAI 格式的客户端</strong></summary>

```
Base URL: http://localhost:7024/v1
```

</details>

打开 Dashboard 查看统计：http://localhost:7023

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
   - 授权重定向 URI：`http://localhost:7023/api/auth/callback/google`

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

### 远程部署（VPS）

如需在 VPS / 云虚拟机上以生产模式运行 raven，见 [docs/14-vps-deployment.md](docs/14-vps-deployment.md)。

> ⚠️ **重要**：远程部署时 Dashboard **必须启用 Google OAuth**（不能用 Local 模式），并建议启用 **IP 白名单**限制 API 访问范围。

## 命令一览

| 命令 | 说明 |
|------|------|
| `bun run dev` | 同时启动 proxy + dashboard（开发模式，带 watch） |
| `bun run dev:proxy` | 仅启动 proxy（:7024，开发模式） |
| `bun run dev:dashboard` | 仅启动 dashboard（:7023，开发模式） |
| `bun run start` | **生产模式**：自动构建 dashboard + 启动全部服务（无 watch） |
| `bun run start:proxy` | 仅启动 proxy（:7024，生产模式） |
| `bun run start:dashboard` | 仅启动 dashboard（:7023，生产模式，需先 build） |
| `bun run build` | 构建 dashboard 生产产物 |
| `bun run test` | 运行 proxy 单元测试（含覆盖率门控 90%） |
| `bun run test:all` | 运行所有 workspace 单元测试（proxy + dashboard） |
| `bun run test:perf` | 性能基准测试（翻译层 + SSE 解析） |
| `bun run test:e2e` | API E2E 测试（需 proxy 运行中 + `RAVEN_API_KEY`，详见下方） |
| `bun run test:ui` | Playwright UI 测试（自动启动 proxy + dashboard） |
| `bun run lint` | ESLint 检查 |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun run gate:security` | 安全门控：osv-scanner + gitleaks |
| `bun run release` | 发布新版本 |

> **生产部署推荐**：在 VPS / VM 上使用 `bun run start`，它会自动执行 `bun run build` 后再启动服务，无需手动分步操作。

### E2E 测试

E2E 测试通过真实的 Copilot 上游验证代理功能。为防止触发速率限制，采用 fail-fast 策略（首次上游错误即终止整个测试套件），每个测试仅发送 1 个请求。

**前置条件：**

1. Proxy 正在运行且已完成 GitHub 授权（有效的 Copilot 凭据）
2. 拥有一个 `RAVEN_API_KEY`（环境变量或 DB key）

**生成临时 API Key：**

```bash
# 通过 proxy 管理接口创建 key（首次启动时管理接口免认证）
curl -s http://localhost:7024/api/keys -X POST \
  -H 'Content-Type: application/json' \
  -d '{"name":"e2e-test"}' | jq .

# 返回示例：
# { "id": "...", "key": "rk-...", "name": "e2e-test", ... }
```

**运行测试：**

```bash
# 全量 e2e
RAVEN_API_KEY=rk-... bun run test:e2e

# 指定测试文件 + 增加超时（上游慢时有用）
RAVEN_API_KEY=rk-... bun test packages/proxy/test/e2e/native-anthropic.e2e.test.ts --timeout 30000

# 按名称过滤
RAVEN_API_KEY=rk-... bun test packages/proxy/test/e2e/ -t "streaming" --timeout 30000
```

**测试完成后清理 key：**

```bash
# 吊销 key（id 从创建时的返回中获取）
curl -s http://localhost:7024/api/keys/<id>/revoke -X POST
```

也可以在 Dashboard → Connect 页面手动管理 key。

> ⚠️ E2E 测试不应在 CI 或 pre-commit hook 中运行——仅限手动执行。

## 测试

| 层级 | 内容 | 测试数 | 触发时机 |
|------|------|--------|----------|
| L1 (Unit) | proxy + dashboard (vitest) 单元测试，全部 mock 上游 | 1499 | pre-commit |
| L2 (API E2E) | 真实 proxy → Copilot API，每测试 1 请求 | 41 | 手动 |
| L3 (UI E2E) | Playwright dashboard 全流程测试 | 25 | 手动 |
| Perf | SSE 解析、翻译层基准测试 | — | 手动 |
| G1 (Static) | ESLint + TypeScript 严格模式 | — | pre-commit |
| G2 (Security) | osv-scanner + gitleaks | — | pre-commit (staged) / pre-push (full) |

### Git Hooks

| Hook | 执行内容 | 说明 |
|------|----------|------|
| pre-commit | `scripts/pre-commit.ts`（并行） | L1 全量测试 + lint-staged + typecheck + gitleaks（仅 staged 文件） |
| pre-push | `gate:security` | osv-scanner + gitleaks 完整扫描 |

## 项目结构

```
raven/
├── packages/
│   ├── proxy/                   # Bun + Hono API 代理
│   │   ├── src/
│   │   │   ├── routes/          # 路由
│   │   │   │   ├── messages/    #   /v1/messages（翻译 + 原生直通）
│   │   │   │   ├── chat-completions/  #   /v1/chat/completions
│   │   │   │   ├── responses/   #   /v1/responses
│   │   │   │   ├── embeddings/  #   /v1/embeddings
│   │   │   │   └── models/      #   /v1/models
│   │   │   ├── services/        # Copilot API 客户端、上游路由、版本检测
│   │   │   ├── db/              # SQLite（requests, api_keys, settings, upstreams）
│   │   │   ├── lib/             # 状态、认证、IP 白名单、SOCKS5、速率限制
│   │   │   ├── ws/              # WebSocket 实时日志
│   │   │   └── util/            # SSE 解析、日志系统
│   │   └── test/                # 单元测试、性能、E2E
│   └── dashboard/               # Next.js 16 统计仪表盘
│       └── src/
│           ├── app/             # 页面（概览、日志、请求、模型、设置、连接）
│           ├── components/      # UI 组件（Radix UI 封装）
│           ├── hooks/           # 数据获取 hooks（SWR）
│           └── lib/             # 工具函数、类型、图表配置
├── scripts/                     # 构建脚本（pre-commit、coverage、security gate、release）
├── docs/                        # 设计文档
├── .husky/                      # Git hooks
├── .github/workflows/           # CI（GitHub Actions）
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
| 数据获取 | [SWR](https://swr.vercel.app/) |
| 认证 | [NextAuth.js](https://next-auth.js.org/) |
| 数据库 | [SQLite](https://www.sqlite.org/) (WAL mode, via `bun:sqlite`) |
| 验证 | [Zod](https://zod.dev/) 4 |
| 网络代理 | [socks](https://github.com/JoshGlazebrook/socks) (SOCKS5) |
| 测试 | [Vitest](https://vitest.dev/) + [bun:test](https://bun.sh/docs/test/writing) (E2E/perf) + [Playwright](https://playwright.dev/) |
| 代码质量 | [ESLint](https://eslint.org/) + [Prettier](https://prettier.io/) + [Husky](https://typicode.github.io/husky/) + [lint-staged](https://github.com/lint-staged/lint-staged) |
| 安全扫描 | [osv-scanner](https://google.github.io/osv-scanner/) + [gitleaks](https://github.com/gitleaks/gitleaks) |

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
| `RAVEN_PORT` | `7024` | 监听端口 |
| `RAVEN_API_KEY` | _(空)_ | AI API 认证，空 = 需通过 dashboard 创建 DB key |
| `RAVEN_INTERNAL_KEY` | _(空)_ | Dashboard → Proxy 管理凭证，AI API 不接受 |
| `RAVEN_CONFIG_DIR` | *(平台感知)* | 配置目录：`~/Library/Application Support/raven` (macOS) 或 `~/.config/raven` (Linux) |
| `RAVEN_DATA_DIR` | *(平台感知)* | 数据目录：`~/Library/Application Support/raven` (macOS) 或 `~/.local/share/raven` (Linux) |
| `RAVEN_TOKEN_PATH` | `$RAVEN_CONFIG_DIR/github_token` | GitHub OAuth token 持久化路径（覆盖） |
| `RAVEN_DB_PATH` | `$RAVEN_DATA_DIR/raven.db` | SQLite 数据库路径（覆盖） |
| `RAVEN_LOG_LEVEL` | `info` | 最低日志级别：`debug` / `info` / `warn` / `error` |
| `RAVEN_BASE_URL` | _(空)_ | 公开 base URL，空 = `http://localhost:$RAVEN_PORT` |

#### Dashboard (`packages/dashboard`)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NEXTAUTH_URL` | `http://localhost:7023` | NextAuth base URL |
| `NEXTAUTH_SECRET` | _(启用 OAuth 时必填)_ | Session 签名密钥 |
| `GOOGLE_CLIENT_ID` | _(启用 OAuth 时必填)_ | Google OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | _(启用 OAuth 时必填)_ | Google OAuth Client Secret |
| `ALLOWED_EMAILS` | _(空)_ | 邮箱白名单，逗号分隔，空 = 允许所有 |
| `RAVEN_PROXY_URL` | `http://localhost:7024` | Dashboard → Proxy 连接 URL |
| `RAVEN_INTERNAL_KEY` | _(空)_ | Dashboard → Proxy 管理凭证，proxy 原生读取 |
| `USE_SECURE_COOKIES` | _(空)_ | 强制启用 secure cookies |

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
| 11 | [Custom Upstream Routing](docs/11-custom-upstream-routing.md) | AI Providers：多 provider 模型路由 + Copilot 查重 + Dashboard 管理 |
| 12 | [Quality System Upgrade](docs/12-quality-system-upgrade.md) | 质量体系升级：A- → S 级，D1 隔离 + 文档同步 |
| 13 | [Server-Side Tools](docs/13-server-tools.md) | Server-side tool 拦截替换：web_search → Tavily，pure/mixed 双模式 |
| 14 | [VPS Deployment](docs/14-vps-deployment.md) | 远程部署：Bun + systemd + Nginx + HTTPS + 安全须知 |
| 14b | [Extended Thinking](docs/14-extended-thinking.md) | Extended Thinking 支持：effort 参数 + budget_tokens |
| 15 | [Message Sanitization](docs/15-message-sanitization-pipeline.md) | Copilot 兼容性清洗：过滤不支持的 block 类型与字段 |
| 16 | [OpenAI Responses API](docs/16-openai-responses-api.md) | `/v1/responses` 端点支持：Codex CLI 兼容 |
| 17 | [SOCKS5 Proxy Relay](docs/17-socks5-proxy-relay.md) | SOCKS5 代理中继：隐藏出口 IP，per-upstream 路由策略 |
| 18 | [Native Anthropic Messages](docs/18-native-anthropic-messages.md) | 原生 Anthropic 透传：Claude 模型默认走 `/v1/messages` |
| 19 | [Pipeline Refactor](docs/19-pipeline-refactor.md) | 请求处理管线重构 |

<details><summary>Archive</summary>

| 编号 | 文档 | 说明 |
|------|------|------|
| 01 | [MVP 设计文档](docs/archive/01-mvp.md) | 初始 MVP 设计文档（已被 04-proxy-rewrite 取代） |

</details>

## License

[MIT](LICENSE) © 2026
