# 24 — Chat Completions ↔ Responses Endpoint Auto-Shim

> 状态：**Design — Codex 二轮复审已合入（§15 Q4/Q5）；可签核实施**
> 范围：`packages/proxy` 路由决策 + 协议翻译 + 第 7 策略；不改 Manifest / Dashboard
> 关键属性：**catalog-driven 热更新** + **client Chat shape 不变** + **upstream `/responses` 一跳** + **failed 不得误报成功** + **tool call_id 往返**
> 关联：`docs/16-openai-responses-api.md`（Responses 入向透传）、`docs/18-native-anthropic-messages.md`（`supported_endpoints` 门闩先例）、`docs/20-architecture-refactor.md`（七层 + Strategy）、`docs/23-token-sentinel.md`（`cacheModels` 刷新路径）

---

## 1. 背景与问题

### 1.1 症状

Manifest 等下游对 custom provider 只硬编码两种出向：

| `api_kind` | 出向 path | body shape |
|---|---|---|
| `openai` | `POST /v1/chat/completions` | Chat Completions |
| `anthropic` | `POST /v1/messages` | Anthropic Messages |

**没有** `/v1/responses` 选项。而 Copilot 对新模型逐步只暴露 Responses API。实测：

```http
POST /v1/chat/completions  { "model": "grok-4.5", "messages": [...] }
→ 400
{"error":{"message":"model \"grok-4.5\" is not accessible via the /chat/completions endpoint","code":"unsupported_api_for_model"}}
```

### 1.2 全量 endpoint 分布（2026-08-04，`GET /v1/models`）

| 分组 | `supported_endpoints` | 数量 | 代表 | 本 shim |
|---|---|---|---|---|
| 仅 Responses | `['/responses']` | 3 | `grok-4.5`, `mai-code-1-flash`, `mai-code-1-flash-picker` | ✅ 触发 |
| 仅 Responses + ws | `['/responses','ws:/responses']` | 6 | `gpt-5.3-codex`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-*` | ✅ 触发 |
| 两栖 | 含 `/responses` **且** `/chat/completions` | 2 | `gpt-5.4`, `gpt-5-mini` | ❌ 仍走 chat 直通 |
| 仅 Chat | `['/chat/completions']` | 4 | `gemini-3.*`, `trajectory-compaction` | ❌ 直通 |
| 未声明 | `[]` / 缺失 | 18 | Azure 老模型 `gpt-4o` 等 | ❌ 直通（兜底） |

**结论**：至少 **9** 个 model 今天经 Manifest 完全不可达；池子只会扩大。

### 1.3 现状架构缺口

| 事实 | 代码位置 |
|---|---|
| 路由按 **client path/protocol** 选策略，不看 endpoint 能力 | `core/router.ts` `pickStrategy` |
| `protocol:"openai"` → 恒 `copilot-openai-direct`（无 custom 时） | 同上 L127–136 |
| `protocol:"responses"` → 恒 `copilot-responses` | 同上 L138–143 |
| `supported_endpoints` 已缓存，**仅** 用于 Anthropic native 门闩 | `strategies/support/model-capabilities.ts` |
| Chat↔Responses 翻译 **不存在** | `protocols/` 只有 A↔O + responses metrics |
| 最近似模式 | `copilot-translated`（Anthropic client → OpenAI upstream） |

`docs/16` 写明 `/v1/responses` **入向** 是 passthrough、不做翻译——本设计 **不推翻** 该契约，而是新增 **Chat 入向 → Responses 上游** 的对称适配层。

---

## 2. 目标与非目标

### 2.1 Goals

1. **对调用方透明**：`POST /v1/chat/completions` 接受任意 catalog model；responses-only 模型自动经 shim 成功返回合法 Chat Completions JSON/SSE。
2. **Catalog-driven 热更新**：判定只读 `state.models` 的 `supported_endpoints`；模型列表定期刷新后 **无需重启** 即生效。
3. **零额外上游 hop**：仍是 Raven → Copilot 一跳（不是 chat 失败再 retry responses）。
4. **架构对齐 docs/20**：新能力 = pure `protocols/` + 新 `Strategy` + `pickStrategy` 分支；不污染现有 passthrough 策略。
5. **可观测**：`request_end.data.routingPath = "chat-via-responses"`，便于日志/排障。
6. **回归安全**：empty endpoints / 仅 chat / 两栖 / custom provider 行为与现网一致。

### 2.2 Non-Goals

- 改 Manifest / 任何客户端
- Custom provider 的 Responses 支持
- 反向 shim（`/v1/responses` → 上游 chat）— 列为 Phase E 可选
- `previous_response_id` 会话状态机
- 完整 vision / reasoning / encrypted content 保真（首版 best-effort 或 strip）
- 修改 Copilot 返回的 `supported_endpoints` 源数据
- Dashboard UI
- 上游 400 后自动 retry 另一 path（anti-ban + 双倍请求）

### 2.3 成功标准

- [ ] Manifest `api_kind:openai` + `grok-4.5`（及另外 8 个 responses-only）non-stream / stream → 200，合法 Chat Completions shape
- [ ] `gpt-4o`（empty）、`gemini-*`（仅 chat）、`gpt-5.4`（两栖）仍走 `/chat/completions`，L1 回归 0 diff
- [ ] 刷新 catalog 后（见 §4）新出现的 responses-only model **不重启** 即可走 shim
- [ ] L1 全绿；新模块覆盖路由 + 映射 + stream 状态机
- [ ] `bun run gate:arch` / typecheck / lint 绿

---

## 3. 方案总览

### 3.1 一句话

新增第 7 策略 **`copilot-chat-via-responses`**：入向 Chat Completions shape，出向 `CopilotResponsesClient`（`/responses`），响应/SSE 译回 Chat Completions；由 `pickStrategy` 基于 **live** `supported_endpoints` 自动选择。

### 3.2 请求路径

```
Client  POST /v1/chat/completions   (ChatCompletionsPayload)
   │
   │  apiKeyAuth → refreshModelsIfStale()   ← 已有；保证 catalog 热
   ▼
