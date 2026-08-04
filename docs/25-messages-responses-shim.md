# 25 — Anthropic Messages ↔ Responses Endpoint Auto-Shim

> 状态：**Design — pending review**（未实现）
> 范围：`packages/proxy` 路由决策 + 协议翻译 + 第 8 策略；不改 Manifest / Dashboard
> 关键属性：**catalog-driven 热更新** + **client Anthropic shape 不变** + **upstream `/responses` 一跳** + **failed 不得误报成功** + **tool call_id ↔ tool_use.id 往返**
> 关联：
> - `docs/24-chat-responses-shim.md`（**姊妹功能**：Chat 入向 → Responses；本篇为 Messages 入向 → Responses）
> - `docs/16-openai-responses-api.md`（`/v1/responses` 入向透传，本设计不推翻）
> - `docs/18-native-anthropic-messages.md`（native Claude 门闩；本 shim **不** 抢 claude-* native 路径）
> - `docs/20-architecture-refactor.md`（七层 + Strategy）
> - `docs/15-message-sanitization-pipeline.md`（Anthropic block 清洗先例，请求侧可参考）

---

## 0. 与 docs/24 的关系（评审先读）

### 0.1 一句话对照

| | docs/24（已实现） | docs/25（本文） |
|---|---|---|
| 客户端 path | `POST /v1/chat/completions` | `POST /v1/messages` |
| 客户端 shape | OpenAI Chat Completions | Anthropic Messages |
| 触发条件 | `isResponsesOnly(supported_endpoints)` | **相同** |
| 上游 | Copilot `POST /responses` | **相同** |
| 回包 shape | Chat Completions JSON/SSE | Anthropic `message` JSON / SSE lifecycle |
| 策略名 | `copilot-chat-via-responses` | `copilot-messages-via-responses` |
| `routingPath` | `chat-via-responses` | `messages-via-responses` |

### 0.2 同一类问题的两条边

```
                    ┌──────────────────────────┐
                    │ Upstream: /responses only │
                    │ (grok-4.5, gpt-5.5, …)    │
                    └────────────▲─────────────┘
                                 │
           ┌─────────────────────┴─────────────────────┐
           │                                           │
   docs/24 chat-via-responses              docs/25 messages-via-responses
           │                                           │
   /v1/chat/completions                        /v1/messages
   OpenAI clients                              Anthropic clients (Claude Code 等)
```

**不是** docs/24 Phase E「反向 shim」（Responses 入向 → 上游 chat）。  
Phase E 仍可选、另 PR。本文是 **对称的第二入向**，与 24 并列。

### 0.3 为何 24 不能「顺便」覆盖

今日 `protocol === "anthropic"` 对非 claude RO 模型落到 `copilot-translated`：

```
Anthropic → translateToOpenAI → CopilotOpenAIClient → /chat/completions
→ 400 model "…" is not accessible via the /chat/completions endpoint
```

Live 已验证（jp1/us2，`grok-4.5` on `/v1/messages`）。  
Chat shim 只挂在 `protocol === "openai"`，**不会** 被 `/v1/messages` 命中。

---

## 1. 背景与问题

### 1.1 症状

Claude Code / 其它 Anthropic 客户端只打 `/v1/messages`。Catalog 中 responses-only 模型（`grok-4.5`、`gpt-5.5`、`gpt-5.4-mini`、`gpt-5.6-*`、`gpt-5.3-codex`、`mai-code-1-flash-picker` 等）在 Messages 入向不可用。

### 1.2 与 24 共用的 endpoint 分布

判定信号与 24 **完全相同**（§4 复用 `isResponsesOnly`，不复制第二套启发式）：

| 分组 | 本 shim |
|---|---|
| 仅 `/responses`（± `ws:/responses`） | ✅ 触发 |
| 两栖（responses **且** chat） | ❌ 仍走 translated / 既有路径 |
| 仅 chat / empty / claude native | ❌ 不触发 |

### 1.3 现状架构缺口

| 事实 | 代码位置 |
|---|---|
| anthropic：custom → native(`claude-*`) → **恒** translated | `core/router.ts` L121–138 |
| translated 上游固定 Chat Completions | `strategies/copilot-translated.ts` + `CopilotOpenAIClient` |
| messages handler **未** 传 `modelsCatalog`（仅 ids） | `routes/messages/handler.ts` `pickStrategy({… modelsCatalogIds })` |
| Chat↔Responses 翻译已存在 | `protocols/chat-responses/*` |
| Anthropic↔Responses 翻译 **不存在** | — |
| Anthropic↔Chat 翻译已存在 | `protocols/translate/*`（translated 路径） |

