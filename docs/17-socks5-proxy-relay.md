# 17 — SOCKS5 Proxy Relay

通过 SOCKS5 代理中继上游请求，隐藏服务器真实出口 IP。适用于 VPS 部署场景——机房 IP 容易被上游检测。

**动机**：当 Raven 部署在 VM 上时，默认出口 IP 属于云厂商段，可能被 GitHub Copilot 等上游识别为非住宅流量。用户配置 SOCKS5 代理后，上游请求的出口 IP 变为代理的 IP。

**已验证**：Bun `fetch({ proxy })` 原生支持 HTTP CONNECT 代理。进程内启动 HTTP CONNECT → SOCKS5 桥，全链路端到端测试通过（IP 变化 + SSE streaming 正常）。

---

## 现状分析：全量出站请求清单

所有使用 Bun 原生 `fetch()` 的出站请求，按目标域分组：

### GitHub 域（`github.com` / `api.github.com`）

| 调用点 | 文件 | 目标 | 用途 |
|--------|------|------|------|
| `getDeviceCode` | `services/github/get-device-code.ts` | `github.com/login/device/code` | OAuth 设备流发起 |
| `pollAccessToken` | `services/github/poll-access-token.ts` | `github.com/login/oauth/access_token` | OAuth 轮询 token |
| `getUser` | `services/github/get-user.ts` | `api.github.com/user` | 获取 GitHub 用户信息 |
| `getCopilotToken` | `services/github/get-copilot-token.ts` | `api.github.com/copilot_internal/v2/token` | 换取 Copilot JWT |
| `getCopilotUsage` | `services/github/get-copilot-usage.ts` | `api.github.com/copilot_internal/user` | 查询 Copilot 用量 |

### Copilot 域（`api.githubcopilot.com`）

| 调用点 | 文件 | 目标 | 用途 |
|--------|------|------|------|
| `getModels` | `services/copilot/get-models.ts` | `/models` | 拉取模型列表 |
| `createChatCompletions` | `services/copilot/create-chat-completions.ts` | `/chat/completions` | 聊天补全请求 |
| `createResponses` | `services/copilot/create-responses.ts` | `/responses` | Responses API 请求 |
| `createEmbeddings` | `services/copilot/create-embeddings.ts` | `/embeddings` | Embeddings 请求 |

### Custom Provider 域（用户配置的 `base_url`）

| 调用点 | 文件 | 目标 | 用途 |
|--------|------|------|------|
| `sendOpenAIDirect` | `services/upstream/send-openai.ts` | `{base_url}/v1/chat/completions` | 转发到 OpenAI 格式 provider |
| `sendAnthropicDirect` | `services/upstream/send-anthropic.ts` | `{base_url}/v1/messages` | 转发到 Anthropic 格式 provider |
| 探活/模型拉取 | `routes/upstreams.ts:120` | `{base_url}/v1/models` | 添加/更新 provider 时能力探测 |
| 模型拉取 | `routes/upstreams.ts:325` | `{base_url}/v1/models` | 按需获取 provider 模型列表 |
| 连接状态 | `routes/connection-info.ts:32` | `{base_url}/v1/models` | 连接信息/状态展示 |
| 模型列表 | `routes/models/route.ts:53` | `{base_url}/v1/models` | 统一模型列表（含 context-length） |

### 其他外部服务

| 调用点 | 文件 | 目标 | 用途 |
|--------|------|------|------|
| `getVsCodeVersion` | `services/get-vscode-version.ts` | `aur.archlinux.org` | 抓取 VS Code 最新版本号 |
| `tavilySearch` | `lib/server-tools/tavily.ts` | `api.tavily.com/search` | Server-side web search |

### 代理路由策略

明确每类出站请求是否走 SOCKS5：