handleCompletion
   │  normalizeTokenLimitParams
   │  composition.dispatch(protocol="openai", models=state.models.data)
   ▼
pickStrategy(openai, model, modelsCatalog[])
   ├─ custom provider match     → custom-openai | reject
   ├─ isResponsesOnly(endpoints)→ copilot-chat-via-responses   ← NEW
   └─ else                      → copilot-openai-direct
   ▼
Strategy (7-method)
   prepare  → ChatViaResponsesUpReq { originalChat, includeUsage, responsesPayload }
   dispatch → assert n/stop → CopilotResponsesClient.send(responsesPayload)
   adaptJson / adaptChunk → Chat Completions shape（failed → throw）
   ▼
Client  chat.completion | chat.completion.chunk SSE
```

**Client 契约不变**：`ctx.path = "/v1/chat/completions"`，`format = "openai"`。

### 3.3 为何不是其他方案

| 方案 | 否决 |
|---|---|
| 改 Manifest 加 responses 出向 | 短期不做；且只惠及 Manifest |
| `copilot-openai-direct` 内 if | 破坏「一策略一上游协议」；stream 状态机缠死 |
| 上游 400 再 retry `/responses` | 双请求、anti-ban、延迟；catalog 已有权威字段 |
| Handler 改 path 后调 `protocol:"responses"` | 客户端要 Chat shape；`copilot-responses` 吐 Responses SSE |
| 硬编码 model 名列表 | 过期、误伤两栖；劣质缓存副本 |

### 3.4 性能（翻译 vs native）

| 项 | 说明 |
|---|---|
| 额外上游 hop | **0** |
| CPU | 请求/响应 remap + 流式状态机；与 `copilot-translated` 同级 |
| 相对上游 RTT | 可忽略（生成通常 100ms～数秒） |
| 真·零翻译 | 客户端直接打 `/v1/responses`（Raven 已支持 `copilot-responses`） |
| 本 shim 必要性 | Manifest 只说 Chat，上游只收 Responses → shape 转换 **不可省** |

「按 model 名走 native」行不通：native 要么是 Chat 透传（上游拒），要么是 Responses 透传（客户端解不了）。名字列表只替代判定、不替代翻译；判定我们用更好的 `supported_endpoints`。

---

## 4. Model 判定与热更新（评审焦点 #1）

### 4.1 唯一判定信号

**`state.models.data[i].supported_endpoints`**，来自 Copilot `GET {base}/models`，Raven **原样缓存**，不做合成。

Pure 判定（`protocols/chat-responses/endpoints.ts`）：

```ts
export function isChatEndpoint(ep: string): boolean {
  return ep === "/chat/completions" || ep === "/v1/chat/completions"
}

export function isResponsesEndpoint(ep: string): boolean {
  return ep === "/responses" || ep === "/v1/responses"
  // 注意：不把 "ws:/responses" 算作 HTTP responses 能力信号的唯一来源，
  // 但 ws 条目也不算 chat。
}

export function isResponsesOnly(endpoints: string[] | undefined | null): boolean {
  if (!endpoints || endpoints.length === 0) return false
  const hasChat = endpoints.some(isChatEndpoint)
  const hasResponses = endpoints.some(isResponsesEndpoint)
  return hasResponses && !hasChat
}
```

| endpoints | `isResponsesOnly` | strategy |
|---|---|---|
| `['/responses']` | true | shim |
| `['/responses','ws:/responses']` | true | shim |
| `['/responses','/chat/completions']` | false | direct |
| `['/chat/completions']` | false | direct |
| `[]` / missing | false | direct（Azure 兜底） |
| model 不在 catalog | false | direct |

**禁止**：硬编码 `grok-*` / `codex` 前缀；单独持久化「shim 名单」。

### 4.2 为何热更新「免费」——复用现有 catalog 刷新

`supported_endpoints` **已经** 是 model 对象字段，随 `cacheModels()` 整体替换。本功能 **不新增探测通道**，只保证路由 **每次请求读 live catalog**。

#### 4.2.1 现有刷新入口（全部保留）

| 触发 | 位置 | 行为 |
|---|---|---|
| 进程启动 | `index.ts` → `await cacheModels()` | 阻塞至首份 catalog |
| **每个** AI API 鉴权通过 | `middleware.ts` `apiKeyAuth` → `refreshModelsIfStale()` | TTL 1h 过期则 **fire-and-forget** 后台刷新 |
| Token Sentinel tick | `token-sentinel.ts` tick 内 `await cacheModels()` | 与 token 探活同周期；401 计入 sentinel 信号 |
| 手动 / Dashboard | `routes/copilot-info.ts`、`connection-info.ts` 等 `await cacheModels()` | 强制刷新 |
| `GET /v1/models` 且 cache 空 | `routes/models/route.ts` | 懒加载 |

实现锚点：

```20:38:packages/proxy/src/lib/utils.ts
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models          // 整表替换，含 supported_endpoints
  modelsCachedAt = Date.now()
}
export function refreshModelsIfStale(): void {
  if (Date.now() - modelsCachedAt < MODEL_CACHE_TTL_MS) return
  if (modelsRefreshing) return
  modelsRefreshing = cacheModels().catch(() => {}).finally(() => { modelsRefreshing = null })
}
```

```134:134:packages/proxy/src/middleware.ts
    refreshModelsIfStale();