---

## 2. 目标与非目标

### 2.1 Goals

1. **对调用方透明**：`POST /v1/messages` + responses-only model → 200，合法 Anthropic Messages JSON/SSE（`type:"message"` / `message_start`…`message_stop`）。
2. **Catalog-driven 热更新**：与 24 相同 — 只读 live `supported_endpoints`，无 boot 固化表，无需重启。
3. **零额外上游 hop**：Raven → Copilot `/responses` 一跳（禁止 chat 失败再 retry responses）。
4. **架构对齐 docs/20 + 24**：pure `protocols/` + 新 Strategy + `pickStrategy` 分支；不污染 native / translated / chat-via-responses。
5. **可观测**：`request_end.data.routingPath = "messages-via-responses"`。
6. **回归安全**：claude native、两栖 translated、custom anthropic/openai、empty-ep 行为与现网一致。
7. **与 24 共享失败语义与 call_id 纪律**（见 §6.2、§6.3）。

### 2.2 Non-Goals

- 改 Manifest / 客户端 / Dashboard UI
- Custom provider 的 Responses 支持
- 反向 shim（`/v1/responses` → 上游 messages 或 chat）— 仍属 24 Phase E / 另文
- `previous_response_id` 会话状态机
- 完整 vision / thinking signature / encrypted content 保真（首版 best-effort 或 strip，单测钉死策略）
- 修改上游 `supported_endpoints` 源数据
- 把 RO 模型强行改道 native Anthropic upstream（上游无 `/v1/messages`）
- Server-tool（Tavily `web_search`）在本 shim 上的完整拦截 — **P0 默认关闭 decorate**；若后续需要与 translated 对齐，另开小节/commit（§7.4）
- 重写 `copilot-translated` 或合并两个 shim 为一个「万能」策略

### 2.3 成功标准

- [ ] Claude Code / 等价 client：`api_kind:anthropic` + `grok-4.5`（及其它 RO）non-stream / stream → 200，合法 Anthropic shape
- [ ] 两轮 tool：`tool_use.id` 与下一轮 `tool_result.tool_use_id` 经 Responses `call_id` 往返成功
- [ ] `claude-haiku-4.5` 等仍走 `copilot-native`；`gpt-5-mini`（两栖）仍走 `copilot-translated`；L1 无 diff
- [ ] catalog 热更新后 RO 判定立即生效（同 24 H-1…H-6）
- [ ] L1 全绿；`gate:arch` / typecheck / lint 绿
- [ ] `status=failed` / stream error **不得** 返回成功 `message` / 完整成功 SSE 收尾

---

## 3. 方案总览

### 3.1 一句话

新增第 8 策略 **`copilot-messages-via-responses`**：入向 Anthropic Messages，出向 `CopilotResponsesClient`（`/responses`），响应/SSE 译回 Anthropic；由 `pickStrategy(protocol:"anthropic")` 在 native 之后、translated 之前，基于 live `isResponsesOnly` 选择。

### 3.2 请求路径

```
Client  POST /v1/messages   (AnthropicMessagesPayload)
   │
   │  apiKeyAuth → refreshModelsIfStale()
   ▼
handleMessages
   │  preprocess / sanitize（既有 pipeline，能复用则复用）
   │  composition.dispatch(protocol="anthropic", models=state.models.data)  ← 必须带 full catalog
   ▼
pickStrategy(anthropic, model, modelsCatalog[])
   ├─ custom provider match     → custom-anthropic | custom-openai
   ├─ nativeSupported(claude-*) → copilot-native
   ├─ isResponsesOnly(endpoints)→ copilot-messages-via-responses   ← NEW
   └─ else                      → copilot-translated
   ▼
Strategy (7-method)
   prepare  → MessagesViaResponsesUpReq { originalAnthropic, responsesPayload }
   dispatch → assert local rejects → CopilotResponsesClient.send(responsesPayload)
   adaptJson / adaptChunk → Anthropic shape（failed → throw）
   ▼
Client  type:message | SSE message_start … message_stop
```

**Client 契约不变**：`ctx.path = "/v1/messages"`，`format = "anthropic"`。

### 3.3 为何不是其他方案

