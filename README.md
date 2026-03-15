<p align="center"><img src="logo.png" width="128" height="128"/></p>

<h1 align="center">Raven</h1>

<p align="center"><strong>GitHub Copilot 反向代理，支持 Anthropic/OpenAI 双格式翻译</strong><br>本地代理 · 格式翻译 · 请求统计 · 可视化仪表盘</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun_≥1.3-f9f1e1?logo=bun" alt="Bun">
  <img src="https://img.shields.io/badge/proxy-Hono-e36002?logo=hono" alt="Hono">
  <img src="https://img.shields.io/badge/dashboard-Next.js_16-000?logo=nextdotjs" alt="Next.js">
  <img src="https://img.shields.io/badge/tests-187_passing-brightgreen" alt="Tests">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

---

## 这是什么

Raven 是一个运行在本地的 GitHub Copilot API 反向代理。它让你可以用 Anthropic 的 `/v1/messages` 格式调用 Copilot 上游的模型（Claude、GPT、o-series），自动完成 Anthropic ↔ OpenAI 格式的双向翻译，包括流式 SSE 响应的实时转换。同时提供 OpenAI 原生格式的 `/v1/chat/completions` 透传通道。

附带一个 Next.js 统计仪表盘，可视化展示请求量、token 消耗、延迟分布、模型使用比例，以及 Copilot 账户的订阅配额信息。

```
┌──────────────────────────────────────────────────┐
│  Client (Claude Code / Cursor / etc.)            │
│  POST /v1/messages (Anthropic)                   │
│  POST /v1/chat/completions (OpenAI)              │
└────────────────────┬─────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │   Raven Proxy :7033 │
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
          │  Dashboard :7032    │
          │  Next.js 16         │
          │  请求统计 / 模型分析  │
          │  Copilot 账户信息    │
          └─────────────────────┘
```

> **定位**：研究性个人项目，仅供本地使用，不面向多用户部署。

## 功能

### Proxy

- **Anthropic 格式入口** — `POST /v1/messages`，自动翻译为 OpenAI 格式转发 Copilot，响应翻译回 Anthropic 格式
- **OpenAI 格式透传** — `POST /v1/chat/completions`，直接转发并采集 metrics
- **流式 SSE 翻译** — 状态机实现 OpenAI SSE chunks → Anthropic stream events 的实时转换
- **双层认证** — GitHub OAuth Device Flow + Copilot JWT 自动刷新，token 持久化到磁盘
- **请求日志** — 所有请求自动记录到 SQLite（模型、tokens、延迟、TTFT、状态码）
- **统计查询 API** — 概览、时序、模型分布、最近请求，支持过滤/排序/分页
- **Copilot 上游可见性** — 内存缓存真实模型列表和订阅配额，支持按需刷新

### Dashboard

- **概览页** — 请求量、token 消耗、延迟、错误率的 stat cards + 面积图/柱状图/折线图
- **请求日志** — 可排序表格，模型/状态/格式筛选，游标和偏移分页
- **模型统计** — 饼图（请求分布）+ 柱状图（token 消耗）+ 详情表
- **Copilot 模型** — 按厂商分组的模型表格，一键复制 model ID
- **Copilot 账户** — 订阅信息、SVG 环形进度条展示配额、特性开关列表

## 安装

```bash
git clone https://github.com/nocoo/raven.git
cd raven
bun install
```

## 命令一览

| 命令 | 说明 |
|------|------|
| `bun run dev` | 同时启动 proxy + dashboard |
| `bun run dev:proxy` | 仅启动 proxy（:7033） |
| `bun run dev:dashboard` | 仅启动 dashboard（:7032） |
| `bun run test` | 运行单元测试（187 tests） |
| `bun run test:perf` | 性能基准测试（翻译层 + SSE 解析） |
| `bun run test:e2e` | E2E 测试（需 proxy 运行中） |
| `bun run lint` | ESLint 检查 |
| `bun run typecheck` | TypeScript 类型检查 |

首次启动 proxy 时会触发 GitHub Device Flow 认证，按提示在浏览器中授权即可。

## 项目结构

```
raven/
├── packages/
│   ├── proxy/                   # Bun + Hono API 代理
│   │   ├── src/
│   │   │   ├── copilot/         # 认证、token 管理、API 客户端
│   │   │   ├── translate/       # Anthropic ↔ OpenAI 格式翻译
│   │   │   ├── routes/          # 路由处理
│   │   │   ├── db/              # SQLite 请求日志
│   │   │   └── util/            # SSE 解析、日志、参数工具
│   │   └── test/                # 单元测试、性能、E2E
│   └── dashboard/               # Next.js 16 统计仪表盘
│       └── src/
│           ├── app/             # 页面（概览、请求、模型、Copilot）
│           ├── components/      # UI 组件（Radix UI 封装）
│           └── lib/             # 工具函数、类型、设计系统
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
| 测试 | [bun:test](https://bun.sh/docs/test/writing) |
| 代码质量 | [ESLint](https://eslint.org/) + [Prettier](https://prettier.io/) + [Husky](https://typicode.github.io/husky/) |

## 开发

### 环境要求

- [Bun](https://bun.sh/) ≥ 1.3
- Git
- GitHub 账号（需有 Copilot 订阅）

### 快速开始

```bash
bun install          # 安装依赖（自动配置 Husky）
bun run dev          # 启动 proxy + dashboard
```

### Git Hooks

| Hook | 执行内容 | 用途 |
|------|----------|------|
| pre-commit | `bun test` | 每次 commit 前跑单元测试 |
| pre-push | `bun test && bun run test:perf && bun run lint && bun run typecheck` | 全量门控 |

## 测试

| 层 | 内容 | 触发时机 |
|------|------|----------|
| Unit | 187 个测试，全部 mock 上游调用 | pre-commit |
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
| 01 | [MVP 设计文档](docs/01-mvp.md) | 架构设计、核心模块、测试策略、提交计划 |

## License

[MIT](LICENSE) © 2026