```

#### 4.2.2 热更新不变量（本设计强制）

| ID | 不变量 | 实现约束 |
|---|---|---|
| H-1 | **禁止** 在 boot 时把 `isResponsesOnly` 结果固化成 `Set<modelId>` 全局表 | 判定只发生在 `pickStrategy` 调用时 |
| H-2 | `pickStrategy` / composition 每次从 **当前** `state.models.data`（或等价快照参数）取 endpoints | `DispatchInput.models` 传完整 `{id, supported_endpoints?}[]`，不在 composition 入口 `.map(id)` 丢字段 |
| H-3 | `cacheModels` 成功 → `state.models` 引用整体替换 | 已有；不引入增量 patch 漏字段 |
| H-4 | 刷新失败不清空旧 catalog | 已有 catch swallow；路由继续用上一份 |
| H-5 | 新 model 出现在上游 catalog 后，最迟 **一个 TTL 窗口**（默认 1h）或下一次 sentinel/手动刷新后可被 shim | 无需重启进程 |
| H-6 | 本功能 **不** 新增定时器 / 独立 probe URL | 复用 `getModels` 响应体 |

#### 4.2.3 是否需要改刷新逻辑？

| 项 | 结论 |
|---|---|
| 新增专用 endpoint 探测 | **否** — `supported_endpoints` 已在 `/models` 响应 |
| 缩短 TTL | **否（默认）** — 1h 与现网一致；若评审要求可配置化另开 commit，非本功能阻塞 |
| 请求路径强制 await 刷新 | **否** — 保持 fire-and-forget，避免拉高 P99；H-5 可接受 |
| 文档/测试要锁定的行为 | 单测模拟「catalog 从 empty → responses-only」后，同进程下一次 `pickStrategy` 即选 shim（**不** 重启） |

#### 4.2.4 验收场景（热更新）

```
t0: state.models 无 grok-4.5  → pick → copilot-openai-direct
t1: cacheModels() 注入 grok-4.5 + endpoints=['/responses']
t2: 同进程 pickStrategy(openai, "grok-4.5", catalog') → copilot-chat-via-responses
t3: cacheModels() 把 grok-4.5 改为两栖 endpoints
t4: pick → 回到 copilot-openai-direct
```

对应 L1：`test/core/router-live-catalog.test.ts`（或并入 router fixtures 的 sequential case）。

---

## 5. 路由决策细节

### 5.1 扩展 `RouterInput`

```ts
// core/router.ts
export interface CatalogModel {
  id: string
  supported_endpoints?: string[]
}

export interface RouterInput {
  protocol: ClientProtocol
  model: string
  anthropicBeta?: string | null
  providers: CompiledProvider[]
  /** @deprecated 迁移期可保留；新逻辑优先 modelsCatalog */
  modelsCatalogIds: string[]
  /** 完整 catalog 条目；openai 分支读 supported_endpoints */
  modelsCatalog?: CatalogModel[]
}
```

**兼容策略**：`modelsCatalog` 缺省时 openai 行为与今日完全一致（永远 direct）。Anthropic 分支可继续只用 ids。实施 commit 中 handler + composition **同时** 传 `modelsCatalog`，再删对「仅 ids」的依赖（若有）。

### 5.2 `protocol === "openai"` 伪代码

```ts
if (protocol === "openai") {
  const matched = matchProvider([model], providers)
  if (matched) {
    if (matched.provider.format === "anthropic") return REJECT_OPENAI_TO_ANTHROPIC
    return { kind: "ok", name: "custom-openai", providerId: matched.provider.id }
  }
  const entry = modelsCatalog?.find(m => m.id === model)
  if (isResponsesOnly(entry?.supported_endpoints)) {
    return { kind: "ok", name: "copilot-chat-via-responses" }
  }
  return { kind: "ok", name: "copilot-openai-direct" }
}
```

### 5.3 决策必须在 `pickStrategy`，禁止 handler 单门闩

现状 **双调用**：

1. `routes/chat-completions/handler.ts` 先 `pickStrategy`（分 custom / reject）
2. `composition.dispatch` **再** `pickStrategy` 并 `buildStrategy`

若只在 handler 改道，composition 仍选出 `copilot-openai-direct`，shim 被冲掉。  
（`messages` 的 `supportsNativeMessages` runtime gate 有同类隐患；**本功能禁止复制该模式**。）

### 5.4 新 `StrategyName`

```ts
| "copilot-chat-via-responses"
```

同步：`core/strategy.ts` `STRATEGY_NAMES`、`composition/strategy-registry.ts`、`test/core/strategy.test.ts`（length 6→7）。

---

## 6. 协议映射

### 6.1 模块布局（pure zone）

```
packages/proxy/src/protocols/chat-responses/
  endpoints.ts       # isChatEndpoint / isResponsesEndpoint / isResponsesOnly
  request.ts         # chatRequestToResponses
  response.ts        # responsesJsonToChatCompletion
  stream.ts          # ResponsesStreamToChatState + adapt event → chunks
  finish-reason.ts   # status / incomplete → finish_reason（不含 failed→success）
  types.ts           # 窄类型（避免 any 蔓延）
  errors.ts          # ResponsesFailure → 可抛出的协议错误（供 adaptJson / adaptChunk）
```

**dep-cruiser**：`protocols/**` 不得 import `state` / `log-emitter` / `hono`（已有规则 #1）。

### 6.2 失败语义（P0 — 不得误报成功）

Responses 的失败是 **普通 SSE/JSON 字段**，不是 HTTP 非 2xx。Runner 只在 `adaptChunk` **抛错** 或上游 iterator 抛错时调用 `adaptStreamError`（见 `core/runner.ts`）。因此 shim **禁止** 把 `response.failed` / `event:error` 当成成功 terminal。

| 路径 | 条件 | 必须行为 |
|---|---|---|
| **非流式 `adaptJson`** | body `status === "failed"` 或存在顶层 `error` | **抛出** 协议错误（`HTTPError` 或 strategy 约定错误类型）；**不得** 返回 `chat.completion` 200 body |
| **流式 `adaptChunk`** | `event === "error"` 或 `event === "response.failed"`（或 data.type 同上） | **抛出**（或返回后由 strategy 抛出），进入 Runner 的 `adaptStreamError` 路径；**不得** 发 `finish_reason` 成功收尾 chunk，**不得** 发 `data: [DONE]` 作为成功结束 |
| **流式成功 terminal** | 仅 `response.completed` / `response.incomplete`（及等价 done） | 才允许 `finish_reason` + 可选 usage + `[DONE]` |
| **`request_end`** | 上述失败路径 | `describeEndLog` / Runner 记 **error**（非 200 success）；`routingPath` 仍可保留 |

L1 必测：

- non-stream fixture：`status:"failed"` → throw，无 choices
- stream fixture：golden 中真实 `response.failed` 序列 → 客户端收到 **OpenAI chat error envelope**，无成功 `[DONE]`
- `request_end` 带 error 字段

> 历史笔误：早期草稿把 `failed` 与 `completed` 并列写进成功 terminal——**已废止**。以本节为准。

### 6.3 请求 Chat → Responses

#### 6.3.1 字段分类总表（映射 / 本地消费 / 明确拒绝 / 安全忽略）

| 分类 | 字段 | 行为 |
|---|---|---|
| **映射** | `model` | → `model` |
| **映射** | `messages[]` | → `input`（§6.3.2） |
| **映射** | `max_completion_tokens` / `max_tokens` | → `max_output_tokens`（handler 已 normalize 到单一 token 字段后再映） |
| **映射** | `stream` | → `stream` |
| **映射** | `tools[]` | → Responses `tools[]`（§6.3.3，含 `strict`） |
| **映射** | `tool_choice` | 规范化到 Responses 形状（`"auto"\|"none"\|"required"\|{type:"function",name}`） |
| **映射** | `temperature`, `top_p`, `user` | 同名透传 |
| **映射** | `response_format` | → `text.format`（json_schema / json_object / text；形状按官方 migrate 指南转换） |
| **映射** | `reasoning_effort` | → `reasoning.effort` |
| **本地消费** | `stream_options.include_usage` | **绝不**写入 Responses JSON body；经 §7 wrapper 的 `includeUsage` 字段保存；成功 terminal 时附加 usage chunk（形状 §6.5） |
| **明确拒绝 400** | `n` 存在且 `n !== 1` | `invalid_request_error`：shim 不支持多 choice；**禁止**静默改成 1 |
| **明确拒绝 400** | `stop`（非空） | 无稳定 Responses 等价；首版拒绝并提示 |
| **安全忽略** | `logit_bias`, `logprobs`, `top_logprobs`, `presence_penalty`, `frequency_penalty`, `suffix`, … | 无害丢弃；debug 可记 `droppedFields` |
| **安全忽略** | `previous_response_id`（client 误传） | 丢弃；不建立 Responses 会话链 |
| **安全忽略** | 未列出的未知字段 | 默认丢弃（不透传），避免上游 400 |

#### 6.3.1a 本地 400 校验与 `request_end`（P0）

**事实**：`core/runner.ts` 在 `try` **之外** 调用 `strategy.prepare`；`prepare` 抛错时 **不会** `emitErrorEnd`，破坏「每请求一条 `request_end`」契约（sink / 统计依赖此不变量）。

**本 shim 强制约定（不改 Runner 全局行为）：**

| 阶段 | 允许做什么 | 禁止 |
|---|---|---|
| `prepare` | **纯转换** + 组装 `ChatViaResponsesUpReq`（§7）；可做非抛错的字段丢弃 | **禁止** 对 `n`/`stop` 等抛 400 |
| `dispatch`（在 Runner 的 try 内） | 调用 `assertChatViaResponsesSupported(originalChat)`；不通过则 `throw HTTPError(400, ...)` | 不得在 `client.send` 之后才发现可本地拒绝的参数 |
| `adaptJson` / `adaptChunk` | 上游协议失败 throw（已有 try 覆盖 → 有 `request_end`） | — |

伪代码：

```ts
prepare(chat) {
  return {
    originalChat: chat,
    includeUsage: !!chat.stream_options?.include_usage,
    responsesPayload: chatRequestToResponses(chat), // 不校验 n/stop
  }
}
async dispatch(up) {
  assertChatViaResponsesSupported(up.originalChat) // throws HTTPError 400
  return client.send(up.responsesPayload)
}
```

路由层 `forwardError` 仍负责 HTTP 400 body；Runner 的 `emitErrorEnd` 负责 `request_end`。

**可选后续（非本功能阻塞）**：Runner 将 `prepare` 移入 try——惠及所有策略；另开 commit，不绑 shim。

L1：mock strategy/`execute` 路径，`n=2` → 400 **且** 观测到一条 `request_end`（error 臂）。

#### 6.3.2 `messages` → `input` 与工具 ID（P0）

| Chat message | Responses input item |
|---|---|
| `{role:"system", content}` | `{role:"system", content}`（保留 system；不强制塞 `instructions`） |
| `{role:"developer", content}` | `{role:"developer", content}`（**保留 developer，禁止降级为 system**） |
| `{role:"user", content: string\|parts}` | `{role:"user", content: ...}`；image_url → best-effort `input_image` |
| `{role:"assistant", content, tool_calls?}` | message item + 后续 `function_call` items |
| `{role:"tool", tool_call_id, content}` | `{type:"function_call_output", call_id: tool_call_id, output}` |

**工具调用 ID 不变量（P0，单测钉死）：**

| 方向 | 规则 |
|---|---|
| Chat → Responses | `function_call.call_id = tool_call.id`（Chat 侧的 `tool_calls[].id`） |
| Chat → Responses | `function_call_output.call_id = message.tool_call_id` |
| Responses → Chat | `tool_calls[].id = function_call.call_id`（**不是** item `id`） |
| 流式 | Responses item `id`（如 `fc_...` item id）**仅** 用于关联 `function_call_arguments.delta` → index；**不得** 写入 Chat `tool_calls[].id` |
| 缺 `call_id` | 视为上游缺陷：非流式 throw / 流式走错误路径；禁止用 item id 冒充 |

依据：OpenAI Function calling 流式文档要求后续 `role:"tool"` 与 `call_id` 对齐。

#### 6.3.3 `tools[]` 与 `strict`（P1）

Chat：

```ts
{ type: "function", function: { name, description?, parameters?, strict?: boolean } }
```

Responses：

```ts
{ type: "function", name, description?, parameters?, strict: boolean }
```

**强制：**

```ts
strict: chatTool.function.strict ?? false
```

原因：Chat 默认非 strict；Responses **省略 `strict` 时会尝试 strict**，会改变工具 schema 校验语义（见 OpenAI migrate-to-responses § function definitions）。  
单测：Chat 无 `strict` → 上游 body `strict: false`；Chat `strict: true` → 原样 true。

### 6.4 响应 Responses → Chat（非流式）

#### 6.4.1 完整 Chat Completions 形状（P1）

成功时（`status` 为 `completed` 或 `incomplete`）必须产出合法 `chat.completion`：

```ts
{
  id: string,                    // 策略：保留 Responses id 原样（单测钉死；不加 chatcmpl- 前缀，避免双 id 体系）
  object: "chat.completion",
  created: number,               // = response.created_at（秒）；缺失则 floor(Date.now()/1000)
  model: string,                 // response.model ?? 请求 model
  system_fingerprint: null,      // 固定 null（Responses 无稳定等价）
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: string | null,    // 纯 tool_calls 时必须 null（不是 ""）
      tool_calls?: [...],        // 有 function_call 时必填；id = call_id
      refusal?: null
    },
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter",
    logprobs: null,              // 固定 null
  }],
  usage: {
    prompt_tokens: number,       // usage.input_tokens ?? 0
    completion_tokens: number,   // usage.output_tokens ?? 0
    total_tokens: number,        // 两者之和（或 usage.total_tokens）
    prompt_tokens_details: null,
    completion_tokens_details: null,
  } | null
}
```

#### 6.4.2 `finish_reason` 优先级

按 **高 → 低** 判定，命中即停：

1. 存在任意 `function_call` output → `"tool_calls"`
2. `status === "incomplete"` 且 `incomplete_details.reason` 含 max tokens / `max_output_tokens` → `"length"`
3. 内容过滤 / `content_filter` 类 reason → `"content_filter"`
4. 否则 → `"stop"`

`status === "failed"`：**不** 走本表，见 §6.2 抛错。

#### 6.4.3 字段对照简表

| Responses | Chat Completions |
|---|---|
| `id` | `id` |
| `created_at` | `created` |
| `model` | `model` |
| `output[]` message text parts | `choices[0].message.content`（无 text 且有 tool → `null`） |
| `output[]` `function_call` | `tool_calls[]`，**`id = call_id`** |
| `status` / `incomplete_details` | `finish_reason`（§6.4.2） |
| `usage.input_tokens` / `output_tokens` | `prompt_tokens` / `completion_tokens` |
| — | `object`, `system_fingerprint:null`, `logprobs:null` |

### 6.5 流式状态机（P1）

事件 → Chat chunk 要点：

1. `response.created`（或首个有用事件）→ 发 `role:"assistant"` 的起始 chunk（id/model/created）
2. `response.output_text.delta` → `delta.content`
3. function_call：item added 时记录 `itemId → index`，并向客户端发  
   `delta.tool_calls[{ index, id: call_id, type:"function", function:{ name, arguments:"" } }]`  
   （**`id` 必须是 `call_id`**；item id 只进内部 Map）
4. `response.function_call_arguments.delta` → 按 item id 查 index，增量 `arguments`
5. **成功** terminal：仅 `response.completed` / `response.incomplete`（+ 等价 done）  
   → `finish_reason` 收尾 chunk（`choices` 含 finish_reason）  
   → 若 `includeUsage === true`：再发 **usage-only** chunk（形状见下）  
   → `data: [DONE]`
6. **失败** terminal：`event:error` / `response.failed` / data 内 failed → **§6.2 错误路径**（抛错 → `adaptStreamError` → chat error envelope）；**禁止** 成功 `[DONE]`

**Usage chunk 形状（钉死，OpenAI Chat 惯例）：**

```ts
{
  id, object: "chat.completion.chunk", created, model,
  system_fingerprint: null,
  choices: [],   // 空数组——不是 null、不是带 finish_reason 的 choice
  usage: {
    prompt_tokens, completion_tokens, total_tokens,
    prompt_tokens_details: null,
    completion_tokens_details: null,
  }
}
```

复用 `protocols/responses/stream-state.ts` 的 usage/model 抽取；**不** 复用 A↔O `stream-translation.ts`。

状态结构（示意）：

```ts
interface ChatViaResponsesStreamState {
  id: string
  model: string
  created: number
  roleSent: boolean
  /** Responses item id → chat tool_calls index（仅流式关联 delta） */
  toolCallIndexByItemId: Map<string, number>
  /** item id → call_id（写入 Chat tool_calls[].id） */
  callIdByItemId: Map<string, string>
  nextToolIndex: number
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null
  includeUsage: boolean  // from UpReq.includeUsage — 不是 payload 字段
  inputTokens: number
  outputTokens: number
  done: boolean
  failed: boolean
}
```

### 6.6 非目标字段（首版）

- reasoning / encrypted content → strip 或忽略（安全忽略）
- Responses 会话链（`previous_response_id` 往返）→ 不做
- parallel `n>1` → 明确 400（§6.3.1），不是静默降级

---

## 7. Strategy：`copilot-chat-via-responses`

```
packages/proxy/src/strategies/copilot-chat-via-responses.ts
```

### 7.1 Upstream request wrapper（P1 — `includeUsage` 不得进 JSON body）

`prepare` 的返回类型 **不是** 裸 `ResponsesPayload`。若把 `includeUsage` 挂在 payload 上，`JSON.stringify` 会发给 Copilot，导致未知字段风险。

**选定方案：显式 wrapper（优先于 WeakMap，可读、可测）：**

```ts
interface ChatViaResponsesUpReq {
  /** 原 Chat 请求；dispatch 内做 n/stop 校验；describeEndLog 可回读 model */
  originalChat: ChatCompletionsPayload
  /** 仅本地；initStreamState / adaptChunk 读取 */
  includeUsage: boolean
  /** 唯一允许 send 的 body */
  responsesPayload: ResponsesPayload
}
```

| 方法 | 读 | 写/发 |
|---|---|---|
| `prepare` | chat | 组装 wrapper；`responsesPayload` **不含** `includeUsage` / `stream_options` |
| `dispatch` | wrapper | `assert*(originalChat)` 后 `client.send(responsesPayload)` **仅** payload |
| `initStreamState` | wrapper | `includeUsage` → stream state |
| `adaptJson` | body + wrapper | 映射时可用 `originalChat.model` 作 fallback |
| `describeEndLog` | wrapper | `routingPath` + model |

备选 WeakMap 仅当 wrapper 与既有 `Strategy` 泛型冲突时再考虑；**默认不用**。

### 7.2 方法表

| 方法 | 行为 |
|---|---|
| `name` | `"copilot-chat-via-responses"` |
| `prepare` | **不抛 400**；返回 `ChatViaResponsesUpReq`（§7.1）；`includeUsage` 从 `stream_options` 提取后 **剥离**，不进入 `responsesPayload` |
| `dispatch` | §6.3.1a 本地校验 → `deps.client.send(up.responsesPayload)` |
| `adaptJson` | 若 failed/error → **throw**（§6.2）；否则 `responsesJsonToChatCompletion(...)` |
| `initStreamState` | 初始化 §6.5 状态；`includeUsage: up.includeUsage` |
| `adaptChunk` | 失败事件 → **throw**；成功 → `stream.adapt` → `SSEMessage[]`（可一次多 chunk；usage chunk 见 §6.5） |
| `adaptStreamError` | OpenAI chat error envelope（`{ error: { message, type } }` data chunk）；**不** 发成功 DONE |
| `describeEndLog` | success：model/tokens/`routingPath`；error：error 臂 + 同 routingPath |

Deps：

```ts
interface CopilotChatViaResponsesDeps {
  client: CopilotResponsesClient
  toolCallDebug: boolean
}
```

**不** 复用 `copilot-responses` 的 Codex namespace flatten（那是 Responses **入向** 客户端语义；本 shim tools 来自 Chat function schema）。

---

## 8. 涉及文件清单

### 8.1 新建

| 路径 | 职责 |
|---|---|
| `src/protocols/chat-responses/*.ts` | pure 映射 + endpoints |
| `src/strategies/copilot-chat-via-responses.ts` | 第 7 策略 |
| `test/protocols/chat-responses/*.test.ts` | 映射单测 |
| `test/strategies/copilot-chat-via-responses.test.ts` | 策略单测 |
| `test/characterisation/chat-via-responses-stream.test.ts` | SSE 快照 |
| `docs/24-chat-responses-shim.md` | 本文 |

### 8.2 修改

| 路径 | 变更 |
|---|---|
| `src/core/router.ts` | `CatalogModel`、openai 分支、`StrategyName` |
| `src/core/strategy.ts` | `STRATEGY_NAMES` +1 |
| `src/composition/strategy-registry.ts` | case 注册 |
| `src/composition/index.ts` | models 保留 endpoints；注释 six→seven |
| `src/routes/chat-completions/handler.ts` | 向 pick/dispatch 传 catalog；shim 路径日志 |
| `src/strategies/support/model-capabilities.ts` | 可选薄封装 `isResponsesOnlyModel(id)`（读 state；router 仍用 pure） |
| `test/core/router.test.ts` + `router.fixtures.json` | 新 fixtures |
| `test/core/strategy.test.ts` | length 7 |
| `test/composition/strategy-registry.test.ts` | 新 case |
| `docs/README.md`、根 `README.md` 文档表 | 索引 |
| `docs/16-openai-responses-api.md` | Non-Goals 收窄一句：入向 passthrough 不变；Chat 入向 shim 见 24 |

### 8.3 不改

- `upstream/copilot-openai.ts` / `copilot-responses.ts` URL 与 auth
- custom provider 路径
- `/v1/models` 字段形状（已 passthrough `supported_endpoints`）
- `cacheModels` / TTL **默认不改**（§4.2.3）；仅测试锁定 live 读语义

---

## 9. 测试策略（四层）

### 9.1 L1 — Unit / Characterisation（必交付）

| 套件 | 覆盖 |
|---|---|
| `endpoints.test.ts` | 空/仅 chat/仅 resp/两栖/ws/别名 `/v1/*` |
| `request.test.ts` | messages/tools/**strict 默认 false**/tool_choice/max_tokens；**call_id 往返**；`n≠1`/`stop` → 拒绝 |
| `response.test.ts` | 完整 shape（created/system_fingerprint/logprobs/content null）；finish_reason 优先级；**failed → throw** |
| `stream.test.ts` | text-only；tool_call（**id=call_id**）；incomplete 成功 DONE；**failed/error 不发成功 DONE** |
| `router.fixtures.json` | 每个 endpoint 分组至少 1 fixture；custom 不变 |
| `router-live-catalog` | §4.2.4 热更新序列 |
| `copilot-chat-via-responses.test.ts` | prepare/dispatch URL/adaptJson throw on failed/adaptChunk error path |
| `characterisation/chat-via-responses-stream` | 成功流 + **failed 流** 快照 |
| 回归 | 现有 chat-completions / responses characterisation **0 diff** |