| 方案 | 否决理由 |
|---|---|
| 扩展 `copilot-translated` 内「先 chat 再 fallback responses」 | 双 hop、anti-ban、失败语义混乱；与 24 明确禁止的 retry 同构 |
| RO 模型走 `copilot-native` | 上游 native 是 Anthropic `/v1/messages`，RO 模型不在该 API |
| 级联 **响应**：Responses → Chat → `translateToAnthropic` | stream 要伪造 Chat chunk；finish/stop 映射叠误差；call_id 易丢；**禁止作为主路径**（§6.0） |
| 只在 handler 改道、不改 `pickStrategy` | composition 二次 pick 会冲掉（24 §5.3 已钉死；messages 同样双调用） |
| 与 chat-via-responses 合成单一策略 | 入向类型与 SSE 状态机不同，强行合并只会变成巨型 switch；共享应在 **Responses IR 层** |

### 3.4 性能

与 24 相同量级：纯 CPU 翻译 + 一跳上游。Anthropic SSE 事件数通常多于 Chat delta，但相对上游 RTT 可忽略。禁止为 shim 加 model 名 hardcode 的「假 native」。

---

## 4. Model 判定与热更新

### 4.1 唯一判定信号

**完全复用** `protocols/chat-responses/endpoints.ts`：

```ts
isResponsesOnly(entry?.supported_endpoints)
```

- 禁止第二套 `model.startsWith("grok")` 等启发式
- 禁止 boot 时固化 `Set<modelId>`
- `ws:/responses` 单独不计入 HTTP responses（既有实现）

### 4.2 热更新不变量

**继承 24 的 H-1…H-6**，不另起一套。补充：

| ID | 不变量 |
|---|---|
| H-7 | messages 路径的 handler **与** composition 必须传入完整 `modelsCatalog: {id, supported_endpoints?}[]`，禁止只 `.map(id)` 导致 anthropic 分支永远看不到 endpoints |
| H-8 | `modelsCatalog` 缺省时 anthropic 行为与 **今日完全一致**（永远不会选 messages-via-responses）— legacy-safe |

### 4.3 热更新验收（anthropic）

```
t0: catalog 无 grok-4.5           → pick(anthropic) → copilot-translated
t1: 注入 grok-4.5 + ['/responses'] → pick → copilot-messages-via-responses
t2: 改为两栖                      → pick → copilot-translated
t3: claude-haiku-4.5 + messages   → 始终 copilot-native（不受 RO 表干扰）
```

---

## 5. 路由决策细节

### 5.1 `protocol === "anthropic"` 伪代码（目标态）

```ts
if (protocol === "anthropic") {
  const normalisedModel = translateModelName(model, anthropicBeta ?? null)
  const catalogModel = resolveAgainstCatalog(normalisedModel, modelsCatalogIds)
  const candidates =
    normalisedModel !== model ? [model, normalisedModel] : [model]
  const matched = matchProvider(candidates, providers)
  if (matched) {
    return {
      kind: "ok",
      name: matched.provider.format === "anthropic"
        ? "custom-anthropic"
        : "custom-openai",
      providerId: matched.provider.id,
    }
  }
  if (nativeSupported(catalogModel, modelsCatalogIds)) {
    return { kind: "ok", name: "copilot-native" }
  }
  // NEW — after native, before translated
  const entry =
    modelsCatalog?.find((m) => m.id === catalogModel) ??
    modelsCatalog?.find((m) => m.id === model)
  if (isResponsesOnly(entry?.supported_endpoints)) {
    return { kind: "ok", name: "copilot-messages-via-responses" }
  }
  return { kind: "ok", name: "copilot-translated" }
}
```

**优先级（不可调换）：**

1. custom provider  
2. copilot-native（claude + catalog）  
3. **messages-via-responses（RO）**  
4. copilot-translated  

### 5.2 决策必须在 `pickStrategy`

与 24 §5.3 相同：messages handler 与 `composition.dispatch` **都** 调 `pickStrategy`。只改 handler 无效。

### 5.3 handler 接线缺口（实施必改）

今日：

```ts
// routes/messages/handler.ts — 缺 modelsCatalog
pickStrategy({
  protocol: "anthropic",
  model,
  anthropicBeta,
  providers: state.providers,
  modelsCatalogIds: state.models?.data?.map((m) => m.id) ?? [],
})
```

目标：与 chat-completions / composition 对齐，传入：

```ts
modelsCatalog: state.models?.data?.map((m) => ({
  id: m.id,
  supported_endpoints: m.supported_endpoints,
})) ?? [],
```

composition 侧确认 `DispatchInput.models` 已含 endpoints（24 已要求）；messages 走 composition 时不得再次丢掉字段。

### 5.4 新 `StrategyName`

```ts
| "copilot-messages-via-responses"
```

同步：`core/strategy.ts` `STRATEGY_NAMES`（7→8）、`composition/strategy-registry.ts`、相关 length 断言测试。

---

## 6. 协议映射