| 分类 | 默认走代理 | 理由 |
|------|-----------|------|
| **GitHub 域** | ✅ Yes | 与 Copilot 同属 GitHub 体系，IP 关联检测风险一致 |
| **Copilot 域** | ✅ Yes | 核心需求——隐藏机房 IP |
| **Custom Provider** | ❌ No | 用户自控的 API 或本地服务（如 Ollama），走代理反而增加延迟 |
| **Provider 探活/模型拉取** | 跟随 provider 策略 | 与该 provider 的数据面请求保持一致 |
| **VS Code 版本抓取** | ❌ No | 与核心隐蔽性无关，且仅启动时调用一次 |
| **Tavily Search** | ❌ No | 第三方搜索服务，与 GitHub IP 检测无关 |

用户可在 SOCKS5 设置页面 per-upstream 覆盖上述默认策略。

---

## 架构设计

### 核心思路

进程内启动一个 HTTP CONNECT 代理（监听 `127.0.0.1` 随机端口），它通过 `socks` 库将流量转发到用户配置的 SOCKS5 代理。上游 `fetch()` 调用通过 Bun 原生 `proxy` 参数指向这个本地桥。

```
Bun fetch({ proxy: "http://127.0.0.1:{port}" })
    │
    ▼
Local HTTP CONNECT Bridge  (in-process, net.createServer)
    │
    ▼ SocksClient.createConnection()
    │
SOCKS5 Proxy (user-configured)
    │
    ▼
Upstream API (github.com / api.githubcopilot.com / custom providers)
```

### Per-upstream 路由策略

不是所有上游都需要走代理。用户可以对每个 upstream 单独配置是否走 SOCKS5。

**默认行为**：
- **Copilot + GitHub（默认 upstream）**：开启 SOCKS5 后默认走代理（核心需求场景）
- **Custom providers**：默认不走代理（多为用户自控的 API，或本地服务如 Ollama）

**Per-upstream 覆盖**：在 SOCKS5 设置页面中，列出所有 upstream（Copilot + 已配置的 custom providers），用户可为每个 upstream 单独配置：
- **Default**：跟随上述默认策略
- **Force On**：强制走代理
- **Force Off**：强制不走代理

---

## 数据层

### Settings 表新增 KV

| Key | Type | Default | 说明 |
|-----|------|---------|------|
| `socks5_enabled` | `"true"/"false"` | `"false"` | 总开关 |
| `socks5_host` | `string` | — | SOCKS5 地址 |
| `socks5_port` | `string` (数字) | — | SOCKS5 端口 |
| `socks5_username` | `string` | — | 可选，认证用户名 |
| `socks5_password` | `string` | — | 可选，认证密码（存储加密见下文） |
| `socks5_copilot` | `"default"/"on"/"off"` | `"default"` | Copilot + GitHub 域的代理策略（default = on） |

### 密码安全

**写入**：password 在存入 settings 表前不做额外加密（SQLite 本身是本地文件，与 provider API key 同级安全模型），但 API 响应中**永不返回明文**。

**读取**（GET 响应）：
- `socks5_password` 字段返回布尔占位：`{ hasPassword: true }` 或 `{ hasPassword: false }`
- 前端据此显示"已设置"或空输入框

**更新**（PUT 请求）：
- password 字段为 `string` → 更新为新密码
- password 字段为 `null` → 清除密码
- password 字段**缺失**（undefined） → 保留原密码不变

此语义与现有 provider API key 的脱敏模式（`api_key_preview`，`packages/proxy/src/db/providers.ts:24`）保持一致。

### Providers 表新增字段

```sql
ALTER TABLE providers ADD COLUMN use_socks5 INTEGER DEFAULT NULL;
-- NULL = follow default (custom provider → off)
-- 1    = force on
-- 0    = force off
```

Copilot 不在 providers 表中，其覆盖用上述 `socks5_copilot` settings key。

### State 扩展

```ts
// packages/proxy/src/lib/state.ts
interface State {
  // ... existing fields
  socks5Enabled: boolean;
  socks5Host: string | null;
  socks5Port: number | null;
  socks5Username: string | null;
  socks5Password: string | null;
  socks5CopilotPolicy: "default" | "on" | "off";
  socks5BridgePort: number | null; // runtime only, not persisted
}
```