### 9.2 L2 — API E2E（手动，anti-ban）

每条请求遵守 anti-ban（fail-fast、不进 CI）。**必做**清单：

| # | 场景 | 断言 | 请求数 |
|---|---|---|---|
| 1 | `grok-4.5` non-stream 纯文本 | 200，`choices[0].message.content` 非空，完整 chat shape | 1 |
| 2 | `grok-4.5` stream 纯文本 | 200，chunks + 成功 `[DONE]`，`routingPath=chat-via-responses` | 1 |
| 3 | **responses-only 完整两轮 tool call（必做，非可选）** | Round1：assistant `tool_calls[].id` 存在；Round2：`role:tool` + 同一 id → 最终 content 200。验证 **call_id 往返** | 2（同 test 内串行，仍 fail-fast） |
| 4 | empty-endpoints 模型（如 `gpt-4o`）smoke | 仍走 chat 直通（L1 已钉死 routing；L2 仅确认不 5xx） | 1 |

可选加测：`gpt-5.3-codex` 文本 1 次。  
**不** 进 CI / pre-commit。

### 9.3 L3 — UI E2E

不适用（无 Dashboard 变更）。

### 9.4 G1 / G2

- `biome` + `tsc --noEmit` 每 commit 绿
- `gate:arch`：新 protocols 文件遵守 pure 边界
- 安全：无新密钥面