### 6.0 复用边界（评审焦点）

#### 6.0.1 直接复用（禁止复制粘贴第二份）

| 模块 | 用途 |
|---|---|
| `isResponsesOnly` / endpoint 分类 | 路由 |
| `CopilotResponsesClient` | 上游 |
| `isResponsesFailure` / `responsesFailureMessage` | 非流式失败 |
| `ResponsesProtocolError` / `ResponsesStreamFailedError` | 抛错类型（可上提至共享，见下） |
| `ClientInputError` + `extractErrorDetails` 行为 | 本地 400 |
| `extractUsage` / `extractResolvedModel` / `extractNonStreamingMeta` | usage / model |
| Strategy 7-method + registry 模式 | 接线 |
| `emitUpstreamRawSse` | debug |

#### 6.0.2 建议抽取的共享 IR（可选但推荐，可与实现同 PR 或紧随）

Chat shim 已解析的 Responses 结构与入向协议无关，建议中性化，避免 messages 模块 import「Chat 专用」出口：

```
protocols/responses/   # 已有 stream-state 等；扩展而非新建平行宇宙
  ir.ts                # 可选：normalizeOutput(output[]) → { texts, functionCalls, refusal }
  failure.ts           # 可选：从 chat-responses/errors 上提
```

| 层 | Chat shim | Messages shim |
|---|---|---|
| Responses JSON/SSE → **IR** | 共享 | 共享 |
| IR → client shape | `→ Chat`（已有） | `→ Anthropic`（新建） |
| Client → Responses request | `chatRequestToResponses`（已有） | `anthropicRequestToResponses`（新建） |

**允许**：实现期先在 `messages-responses/` 内 private 复制最小 parse helper，但 L1 必须与 chat 侧 call_id / failed 语义一致；随后 commit 再 hoist（写入 retrospective 若忘记）。

#### 6.0.3 禁止的级联

| 级联 | 请求侧 | 响应/Stream 侧 |
|---|---|---|
| `Anthropic → translateToOpenAI → chatRequestToResponses` | **允许作 spike / 对照实现**，正式路径 **不默认采用**（见 §6.3.0） | — |
| `Responses → responsesJsonToChatCompletion → translateToAnthropic` | — | **禁止** |
| `Responses stream → Chat chunks → translateChunkToAnthropicEvents` | — | **禁止** |

理由：Chat 是另一套 client 契约；stop_reason、content block 生命周期、tool_use 结构都会在双跳中失真。

### 6.1 模块布局（pure zone）

```
packages/proxy/src/protocols/messages-responses/
  request.ts         # anthropicRequestToResponses + assertMessagesViaResponsesSupported
  response.ts        # responsesJsonToAnthropicMessage
  stream.ts          # state machine: Responses SSE → Anthropic SSE events
  stop-reason.ts     # Responses status → Anthropic stop_reason（不含 failed→success）
  types.ts
  index.ts
```

**dep-cruiser**：`protocols/**` 不得 import `state` / `log-emitter` / 业务 hono handler（既有规则）。

错误类：继续用 `lib/error.ts` 的 `ClientInputError`；协议失败复用或上提 `ResponsesProtocolError` / `ResponsesStreamFailedError`（若上提，chat-responses 改为 re-export，避免双定义）。

### 6.2 失败语义（P0 — 与 24 对齐）

| 路径 | 条件 | 必须行为 |
|---|---|---|
| 非流式 `adaptJson` | `isResponsesFailure(body)` | **抛出**；不得返回 `type:"message"` 200 |
| 流式 `adaptChunk` | `response.failed` / `error` | **抛出** → `adaptStreamError`；不得发成功 `message_stop` 冒充完成 |
| 流式成功 terminal | `response.completed` / `response.incomplete` | 才允许 `message_delta`（stop_reason）+ `message_stop` |
| `request_end` | 失败路径 | status=error；可保留 `routingPath` |

成功 JSON 常带 `"error": null` — **禁止**「存在 error 键即失败」（24 已钉死，本篇继承）。

`adaptStreamError` 产出 **Anthropic** 错误事件（可复用 `translateErrorToAnthropicErrorEvent` 或等价 shape），不是 Chat error chunk。

### 6.3 请求 Anthropic → Responses

#### 6.3.0 实现策略选择（写入评审结论）

| 方案 | 说明 | 本文默认 |
|---|---|---|
| **B 直译** | `anthropicRequestToResponses(payload)` 直接生成 `ResponsesPayload` | ✅ **正式路径** |
| **A 级联** | `translateToOpenAI` → `chatRequestToResponses` | ❌ 不作正式路径；仅允许 spike 对比保真度 |