---

## Proxy 核心实现

### 新文件：`packages/proxy/src/lib/socks5-bridge.ts`

```ts
import net from "node:net";
import { SocksClient } from "socks";

interface Socks5BridgeConfig {
  host: string;
  port: number;
  userId?: string;
  password?: string;
}

let bridgeServer: net.Server | null = null;
let bridgePort: number | null = null;

/**
 * Start the in-process HTTP CONNECT → SOCKS5 bridge.
 * Listens on 127.0.0.1 with a random port.
 * Idempotent: restarts if config changed, no-op if same.
 */
export async function startBridge(config: Socks5BridgeConfig): Promise<number>;

/**
 * Stop the bridge. Idempotent.
 */
export async function stopBridge(): Promise<void>;

/**
 * Get the proxy URL for fetch(), or undefined if disabled/not applicable.
 */
export function getProxyUrl(
  upstream: "copilot" | "github" | ProviderRecord,
  state: State
): string | undefined;
```

`getProxyUrl()` 决策逻辑（含 fail-closed）：

```
if (!state.socks5Enabled) → undefined  // 功能关闭，正常直连

// --- 功能已开启 ---

if upstream === "copilot" || upstream === "github":
  policy = state.socks5CopilotPolicy
  if policy === "off" → undefined
  // policy === "on" || "default" → 需要走代理
  if !bridgePort → throw Error("SOCKS5 proxy enabled but bridge unavailable")
  → proxy URL

if upstream is ProviderRecord:
  if provider.use_socks5 === 0 → undefined           // 明确不走
  if provider.use_socks5 === null (default) → undefined  // custom 默认不走
  // provider.use_socks5 === 1 → 需要走代理
  if !bridgePort → throw Error("SOCKS5 proxy enabled but bridge unavailable")
  → proxy URL
```

调用方统一 catch 此错误，返回 502 + `"SOCKS5 proxy is enabled but the bridge is not running. Check proxy settings."` 错误消息。

### 注入点（完整清单）

共 17 个 fetch 调用需要注入 `proxy` 参数：

**GitHub 域（5 处）**——传 `getProxyUrl("github", state)`：

| 文件 | 调用 |
|------|------|
| `services/github/get-device-code.ts` | `fetch("https://github.com/login/device/code", ...)` |
| `services/github/poll-access-token.ts` | `fetch("https://github.com/login/oauth/access_token", ...)` |
| `services/github/get-user.ts` | `fetch("https://api.github.com/user", ...)` |
| `services/github/get-copilot-token.ts` | `fetch("https://api.github.com/copilot_internal/v2/token", ...)` |
| `services/github/get-copilot-usage.ts` | `fetch("https://api.github.com/copilot_internal/user", ...)` |

**Copilot 域（4 处）**——传 `getProxyUrl("copilot", state)`：

| 文件 | 调用 |
|------|------|
| `services/copilot/get-models.ts` | `fetch(\`${copilotBaseUrl}/models\`, ...)` |
| `services/copilot/create-chat-completions.ts` | `fetch(\`${copilotBaseUrl}/chat/completions\`, ...)` |
| `services/copilot/create-responses.ts` | `fetch(\`${copilotBaseUrl}/responses\`, ...)` |
| `services/copilot/create-embeddings.ts` | `fetch(\`${copilotBaseUrl}/embeddings\`, ...)` |

**Custom Provider 数据面（2 处）**——传 `getProxyUrl(provider, state)`：

| 文件 | 调用 |
|------|------|
| `services/upstream/send-openai.ts` | `fetch(\`${provider.base_url}/v1/chat/completions\`, ...)` |
| `services/upstream/send-anthropic.ts` | `fetch(\`${provider.base_url}/v1/messages\`, ...)` |

**Custom Provider 管理面（4 处）**——跟随对应 provider 策略：

