<p align="center">
  <img src="assets/brand/icon-rounded.png" width="128" alt="Raven logo" />
</p>
<h1 align="center">Raven</h1>
<p align="center">在本机适配 GitHub Copilot 与自定义模型上游，并查看 API 调用记录。</p>
<p align="center">
  <a href="docs/README.en.md">English</a>
</p>

## 这是什么

Raven 是用于个人研究和开发的模型 API 代理。Bun / Hono 服务接收 Anthropic Messages、OpenAI Chat Completions 和 Responses 请求，验证 API key 后，按绑定规则的时段与共享配额选择上游，处理 JSON 与 SSE 响应。Next.js Dashboard 提供 Routing 工作台、请求统计、实时日志和连接管理。

它依赖上游账号授权、模型能力和服务可用性。当前启动流程始终执行 GitHub / Copilot 认证，即使之后只打算使用自定义上游，也仍需可用的 Copilot 凭据。

## 功能

| 操作 | 当前行为 |
| --- | --- |
| 适配客户端协议 | 为 Messages、Chat Completions、Responses 和 Embeddings 提供入口，路由范围见下表。 |
| 选择上游 | 每个 key 绑定一个规则；按每天或每周时段、配额候选顺序和最终兜底选择上游。只有额度耗尽才跳过候选，请求失败不会切换。 |
| 管理配额 | 每个上游共享一份可选 token 额度，支持周期窗口、下次重置时间和峰谷扣减倍数。 |
| 查看调用情况 | 统计请求量、token、延迟、首 token 时间与错误，按模型、客户端、会话或 provider 分组。 |
| 跟踪即时状态 | 查看实时日志和 Copilot token 刷新状态，读取上游模型目录与账号配额信息。 |
| 管理连接 | 在 Connect 创建、换绑和撤销 API key；在 Routing 管理上游、缓存模型和规则；保留 IP 白名单与 SOCKS5 出站代理。 |
| 执行网络搜索 | 在支持的 Messages 路径中，将 `web_search` 交给 Tavily 执行；需要配置 Tavily key。 |

| 客户端入口 | 当前上游范围 |
| --- | --- |
| `POST /v1/messages` | 按规则选择 Copilot 或自定义 Messages、Chat、Responses 上游；跨协议需要规则开启转换。 |
| `POST /v1/chat/completions` | 同上，支持原生 Chat 与到 Messages / Responses 的转换。 |
| `POST /v1/responses` | 支持 Copilot、自定义原生 Responses，以及到 Chat / Messages 的转换。 |
| `POST /v1/embeddings` | 同样执行规则与配额准入，目前仅支持 Copilot 嵌入接口。 |
| `GET /v1/models` | 仅读已有缓存，返回 `auto` 加所有已知模型 ID，精确去重。 |

请求 `auto` 使用当前时段选中候选的模型；显式模型 ID 则原样交给同一个自定义上游。新规则默认关闭转换，建议使用原生协议。已有 key 自动绑定开启转换的 Copilot 规则，其初始 `auto` 模型为 `gpt-5.6-sol`。Copilot 是不可删除的上游，不承担隐式兜底。

自定义模型目录只在用户点击刷新时更新；Copilot 独立按小时刷新。模型列表是全局候选，不保证每条规则都能访问其中所有模型。转换支持文本、普通工具及相应 JSON/SSE；不支持的跨协议特性会明确拒绝。`/v1/messages/count_tokens` 使用相同路由做本地估算，不请求上游、不扣额度，无法估算时返回哨兵值 1。

## 使用

### 安装与配置

需要 Bun 1.3.11 或更新版本、Node.js 26（精确版本见 [.node-version](.node-version)），以及能访问 Copilot 的 GitHub 账号。仓库使用 Bun workspaces。

```bash
git clone https://github.com/nocoo/raven.git
cd raven
bun install --frozen-lockfile
```

分别为客户端调用和 Dashboard 管理生成随机密钥，例如运行两次：

```bash
openssl rand -hex 32
```

创建 `packages/proxy/.env.local`，用生成的值替换示例：

```dotenv
RAVEN_API_KEY=replace-with-client-key
RAVEN_INTERNAL_KEY=replace-with-management-key
```

创建 `packages/dashboard/.env.local`，其中管理密钥与 Proxy 保持一致：

```dotenv
RAVEN_PROXY_URL=http://127.0.0.1:7024
RAVEN_INTERNAL_KEY=replace-with-management-key
```

完整变量示例分别在 [Proxy 模板](packages/proxy/.env.example)和 [Dashboard 模板](packages/dashboard/.env.example)。Proxy 模板中的 `RAVEN_TOKEN_PATH=data/github_token` 会覆盖默认数据路径；使用平台默认目录时省略该变量。

### 启动与连接

```bash
bun run dev
```

首次启动在终端显示 GitHub Device Flow 的地址和验证码；在浏览器完成授权后，Proxy 初始化 Copilot token、恢复本地模型缓存并启动后台刷新。默认 Proxy 端口为 7024，Dashboard 为 7023。本机开发通过已配置的 Caddy 地址 `https://raven.dev.hexly.ai` 预览，在 Connect 中查看连接信息和管理 API key；其他安装环境使用自己的 Dashboard 地址。

AI 接口接受 `Authorization: Bearer ...` 或 `x-api-key`，始终需要有效客户端 key。`RAVEN_INTERNAL_KEY` 只用于管理接口。数据库生成的 key 以 `rk-` 开头；手工配置的环境变量 key 请使用生成的随机值。