A 的问题：`translateToOpenAI` 为 **Chat 上游** 调参（reasoning、strip、copilot 特化），再进 Responses 可能双重变形。B 可复用 24 的 tools/strict/max_output_tokens 规则，仅 messages/system/blocks 映射新写。

#### 6.3.1 字段分类

| 分类 | Anthropic 字段 | 行为 |
|---|---|---|
| **映射** | `model` | → `model` |
| **映射** | `system` | → input 前部 `role:"system"` item(s)，或 Responses `instructions`（**二选一，实现钉死一种**；推荐 system → input items，与 24 chat system 一致，避免双通道） |
| **映射** | `messages[]` | → `input`（§6.3.2） |
| **映射** | `max_tokens` | → `max_output_tokens` |
| **映射** | `stream` | → `stream` |
| **映射** | `tools[]` | → Responses function tools；`strict: input_schema` 侧默认 **false**（同 24：省略 strict 会改变上游语义） |
| **映射** | `tool_choice` | `auto/any/none/tool` → Responses `tool_choice` 等价（`any`→`required`，`tool`→`{type:"function",name}`） |
| **映射** | `temperature`, `top_p` | 同名透传（上游不支持则 400 透传，不在 shim 预判 model 名） |
| **映射** | `metadata.user_id` | → `user`（若非空） |
| **映射** | `output_config.effort` / thinking 相关 | → `reasoning.effort` **best-effort**；无法映射则 **安全忽略** 并 debug `droppedFields`（P1 单测锁定忽略而非 500） |
| **明确拒绝 400** | 首版无法安全映射且会静默错行为的字段（若有） | `ClientInputError`；清单在实现前补全，默认宁忽略勿拒，除非破坏 call_id |
| **安全忽略** | `top_k`, `stop_sequences`, `service_tier`, 未知字段 | 丢弃 |
| **安全忽略** | server_tool 专用块（若客户端误传） | strip（与 sanitization 一致）；不在本 shim 执行 Tavily |

本地拒绝纪律与 24 §6.3.1a **完全相同**：

- `prepare`：纯转换，**禁止** throw 400  
- `dispatch`：`assert…` → `ClientInputError`  
- `request_end`：`statusCode=400` 且 `upstreamStatus=null`

#### 6.3.2 `messages` / blocks → `input` 与工具 ID（P0）

| Anthropic | Responses `input` |
|---|---|
| `system` string / text blocks | `{role:"system", content:…}` item(s) |
| `user` + text | `{role:"user", content:…}` |
| `user` + `image` | best-effort `input_image`；失败则 strip + debug |
| `user` + `tool_result` | `{type:"function_call_output", call_id: tool_use_id, output}` |
| `assistant` + text | `{role:"assistant", content:…}`（content parts 用 `input_text`，同 24 EasyInput 规则） |
| `assistant` + `tool_use` | `{type:"function_call", call_id: tool_use.id, name, arguments: JSON.stringify(input)}` |
| `assistant` + `thinking` | 首版 **strip**（或 map 到 reasoning 项若上游稳定；默认 strip） |

**工具 ID 不变量（P0，单测钉死）：**

| 方向 | 规则 |
|---|---|
| Anthropic → Responses | `function_call.call_id = tool_use.id` |
| Anthropic → Responses | `function_call_output.call_id = tool_result.tool_use_id` |
| Responses → Anthropic | `tool_use.id = function_call.call_id`（**不是** output item `id`） |
| 流式 | item id 仅用于关联 arguments delta；**不得** 写入 `tool_use.id` |
| 缺 `call_id` | 非流式 throw / 流式错误路径；禁止用 item id 冒充 |

与 24 的 Chat `tool_calls[].id` 纪律对称，仅 client 字段名不同。

#### 6.3.3 `tools[]` 与 `strict`

Anthropic：

```ts
{ name, description?, input_schema }
```

Responses：

```ts
{ type: "function", name, description?, parameters: input_schema, strict: false }
```

`strict` 默认 **false**（理由同 24 §6.3.3）。

### 6.4 响应 Responses → Anthropic（非流式）

#### 6.4.1 成功 `message` 形状（P1）

```ts
{
  id: string,                 // 策略：可用 msg_ 前缀派生自 response.id，或保留映射表；单测钉死稳定规则
  type: "message",
  role: "assistant",
  model: string,              // response.model ?? request.model
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: object }
  >,
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | null,
  stop_sequence: null,
  usage: {
    input_tokens: number,     // usage.input_tokens
    output_tokens: number,    // usage.output_tokens
  }
}
```