| 文件 | 调用 | 代理策略 |
|------|------|----------|
| `routes/upstreams.ts:120` | 创建/更新时探活 `{base_url}/v1/models` | 见下文 |
| `routes/upstreams.ts:325` | 按需拉模型列表 | `getProxyUrl(provider, state)` |
| `routes/connection-info.ts:32` | 连接状态检查 | `getProxyUrl(provider, state)` |
| `routes/models/route.ts:53` | 统一模型列表 | `getProxyUrl(provider, state)` |

**新建 provider 时的首次 probe**：此时 `use_socks5` 尚未设置（NULL = 默认不走代理），首次 probe 始终直连。这是合理的默认行为——绝大多数 provider 可直连访问。对于"只能经 SOCKS5 访问"的 provider，首次 probe 可能失败（`supports_models_endpoint` 记为 `false`），但不阻塞创建。用户在 SOCKS5 设置页面为该 provider 配置 Force On 后，后续的模型拉取和连接检查会自动走代理。**但 `supports_models_endpoint` 不会自动恢复**——现有代码在 `routes/connection-info.ts:92` 和 `routes/models/route.ts:116` 会跳过 `supports_models_endpoint !== 1` 的 provider。用户必须手动 Re-probe：Dashboard 的 provider 详情页提供 **Re-probe** 按钮（复用现有 `GET /api/upstreams/:id/models`），成功后更新 `supports_models_endpoint=1`。SOCKS5 设置页面的 provider 列表中，对 `supports_models_endpoint=false` 且 `use_socks5=1` 的 provider 显示提示："Probe failed before proxy was enabled — click Re-probe to retry"。

**不走代理（2 处）**——不注入：

| 文件 | 调用 | 理由 |
|------|------|------|
| `services/get-vscode-version.ts` | AUR 版本抓取 | 与 IP 隐蔽无关 |
| `lib/server-tools/tavily.ts` | Tavily 搜索 | 第三方服务，无关 |

### 统一注入方式

```ts
// Before
const res = await fetch(url, { headers, body, ... });

// After
const res = await fetch(url, {
  headers, body, ...
  proxy: getProxyUrl("copilot", state),  // or "github" or provider
} as any);
```

### Bridge 生命周期

- **启动**：proxy 服务启动时，在 token 初始化（`setupGitHubToken` / `setupCopilotToken`）**之前**调用 `startBridge()`。若 `socks5_enabled` 为 true 且 `startBridge()` 失败，**proxy 进程直接终止**（fail-hard）。原因：后续的 `setupCopilotToken()` → `getCopilotToken()` 需要走代理访问 `api.github.com`，bridge 不可用时这些调用必然失败；与其让启动链路在 token 阶段报出误导性错误，不如在 bridge 阶段就明确终止并给出 SOCKS5 相关的错误信息。若 `socks5_enabled` 为 false，跳过 bridge 启动。
- **配置变更**：`PUT /api/settings/socks5` 端点执行 **try-before-commit** 流程：
  1. 用新配置尝试 `startBridge(newConfig)` → 成功拿到新 port
  2. 成功 → 写入 DB + 更新 state + `stopBridge(old)`，返回 200
  3. 失败 → 不写 DB，不动当前 bridge，返回 400 + 错误信息（如 "SOCKS5 connection refused"）
  4. 若 `enabled` 从 true → false，直接 `stopBridge()` + 写 DB，无需尝试连接
- **关闭**：proxy 服务关闭时 `stopBridge()`

### Fail-closed 策略

分两个阶段：

**启动阶段（fail-hard）**：`socks5_enabled=true` 时，bridge 启动失败 → proxy 进程终止，不进入监听。日志输出 SOCKS5 连接错误详情。用户必须修复 SOCKS5 配置或关闭功能后重启。

**运行时（fail-closed）**：bridge 在运行中崩溃/断开时，`socks5BridgePort` 置 `null`，**不回退到直连**——这会泄露真实出口 IP，与功能核心目标矛盾。`getProxyUrl()` 对需要走代理的 upstream 抛错（逻辑见上方决策伪码），调用方返回 502。