在当前终端设置 `RAVEN_API_KEY` 后，可检查服务和模型目录：

```bash
curl http://127.0.0.1:7024/health
curl -H "Authorization: Bearer $RAVEN_API_KEY" \
  http://127.0.0.1:7024/v1/models
```

支持 Anthropic 协议的客户端使用 Base URL `http://127.0.0.1:7024`；支持 OpenAI 协议的客户端通常使用 `http://127.0.0.1:7024/v1`。在 Connect 选择 key 的规则，再使用 `auto` 或显式模型 ID；具体客户端的配置方式以其文档为准。

### 访问范围与数据

Dashboard 缺少 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`NEXTAUTH_SECRET` 中任意一项时，处于无需登录的 Local 模式。Proxy 的 `/api/*` 和日志 WebSocket 在两个环境变量 key 都未配置时也无需认证，这一行为与数据库 key 的数量无关。

启动脚本没有显式限制为 loopback 监听，本机使用时应限制端口的外部可达范围。提供网络访问时，需要同时配置 Dashboard 的 Google OAuth、`ALLOWED_EMAILS` 和 Proxy 访问控制；空邮箱名单接受所有已登录 Google 账号。更多配置见[部署文档](docs/14-vps-deployment.md)。

默认 GitHub token 和数据库位置如下：

| 平台 | 配置与数据目录 |
| --- | --- |
| macOS | `~/Library/Application Support/raven/` |
| Linux | 配置 `~/.config/raven/`，数据 `~/.local/share/raven/`，遵循 XDG 覆盖值 |

`RAVEN_CONFIG_DIR` / `RAVEN_DATA_DIR` 可修改目录，`RAVEN_TOKEN_PATH` / `RAVEN_DB_PATH` 可指定完整路径。数据库 key 保存为摘要；GitHub token 文件和自定义上游密钥仍是本地明文凭据，数据库也包含请求记录与设置。

## 开发

`packages/proxy/` 包含路由、协议转换、上游客户端与 SQLite 数据访问；`packages/dashboard/` 包含页面和转发到 Proxy 的服务端接口。

```bash
bun run dev:proxy
bun run dev:dashboard
```

这两条分别启动服务，可按需要在不同终端运行。Dashboard 构建与构建后启动：

```bash
bun run build
bun run start:proxy
```

另一个终端运行：

```bash
bun run start:dashboard
```

两种启动方式都会使用实际配置；Proxy 启动会连接 GitHub。`bun run start` 则先构建 Dashboard，再同时启动两个服务。

## 测试

安装依赖后在仓库根目录运行：

| 范围 | 命令 |
| --- | --- |
| Proxy 与 Dashboard 单元测试 | `bun run test:all` |
| 路由与 handler 集成，模拟上游 | `bun run test:l2` |
| 覆盖率及既有目录基线门禁 | `bun run gate:coverage` |
| 隔离 Routing 生产浏览器验收，先构建 | `bun run scripts/verify-routing-ui.ts` |
| SSE 与协议转换基准测试 | `bun run test:perf` |
| 真实上游 API 测试 | `RAVEN_API_KEY=your-client-key bun run test:e2e` |
| 旧 Dashboard 浏览器测试，依赖真实认证 | `bun run test:ui` |

隔离 Routing 验收使用临时 SQLite、合成凭据、本地模拟上游和随机端口，清理运行数据后保留截图与报告。构建和运行方法见[运维文档](docs/26-agent-operations.md#isolated-routing-browser-acceptance)。它覆盖这次 Routing 工作流，不代表全应用已达到完整 L2/L3/D1 隔离标准。

真实 API 测试会复用或启动 7024 端口的 Proxy，使用其实际配置和数据库，并向上游发起请求。浏览器测试需要先在 `packages/dashboard/` 运行 `bunx playwright install chromium`；旧 `test:ui` 要求 Proxy 端口空闲，使用固定测试数据库，但仍依赖 GitHub 认证。这两个旧 runner 不用于常规隔离验证。

## 技术栈

| 技术 | 用途 |
| --- | --- |
| Bun / TypeScript / Hono | Proxy 运行环境、HTTP 路由与 SSE |
| SQLite | API key 摘要、请求记录、设置与 provider 配置 |
| Next.js / React | Dashboard 页面与服务端接口 |
| Basalt / Tailwind CSS | 组件与样式 |
| SWR / Recharts | 数据更新与统计图表 |
| NextAuth / Google OAuth | 可选的 Dashboard 登录 |
| Zod / gpt-tokenizer | 请求校验与本地 token 估算 |
| socks / Tavily | 可选出站代理与服务端网络搜索 |
| Vitest / bun:test / Playwright | 单元、协议、性能与浏览器测试 |

## 文档

- [文档索引](docs/README.md)
- [认证设计背景](docs/09-unified-auth.md)
- [Key 绑定路由、排期与配额](docs/28-key-bound-routing.md)
- [服务端搜索工具](docs/13-server-tools.md)
- [协议处理架构](docs/20-architecture-refactor.md)
- [Token Sentinel](docs/23-token-sentinel.md)
- [Chat Completions 到 Responses 的转换](docs/24-chat-responses-shim.md)
- [版本记录](CHANGELOG.md)

## 许可证

[MIT](LICENSE)