### 9.5 6DQ 映射

| 维 | 本功能落地 |
|---|---|
| L1 单测 | §9.1 全套；覆盖率不低于 proxy 阈值 |
| L2 API E2E | §9.2 手测清单 |
| L3 UI | N/A |
| G1 静态 | lint + typecheck + depcruise |
| G2 安全 | 无新增；pre-commit gitleaks 照旧 |
| D1 隔离 | L1 mock upstream；L2 用临时 API key，测完 revoke |

---

## 10. 原子化提交计划

约定（对齐 docs/20 §5.0）：

- 每个 commit **独立可绿**：`bun run test`（proxy L1）+ typecheck + lint（pre-commit 范围）
- **测试与实现同 commit**（禁止「先码后测」拆 commit）
- 前缀：`feat(proxy):` / `test(proxy):` / `docs:` / `refactor(proxy):`
- 可按 Phase 打多 PR；commit 编号稳定，弃号不重排

---

### Phase A — 文档与判定纯函数（零行为变化）

#### A.1 docs: add chat↔responses shim design (this doc)

- 文件：`docs/24-chat-responses-shim.md`、`docs/README.md`、根 `README.md` 索引
- 验收：链接可点；无代码行为 diff

#### A.2 feat(proxy): add responses-only endpoint classifiers