---

## API 端点

SOCKS5 配置使用**专用的原子化端点**，不复用现有的 `PUT /api/settings`（后者为单 key 写入，无法支持"先填完表单再一次性保存"的交互，且会在填写过程中反复重启 bridge）。

所有端点挂在 `/api/*` 下，统一走现有的 `dashboardAuth` 鉴权（`packages/proxy/src/app.ts:54`）。Dashboard 的 `proxyFetch` 直接拼 path 到 proxy URL（`packages/dashboard/src/lib/proxy.ts:30`），路径在两侧保持一致。

### Proxy 端（新增路由文件 `routes/settings-socks5.ts`，挂载到 `/api/settings/socks5`）

```
GET  /api/settings/socks5
```

返回当前配置（密码脱敏）：

```json
{
  "enabled": true,
  "host": "example.com",
  "port": 1080,
  "username": "user",
  "hasPassword": true,
  "copilotPolicy": "default",
  "providerPolicies": [
    { "id": "provider-uuid", "name": "OpenRouter", "use_socks5": null, "supports_models_endpoint": true },
    { "id": "provider-uuid", "name": "Ollama", "use_socks5": 0, "supports_models_endpoint": true }
  ]
}
```

```
PUT  /api/settings/socks5
```

原子化保存全部配置。执行 **try-before-commit**：先用新配置启动 bridge，成功才写 DB；失败返回 400，不动现有配置和 bridge。

```json
{
  "enabled": true,
  "host": "example.com",
  "port": 1080,
  "username": "user",
  "password": "newpass",
  "copilotPolicy": "default",
  "providerPolicies": [
    { "id": "provider-uuid", "use_socks5": 1 }
  ]
}
```

- `password` 为 `string` → 更新；为 `null` → 清除；缺失 → 保留原值
- `providerPolicies` 只需传有变更的 provider，未传的保留原值

```
POST /api/settings/socks5/test
```

测试连通性。使用请求体中的配置（而非已保存的配置），支持"填完表单 → 测试 → 再保存"的流程：

```json
{
  "host": "example.com",
  "port": 1080,
  "username": "user",
  "password": "pass"
}
```

返回：

```json
{
  "success": true,
  "ip": "x.x.x.x",
  "latencyMs": 320
}
```

测试方式：用请求体中的配置临时创建 SOCKS5 连接，通过隧道请求一个公共 IP 检测服务，不依赖已启动的 bridge。

---

## Dashboard 界面

### 设置页新增 SOCKS5 Proxy 区域

位置：`packages/dashboard/src/app/(app)/settings/page.tsx`，作为新的设置卡片。

**布局**：

```
┌─ SOCKS5 Proxy ──────────────────────────────────────────┐
│                                                          │
│  [Toggle] Enable SOCKS5 Proxy                            │
│                                                          │
│  ┌─ Connection ──────────────────────────────────────┐   │
│  │  Host:     [________________]  Port: [______]     │   │
│  │  Username: [________________]  (optional)         │   │
│  │  Password: [________________]  (optional)         │   │
│  │                                                   │   │
│  │  [Test Connection]  ✅ Connected (IP: x.x.x.x)   │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  ┌─ Upstream Routing ────────────────────────────────┐   │
│  │                                                   │   │
│  │  GitHub Copilot          [Default (On) ▾]         │   │
│  │  ─────────────────────────────────────────        │   │
│  │  Anthropic Direct        [Default (Off) ▾]        │   │
│  │  Ollama Local            [Default (Off) ▾]        │   │
│  │  OpenRouter              [Force On       ▾]       │   │
│  │                                                   │   │
│  │  Default: Copilot = On, Custom providers = Off    │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│                               [Save]                     │
└──────────────────────────────────────────────────────────┘
```