规则：

- 仅 text → 一个或多个 `text` blocks（合并为单一 text 可接受，单测钉死）
- 有 `function_call` → `tool_use` blocks；`id = call_id`；`input = JSON.parse(arguments)`（parse 失败则 raw 策略钉死：throw 或 `{}`+log，**禁止** 静默丢 tool）
- 纯 tool 无 text → `content` 可只有 `tool_use`（允许）
- `status === "failed"` → 不进本表（§6.2）

#### 6.4.2 `stop_reason` 优先级

高 → 低：

1. 存在任意 `function_call` → `"tool_use"`
2. `incomplete` + max tokens 类 reason → `"max_tokens"`
3. 否则 → `"end_turn"`

（`stop_sequence` 首版不映射，恒 null。）

### 6.5 流式状态机（P1）

Anthropic 客户端期望的生命周期（与 native/translated 一致）：

```
message_start
  content_block_start (text | tool_use)
    content_block_delta (text_delta | input_json_delta)
  content_block_stop
  …（多 block）
message_delta (stop_reason, usage)
message_stop
```

#### 6.5.1 Responses 事件 → Anthropic 事件（逻辑表）

| Responses | Anthropic |
|---|---|
| `response.created` | 可触发 `message_start`（若尚未发送）；带初步 `message` 骨架 |
| `response.output_text.delta` | 确保 text `content_block_start`；`text_delta` |
| `response.output_item.added` + `function_call` | `content_block_start` type=tool_use（id=call_id, name, input=`{}`） |
| `response.function_call_arguments.delta` | `input_json_delta` |
| `response.function_call_arguments.done` / item done | `content_block_stop` for tool |
| text 结束 / item done | text `content_block_stop` |
| `response.completed` / `incomplete` | 关闭未关 block → `message_delta` + `message_stop` |
| `response.failed` / `error` | throw → `adaptStreamError` |

状态字段（示意）：

```ts
interface MessagesViaResponsesStreamState {
  messageStartSent: boolean
  contentBlockIndex: number
  contentBlockOpen: boolean
  // tool: map itemId → { callId, anthropicBlockIndex, name }
  // text block index tracking
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  model: string
  messageId: string
  done: boolean
  failed: boolean
}
```

可参考 `copilot-translated` 的 `AnthropicStreamState` 与 chat-via-responses 的 tool index map，**但** 事件源是 Responses 不是 Chat chunk。

### 6.6 非目标字段（首版）

| 项 | 策略 |
|---|---|
| thinking / redacted_thinking 输出 | 不生成；上游 reasoning 不强制译回 thinking block |
| citations / MCP blocks | strip |
| `service_tier` | ignore |
| parallel tool 多 call | 支持（多 `tool_use` blocks），单测至少 1 tool；多 tool P1 |
| prompt caching 字段 | ignore |

---

## 7. Strategy：`copilot-messages-via-responses`

### 7.1 类型

```ts
// protocols/messages-responses/types.ts
export interface MessagesViaResponsesUpReq {
  originalAnthropic: AnthropicMessagesPayload  // 或 handler 规范化后的窄类型
  responsesPayload: ResponsesPayload
}

// Strategy generics 对齐 copilot-chat-via-responses / copilot-translated
```

### 7.2 方法表

| 方法 | 行为 |
|---|---|
| `name` | `"copilot-messages-via-responses"` |
| `prepare` | `responsesPayload = anthropicRequestToResponses(req)`；组装 UpReq；不 throw 校验 |
| `dispatch` | `assertMessagesViaResponsesSupported`；`client.send(responsesPayload)`；stream/json 分支同 chat shim |
| `adaptJson` | `responsesJsonToAnthropicMessage(body, originalModel)` |
| `initStreamState` | Anthropic-oriented state |
| `adaptChunk` | Responses SSE → Anthropic SSEMessage[]（`event` + `data`） |
| `adaptStreamError` | Anthropic error event(s) |
| `describeEndLog` | `routingPath: "messages-via-responses"`；usage 从 UpResp / state 取；**禁止** 把 Chat 形状误当成 resp |

### 7.3 与 messages handler 的预处理

handler 今日在进 translated/native 前有 sanitize / model 改写。本策略：

- **应** 吃与 translated 相同的「已 sanitize」payload（避免重复/遗漏 strip）
- **不应** 再跑 `translateToOpenAI`
- model 名：与 translated 一样保留 client 原始 model 用于回包；上游 `responsesPayload.model` 用 catalog 解析后的 id（若 handler 已 resolve，则一致传入）