- 新建 `protocols/chat-responses/endpoints.ts`
- 单测：空/chat/responses/两栖/ws/`/v1` 别名
- **不** 改 router
- 验收：`pickStrategy` 行为与 main 完全一致

```
feat(proxy): add responses-only endpoint classifiers
```

---

### Phase B — 请求/响应 pure 翻译（仍无接线）

#### B.1 feat(proxy): translate chat request body to responses

- `request.ts` + `types.ts` + 金样单测
- 覆盖：system/user/assistant/tool 消息；**call_id 双向**；tools + **`strict ?? false`**；tool_choice；max_tokens→max_output_tokens；`response_format`/`reasoning_effort`；**`n≠1`/`stop` 拒绝**

```
feat(proxy): translate chat request body to responses
```

#### B.2 feat(proxy): translate responses json to chat completion

- `response.ts` + `finish-reason.ts` + `errors.ts` + 金样
- 覆盖：§6.4 完整 shape；finish_reason 优先级；tool `id=call_id`；**`status:failed` → throw**（不得 200）

```
feat(proxy): translate responses json to chat completion
```

#### B.3 feat(proxy): add responses-to-chat stream state machine

- `stream.ts` + 单测（text-only + tool_call call_id + completed/incomplete 成功 DONE + **failed/error 走抛错路径**）
- 尚不挂 strategy