**交互**：
- Toggle 关闭时，Connection 和 Upstream Routing 区域 disabled
- 表单为受控状态，用户填完后点 **Save** 一次性提交 PUT 请求
- **Test Connection** 按钮：使用当前表单值（非已保存值）调用 POST test 端点，支持"填 → 测 → 存"流程
- 每个 upstream 的 select 选项：`Default (On/Off)` / `Force On` / `Force Off`
- 括号中的 On/Off 标注当前 upstream 的默认策略
- password 输入框状态机（三态）：
  - **pristine**（初始）：已设置时 `type=password` 显示 placeholder "••••••••"，value 为空字符串。提交时 password 字段**不发送**（undefined = 保留）。
  - **edited**：用户输入了新值（`onChange` 触发），value 为用户输入。提交时发送 `password: value`（string = 更新）。
  - **cleared**：用户点击输入框旁的"清除"按钮（×），显示空输入框 + "Password cleared" 提示。提交时发送 `password: null`（null = 清除）。
  - 前端维护 `passwordState: "pristine" | "edited" | "cleared"` 标志，与 value 独立追踪。这避免了"用户没动 → 空字符串"和"用户主动清空 → 空字符串"的歧义。

---

## 依赖

```
bun add socks    # packages/proxy
```

`socks` 已验证在 Bun 1.3.11 上完全兼容（TCP 隧道 + 认证 + 超时）。

---

## 原子化提交计划

| # | Commit | 内容 | 涉及文件 |
|---|--------|------|----------|
| 1 | `feat(proxy): add socks5-bridge module` | 桥的核心实现 + 单元测试 | `lib/socks5-bridge.ts`, `tests/socks5-bridge.test.ts` |
| 2 | `feat(proxy): add socks5 settings and DB migration` | settings KV + providers 表迁移 + state 扩展 + 受影响的测试 fixtures | `db/settings.ts`, `db/providers.ts`, `lib/state.ts`, `lib/utils.ts`, `test/services/upstream/send-openai.test.ts`, `test/routes/connection-info.test.ts` 及其他构造 `ProviderRecord` 的测试文件 |
| 3 | `feat(proxy): add socks5 settings API routes` | 专用原子化端点（GET/PUT/POST test）+ 鉴权 | `routes/settings-socks5.ts`, `app.ts`, `tests/settings-socks5.test.ts` |
| 4 | `feat(proxy): inject proxy into all upstream fetch calls` | 17 个调用点注入 `getProxyUrl()` + 2 处明确不注入 | `services/github/*.ts`, `services/copilot/*.ts`, `services/upstream/*.ts`, `routes/upstreams.ts`, `routes/connection-info.ts`, `routes/models/route.ts` |
| 5 | `feat(proxy): bridge lifecycle management` | 启动/配置变更重启/关闭 | `index.ts`, `lib/socks5-bridge.ts` |
| 6 | `feat(dashboard): add socks5 proxy settings UI` | 设置页面 + API hooks + 受控表单 | `app/(app)/settings/`, `lib/api/` |
| 7 | `test: socks5 proxy unit tests` | getProxyUrl 决策矩阵、API validation、DB migration | `tests/socks5-*.test.ts` |

---

## 测试计划

### L1 — 单元测试

| 测试 | 描述 |
|------|------|
| `socks5-bridge.test.ts` | Bridge 启停、idempotent restart、config 变更重启 |
| `getProxyUrl()` | 所有 upstream 类型 × 所有策略组合的决策矩阵 |
| `settings-socks5.test.ts` | GET 密码脱敏、PUT 原子保存、password 三态语义（更新/清除/保留）、validation |
| DB migration | `use_socks5` 列存在性 + NULL 默认值 |

所有 upstream fetch 测试中 mock `getProxyUrl()` 返回值，验证 `proxy` 参数正确传递到全部 17 个调用点。

### L2 — E2E（手动）

连接真实 SOCKS5 代理，验证出口 IP 变化。遵循 anti-ban protocol，仅手动执行。

### G1 — 静态分析

新代码通过 eslint + tsc 零错误零警告。