### 7.4 Server-tool decorate（P0 默认关）

| 选项 | 行为 |
|---|---|
| **P0 默认** | 本策略 **不** 包 `decorate()` / Tavily；RO 模型 + web_search 首版不承诺 |
| 后续 | 若 product 需要，与 translated 对齐另开 commit，写清与 native pure/mixed 的差异 |

---

## 8. 涉及文件清单

### 8.1 新建

```
docs/25-messages-responses-shim.md          # 本文
packages/proxy/src/protocols/messages-responses/*
packages/proxy/src/strategies/copilot-messages-via-responses.ts
packages/proxy/test/protocols/messages-responses/*
packages/proxy/test/strategies/copilot-messages-via-responses.test.ts
packages/proxy/test/core/router*.ts         # anthropic RO cases（扩现有）
```

### 8.2 修改

```
packages/proxy/src/core/router.ts           # anthropic 分支 RO
packages/proxy/src/core/strategy.ts         # STRATEGY_NAMES +1
packages/proxy/src/composition/strategy-registry.ts
packages/proxy/src/composition/index.ts     # 注释/类型若需要
packages/proxy/src/routes/messages/handler.ts  # modelsCatalog + 策略 payload 接线
docs/README.md / README.md                  # 索引
docs/20-baseline.json                       # 若覆盖率基线需要
docs/24-chat-responses-shim.md              # 文首/关联加「姊妹 docs/25」（可选小改）
```

### 8.3 不改

- Manifest / Dashboard
- `copilot-native` / `copilot-responses` passthrough 语义
- `docs/16` 入向 responses 契约
- 上游 catalog 生成逻辑

### 8.4 可选 refactor（可同 PR 后半或紧随）

- 上提 Responses failure / output extract 到 `protocols/responses/`
- chat-responses 改为调用共享 extract（行为 0 diff 单测钉死）

---

## 9. 测试策略

### 9.1 L1（必交付）

| 文件焦点 | 用例 |
|---|---|
| `router` | RO → messages-via-responses；两栖 → translated；claude → native；custom 优先；catalog 热更新序列 |
| `request.test.ts` | system/messages/tools/tool_choice；tool_use→function_call call_id；tool_result→output；strict 默认 false |
| `response.test.ts` | text；tool_use id=call_id；stop_reason；failed throw；error:null 成功 |
| `stream.test.ts` | lifecycle 顺序；text delta；tool args delta；failed throw；禁止假成功 message_stop |
| `strategy.test.ts` | prepare/dispatch/adaptJson/adaptChunk 集成；routingPath |
| 回归 | translated / native / chat-via-responses 既有测试 0 fail |

### 9.2 L2 E2E（手动，anti-ban）

每 case 1 请求：

1. `grok-4.5` `/v1/messages` non-stream → pong  
2. stream → message_start…message_stop  
3. tools 两轮 call_id  
4. 负向：两栖 `gpt-5-mini` 仍 translated（可查 routingPath / 行为）  
5. `claude-haiku` 仍 native  

### 9.3 G1 / 覆盖率

- biome + tsc  
- `gate:coverage` / baseline 更新（新文件纳入）  
- `gate:arch` dep-cruiser  

### 9.4 6DQ（摘要）

| 维 | 要点 |
|---|---|
| 正确性 | call_id、failed、路由优先级 |
| 安全 | 不引入双 hop；本地 400 不记 upstream |
| 可维护 | 与 24 对称；共享 IR 避免分叉 |
| 可观测 | routingPath |
| 性能 | 一跳 |
| 兼容 | H-8 legacy-safe |

---

## 10. 原子化提交计划

### Phase A — 文档

```
docs: add messages-responses shim design (25)
```

### Phase B — 路由（仍可无策略实现：先 fail closed 或仅测 pick）

```
feat(proxy): route responses-only models on anthropic to messages shim name
test(proxy): anthropic pickStrategy responses-only cases
```

（若策略尚未注册，registry 必须同时加占位或本 phase 只加纯函数测试 + router 返回名，registry 下一 phase — **禁止** 运行时 unknown strategy。）

### Phase C — pure 翻译

```
feat(proxy): anthropic ↔ responses request/response mapping
feat(proxy): responses stream to anthropic SSE adapter
test(proxy): messages-responses protocol unit tests
```

### Phase D — Strategy + 接线

```
feat(proxy): add copilot-messages-via-responses strategy
feat(proxy): wire messages handler modelsCatalog + shim dispatch
test(proxy): strategy + handler characterisation
```

### Phase E — 可选共享抽取

```
refactor(proxy): hoist responses output/failure helpers for dual shims
```