```
feat(proxy): add responses-to-chat stream state machine
```

---

### Phase C — Strategy + Registry（仍可暗开关：仅 registry 能 build，router 未选）

#### C.1 feat(proxy): add copilot-chat-via-responses strategy

- `strategies/copilot-chat-via-responses.ts`
- 单测：mock `CopilotResponsesClient`；non-stream + stream
- `STRATEGY_NAMES` + registry case + strategy.test length 7
- **router 仍不选择该 name**（死代码至 C.2，或 C.1+C.2 合并——推荐 **拆开** 以便 review）

```
feat(proxy): add copilot-chat-via-responses strategy
```

#### C.2 feat(proxy): route responses-only models via chat shim

- **行为变更 commit**
- `core/router.ts`：openai 分支 + `modelsCatalog`
- `composition/index.ts`：保留 endpoints
- `routes/chat-completions/handler.ts`：传 catalog；debug 日志 `routingPath`
- `router.fixtures.json` + live-catalog 热更新测试
- `model-capabilities.ts` 可选薄封装
- characterisation：handler 级 non-stream mock（upstream URL ends with `/responses`）

```
feat(proxy): route responses-only models via chat shim
```

**C.2 验收矩阵（L1）**

| model fixture endpoints | expected strategy | upstream path |
|---|---|---|
| `['/responses']` | chat-via-responses | `/responses` |
| `['/responses','ws:/responses']` | chat-via-responses | `/responses` |
| `['/chat/completions']` | openai-direct | `/chat/completions` |
| `['/responses','/chat/completions']` | openai-direct | `/chat/completions` |
| `[]` / missing | openai-direct | `/chat/completions` |
| custom provider | custom-openai | provider URL |

#### C.3 test(proxy): characterisation snapshots for chat-via-responses stream

- `test/characterisation/chat-via-responses-stream.test.ts` + `__snapshots__`
- 对标现有 chat-completions-stream-default

```
test(proxy): add chat-via-responses stream characterisation
```

---

### Phase D — 文档收尾与兼容说明

#### D.1 docs: narrow responses passthrough non-goals; link shim

- 更新 `docs/16-openai-responses-api.md` Non-Goals：明确「`/v1/responses` **入向** 不做 Chat 翻译；Chat 入向见 24」
- `docs/20` strategy 表增加第 7 行（若该表仍被当作权威）

```
docs: link chat-via-responses shim from responses and architecture docs
```

#### D.2 test(proxy): L2 e2e smoke checklist script/comments（可选）

- 在 `test/e2e/` 增加 **skip 默认** 的手测用例或 README 段落列出 §9.2 四步
- 不进 CI

```
test(proxy): document chat-via-responses L2 smoke cases
```

---

### Phase E — 反向 shim（可选，另 PR，非 P0）