### Phase F — 文档收尾

```
docs: mark 25 implemented + link from 24
```

**依赖**：A → C 可并行 B 的纯测；D 依赖 B+C；E 可选。

---

## 11. 可观测性与日志

| 字段 | 值 |
|---|---|
| `routingPath` | `"messages-via-responses"` |
| `format` | `"anthropic"` |
| `path` | `"/v1/messages"` |
| model / resolvedModel / tokens | 同其它策略 |
| debug | `droppedFields`（thinking 等）可选 |

---

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 与 translated 抢两栖模型 | 仅 `isResponsesOnly`；两栖单测 |
| 与 native 抢 claude | native 判断在前；claude+RO 异常 catalog 仍 native（若需 RO 优先另议，**默认 native 优先**） |
| call_id 错绑 | P0 单测 + 禁止 item id |
| failed 当成功 | 共享 isResponsesFailure；stream throw |
| messages 未传 catalog | H-7；handler diff 必审 |
| 级联诱惑 | §6.0.3 禁止响应级联 |
| temperature 等上游 400 | 透传；不在 shim 维护 model 黑名单（与 24 live 经验一致） |
| jp1 内存 | 纯逻辑无新服务；注意测试不增重 build |

---

## 13. Rollback

1. `pickStrategy` 去掉 RO 分支 → 全部回 translated（RO 再 400，与今日同）  
2. 或 registry 将名映射到 translated（不推荐，藏逻辑）  
3. 功能 flag：**默认不需要**；catalog-driven 已足够；若要 flag 另开非目标  

---

## 14. 实施顺序（执行时）

1. Review 本文（尤其 §5 优先级、§6.0 复用边界、§7.4 server-tool）  
2. Phase A 合入  
3. B+C 单测驱动  
4. D 接线  
5. 本地 + us2/jp1 live 矩阵补 `/v1/messages` RO cases  
6. E 可选 hoist  
7. F 状态改为 Implemented  

---

## 15. FAQ

### Q1：和 docs/24 会不会双维护两套 Responses 解析？

会，若只 copy。本文默认 **正式响应/stream 直译 Anthropic**，并建议 IR/failure **上提共享**（§6.0.2）。Chat 侧已实现的 parse 是共享来源，不是 Anthropic 去依赖 Chat 出口。

### Q2：为什么不用 translateToOpenAI 再 chatRequestToResponses？

请求侧 spike 可用；正式路径不采用（§6.3.0）。响应侧禁止（§6.0.3）。

### Q3：claude 模型若被标成 responses-only 怎么办？

默认 **native 优先**（§5.1）。若未来 catalog 出现「claude + 仅 responses」，应再开评审：native 会 404/400 时是否改 RO shim。首版不处理。

### Q4：`count_tokens` 要不要 shim？

**否。** `count_tokens` 不走上游 chat/responses 生成；保持现逻辑。RO 模型 count 若走 translateToOpenAI 计数，可接受 best-effort；非本功能 P0。

### Q5：docs/24 Phase E 是否包含本文？

**否。** Phase E 是 Responses **入向** 反向到 chat。本文是 Messages **入向** 正向到 responses。

---

## 16. 参考

- `docs/24-chat-responses-shim.md` — 姊妹实现与失败/call_id/ClientInputError 纪律  
- `docs/16-openai-responses-api.md` — Responses 入向  
- `docs/18-native-anthropic-messages.md` — native 门闩  
- `packages/proxy/src/protocols/chat-responses/*` — 可复用实现  
- `packages/proxy/src/protocols/translate/*` — Anthropic SSE / stop_reason 形状参考（**事件源不同**）  
- `packages/proxy/src/strategies/copilot-translated.ts` — Anthropic stream 出口参考  
- `packages/proxy/src/strategies/copilot-chat-via-responses.ts` — 7-method 模板  
- OpenAI Migrate to Responses / Function calling streaming（call_id）  
- Anthropic Messages SSE 事件文档  

---

## 17. 评审检查清单（给 Reviewer）

- [ ] 路由优先级：custom → native → **RO shim** → translated  
- [ ] messages handler 传 `modelsCatalog`（H-7）  
- [ ] 禁止响应侧 Chat 级联  
- [ ] call_id = tool_use.id 双向  
- [ ] failed / stream error 不得成功收尾  
- [ ] ClientInputError 仅在 dispatch  
- [ ] 与 24 共享 `isResponsesOnly`，无第二套启发式  
- [ ] server-tool P0 关闭可接受  
- [ ] 原子 commit 相位可执行  
- [ ] 非目标未膨胀进 P0  