| Commit | 内容 |
|---|---|
| E.1 | pure: responses request → chat request；chat response/stream → responses events |
| E.2 | strategy `copilot-responses-via-chat` |
| E.3 | router: `protocol:"responses"` + chat-only endpoints → 新策略 |

Manifest 当前不需要；仅当要让两个入向端点都 model-agnostic 时做。

---

### Commit 依赖图

```
A.1 ──► A.2 ──► B.1 ──► B.2 ──► B.3 ──► C.1 ──► C.2 ──► C.3 ──► D.1 ──► D.2
                                      │
                                      └── STRATEGY_NAMES=7 后 C.2 才能被选中
```

最小可合并主线：**A.1 → … → C.2**（非流式已可用）；**C.3 强烈建议同 PR**（Manifest 真实路径几乎全是 stream）。

---

## 11. 可观测性与日志

| 事件 | 字段 |
|---|---|
| `request_start` | 保持 `path=/v1/chat/completions`, `format=openai` |
| debug（可选） | `routingPath: "chat-via-responses"`, `upstreamPath: "/responses"` |
| `request_end` | `routingPath: "chat-via-responses"`；tokens 从 Responses usage 映射后写入现有 input/output 字段 |
| 终端格式 | 无需新 UI；routingPath 进 data 即可被 log stream 过滤 |

---

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Copilot endpoint 字符串漂移 | 双别名归一化；真实 `/v1/models` 样例进 fixture |
| catalog 1h 过期窗口 | H-5；不 retry；可后续配置 TTL |
| stream 事件顺序因模型而异 | 状态机容忍乱序；金样覆盖 |
| `max_tokens` vs `max_completion_tokens` | handler 已有 normalize，再映 `max_output_tokens` |
| STRATEGY_NAMES / registry 漏改 | C.1 单测 length=7 锁死 |
| 与 doc 16 文案冲突 | D.1 收窄 Non-Goals |
| 翻译丢字段导致工具调用失败 | B/C 金样强制 tools 往返；**L2 §9.2 #3 必做两轮 tool call** |
| `prepare` 抛错丢 `request_end` | 校验放 `dispatch`（§6.3.1a）；L1 断言 error 臂 end log |
| `includeUsage` 泄漏进上游 body | wrapper 类型（§7.1）；单测 `JSON.stringify(responsesPayload)` 无该键 |

---

## 13. Rollback

1. **软回滚**：revert C.2 → router 不再选 shim，策略代码可暂留
2. **硬回滚**：revert C.1+C.2（及 B/\* 若需）
3. 运行时无 feature flag 需求（catalog 判定即开关）；若需紧急关闭可后续加 env `RAVEN_CHAT_VIA_RESPONSES=0`（**非本设计必做**）

---

## 14. 实施顺序（执行时）

1. Review 本文签核（本阶段）
2. A.2 → B.* → C.1 → C.2 → C.3（TDD：先红测再实现，同 commit 内完成）
3. 本地 L1 全绿
4. **L2 手测必做**（§9.2）：纯文本 non-stream + stream + **两轮 tool call** + empty-endpoints smoke（anti-ban）
5. D.1 文档交叉链接
6. （可选）Phase E 另开

**禁止** 在 Review 完成前改生产路由行为。

---

## 15. FAQ（评审记录）

### Q1：如何判断哪些 model 走 shim？

只看 live catalog 的 `supported_endpoints` 是否 **responses-only**（§4.1）。不看 model 名。热更新靠现有 `cacheModels` 链路（§4.2），路由每次请求重算（H-1/H-2）。

### Q2：翻译性能？能否 model 名 native？

转换是 CPU 内存操作、无额外 hop；真·native 要求客户端说 Responses。按名 native 既不能统一 wire format，也会过期误伤。详见 §3.4。

### Q3：两栖模型为何不强制 shim？

两栖仍走 chat 直通（零翻译、现网行为）。仅当上游日后从两栖降级为 responses-only，下一次 catalog 刷新后自动切 shim（H-5）——这正是 catalog-driven 的价值。

### Q4：Codex review 修正摘要（2026-08-04，首轮）

| # | 严重度 | 问题 | 文档落点 |
|---|---|---|---|
| 1 | P0 | `response.failed` 不得当成功 DONE | §6.2、§6.5、§7 adaptJson/Chunk |
| 2 | P0 | Chat `tool_calls[].id` = Responses `call_id` | §6.3.2、§6.4、§6.5 |
| 3 | P1 | `strict: chat.strict ?? false` | §6.3.3 |
| 4 | P1 | 映射/本地/拒绝/忽略 四分类 | §6.3.1 |
| 5 | P1 | 完整 chat.completion 形状 + finish_reason 优先级 | §6.4 |
| 6 | P1 | L2 必做两轮 tool call | §9.2 #3 |

### Q5：Codex 复审修正摘要（2026-08-04，二轮）

| # | 严重度 | 问题 | 文档落点 |
|---|---|---|---|
| 1 | P0 | `prepare` 抛 400 无 `request_end` | §6.3.1a：校验移入 `dispatch` |
| 2 | P1 | `includeUsage` 保存机制 / 泄漏上游 | §7.1 wrapper；§6.5 usage chunk `choices:[]` |
| 3 | P1 | `developer` 不得降级 `system` | §6.3.2 分列保留 role |
| — | 文案 | §12/§14 与 §9.2 工具 L2 必做不一致 | 已对齐为必做 |

---

## 16. 参考

- Manifest（外部）：`buildCustomEndpoint` 仅 openai/anthropic path
- Raven：`core/router.ts`, `strategies/copilot-translated.ts`, `strategies/support/model-capabilities.ts`, `lib/utils.ts` `cacheModels`, `middleware.ts` `refreshModelsIfStale`, `core/runner.ts`（`prepare` 在 try 外；`dispatch`/`adaptJson`/`adaptChunk` 抛错 → `request_end`）, `docs/16`, `docs/18`, `docs/20`, `docs/23`
- OpenAI：migrate-to-responses（function `strict` 默认差异）、function-calling streaming（`call_id`）、Responses input roles（含 `developer`）
