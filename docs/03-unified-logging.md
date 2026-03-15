# Unified Logging — 设计文档

## 概述

当前 Raven 的日志系统存在三个问题：

1. **结构化 logger 几乎未使用** — `logger.ts` 只在 `messages.ts` 有 4 处 `debug` 调用；`chat.ts` 零调用；生命周期事件（init、token refresh）全用 raw `console.*` 绕过 logger
2. **无实时日志推送** — 无 WebSocket、无 SSE push、无 EventSource；dashboard 数据仅在页面导航时刷新
3. **无专业日志页面** — `/requests` 是静态表格，无法实时 tail、无法按请求折叠查看 SSE chunk 流

**目标：**
- 中心化事件总线，所有日志事件统一流经一个 `LogEmitter`
- 三个消费端共享同一份流：terminal（stdout JSON lines）、WebSocket（实时推送）、dashboard（格式化 UI）
- Coding agent 在 terminal 看到结构化 debug 信息，运维在 dashboard 看到专业化格式化的日志页面

---

## 一、LogEvent 类型

所有日志事件共用一个结构：

```typescript
type LogLevel = "debug" | "info" | "warn" | "error";

type LogEventType =
  | "system"           // init、token refresh、config change
  | "request_start"    // 请求进入 proxy
  | "request_end"      // 请求完成（含 status、latency、token usage）
  | "sse_chunk"        // 上游 SSE chunk 透传/翻译后的事件
  | "upstream_error";  // 上游非 2xx 或网络错误

interface LogEvent {
  ts: number;            // Date.now(), unix ms
  level: LogLevel;
  type: LogEventType;
  requestId?: string;    // 关联同一个请求的所有事件
  msg: string;           // 人类可读摘要
  data?: Record<string, unknown>;  // 结构化附加数据
}
```

**新文件：`packages/proxy/src/util/log-event.ts`**

仅包含类型定义和 `LogEventType` 常量。

---

## 二、LogEmitter 事件总线

**新文件：`packages/proxy/src/util/log-emitter.ts`**

使用 Node.js `EventEmitter` 作为进程内 pub/sub：

```typescript
import { EventEmitter } from "events";

class LogEmitter extends EventEmitter {
  private ringBuffer: LogEvent[] = [];
  private maxBufferSize = 200;

  emit(event: "log", logEvent: LogEvent): boolean;
  
  /** 发射日志事件，同时存入 ring buffer */
  emitLog(event: LogEvent): void {
    this.ringBuffer.push(event);
    if (this.ringBuffer.length > this.maxBufferSize) {
      this.ringBuffer.shift();
    }
    this.emit("log", event);
  }

  /** 获取 ring buffer 快照（用于 WS 新连接 backfill） */
  getRecent(): LogEvent[] {
    return [...this.ringBuffer];
  }
}

export const logEmitter = new LogEmitter();
```

**设计决策：**
- 单例 `logEmitter`，全局共享
- Ring buffer 200 条（内存约 100KB，可配置），新 WS 客户端连接时推送 backfill
- `EventEmitter` 是同步分发 — listener 的执行成本直接叠加到调用方的请求路径上。因此所有 listener 必须足够轻量：terminal sink 仅做 `JSON.stringify` + `console.*`；WS sink 仅做 `ws.send()`（Bun 的 ws.send 是非阻塞的，只把数据拷贝到内核缓冲区）。高频的 `sse_chunk` 事件（debug level）在 terminal sink 中受 `RAVEN_LOG_LEVEL` 门控，info 级别下不会触发 JSON 序列化。WS sink 受客户端 `minLevel` 门控，level 判断在序列化之前，不匹配时零开销
- requestId 来源需要统一（见下方"requestId 统一"章节）

---

## 二-A、requestId 统一

**现状问题：** 当前存在两套 requestId 生成：
- `middleware.ts:18` — `requestContext()` 中间件用 `crypto.randomUUID()` 写入 `c.set("requestId", ...)`，格式为 UUID v4
- `messages.ts:64` / `chat.ts:47` — 路由内用 `generateId()` 生成 ULID 格式 ID，用于 SQLite `requests` 表主键

两者互不关联，导致日志流 requestId 和 DB 记录 ID 对不上。

**统一方案：删除中间件的 requestId 生成，统一由路由层生成。**

理由：
- 路由层的 `generateId()` 生成 ULID，既是 DB 主键也是日志关联键，一个 ID 贯穿全链路
- 中间件的 UUID 当前没有任何消费方（没有被读取或使用），是死代码
- `requestContext()` 中间件保留 `startTime`，移除 `requestId`

**修改：**
1. `middleware.ts` — `requestContext()` 删除 `requestId` 设置，`ContextVariableMap` 中移除 `requestId`
2. `messages.ts` / `chat.ts` — 路由内 `generateId()` 生成的 ID 既传给 `logRequest()`（DB）也传给 `logEmitter.emitLog()`（日志流），保持一致
3. 如果后续有中间件层需要 requestId 的场景（如 access log），在路由层通过 `c.set("requestId", id)` 回写即可

---

## 三、Terminal Sink（stdout）

**修改：`packages/proxy/src/util/logger.ts`**

重构为 LogEmitter 的消费者：

```typescript
import { logEmitter } from "./log-emitter.ts";
import type { LogEvent, LogLevel } from "./log-event.ts";

let currentLevel: LogLevel = "info";

// 订阅 LogEmitter → 输出到 stdout/stderr
logEmitter.on("log", (event: LogEvent) => {
  if (!shouldLog(event.level)) return;
  
  const line = JSON.stringify({
    ts: new Date(event.ts).toISOString(),
    level: event.level,
    type: event.type,
    msg: event.msg,
    ...(event.requestId && { requestId: event.requestId }),
    ...(event.data && Object.keys(event.data).length > 0 && event.data),
  });

  switch (event.level) {
    case "error": console.error(line); break;
    case "warn":  console.warn(line);  break;
    default:      console.log(line);
  }
});

// 保留 logger.debug/info/warn/error 便捷 API
// 内部改为调用 logEmitter.emitLog()
export const logger = {
  debug: (msg, data?) => logEmitter.emitLog({ ts: Date.now(), level: "debug", type: "system", msg, data }),
  info:  (msg, data?) => logEmitter.emitLog({ ts: Date.now(), level: "info",  type: "system", msg, data }),
  warn:  (msg, data?) => logEmitter.emitLog({ ts: Date.now(), level: "warn",  type: "system", msg, data }),
  error: (msg, data?) => logEmitter.emitLog({ ts: Date.now(), level: "error", type: "system", msg, data }),
};
```

**迁移 `console.*` 调用：**
- `index.ts` 的 4 处 `console.log("[init]...")` → `logger.info("[init]...")`
- `copilot/token.ts` 的 refresh 日志 → `logger.info` / `logger.error`
- `copilot/auth.ts` 的 device flow 日志 → `logger.info`（这些是交互式的，保留 `console.log` 或迁移均可）
- `routes/copilot-info.ts` 的 error 日志 → `logger.warn`

---

## 四、路由埋点

### 修改：`packages/proxy/src/routes/messages.ts`

```typescript
import { logEmitter } from "../util/log-emitter.ts";

// 请求开始
logEmitter.emitLog({
  ts: Date.now(),
  level: "info",
  type: "request_start",
  requestId,
  msg: `POST /v1/messages ${anthropicReq.model}`,
  data: {
    model: anthropicReq.model,
    stream: anthropicReq.stream ?? false,
    messageCount: anthropicReq.messages.length,
    toolCount: anthropicReq.tools?.length ?? 0,
    translatedModel: openAIReq.model,
    accountName,
  },
});

// SSE chunk（debug level，高频）
logEmitter.emitLog({
  ts: Date.now(),
  level: "debug",
  type: "sse_chunk",
  requestId,
  msg: `anthropic event: ${translatedEvent.type}`,
  data: { eventType: translatedEvent.type, index, blockType, toolId, toolName },
});

// 上游错误
logEmitter.emitLog({
  ts: Date.now(),
  level: "error",
  type: "upstream_error",
  requestId,
  msg: `upstream ${res.status} for ${anthropicReq.model}`,
  data: { statusCode: res.status, body: errorBody.slice(0, 500) },
});

// 请求结束
logEmitter.emitLog({
  ts: Date.now(),
  level: "info",
  type: "request_end",
  requestId,
  msg: `${status} ${anthropicReq.model} ${latencyMs}ms`,
  data: {
    status, statusCode, model: anthropicReq.model, resolvedModel,
    inputTokens, outputTokens, latencyMs, ttftMs, stream: true, accountName,
  },
});
```

### 修改：`packages/proxy/src/routes/chat.ts`

同 `messages.ts` 模式：`request_start` + `request_end`。chat 路由不做翻译所以没有 `sse_chunk` 事件，但可以在 stream passthrough 中对 `finish_reason` 和 error 发 debug event。

---

## 五、WebSocket 端点

### 新文件：`packages/proxy/src/ws/logs.ts`

Bun.serve 原生 WebSocket handler（不走 Hono，因为 Hono 的 WS 适配不完善）：

```typescript
import type { ServerWebSocket } from "bun";
import { logEmitter } from "../util/log-emitter.ts";
import type { LogEvent, LogLevel } from "../util/log-event.ts";

interface WsData {
  minLevel: LogLevel;
  filterRequestId?: string;
}

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

export const wsHandler = {
  open(ws: ServerWebSocket<WsData>) {
    // 推送 backfill
    const recent = logEmitter.getRecent();
    for (const event of recent) {
      if (LEVEL_ORDER[event.level] >= LEVEL_ORDER[ws.data.minLevel]) {
        ws.send(JSON.stringify(event));
      }
    }

    // 订阅新事件
    const listener = (event: LogEvent) => {
      if (LEVEL_ORDER[event.level] < LEVEL_ORDER[ws.data.minLevel]) return;
      if (ws.data.filterRequestId && event.requestId !== ws.data.filterRequestId) return;
      ws.send(JSON.stringify(event));
    };
    logEmitter.on("log", listener);
    (ws as any)._logListener = listener;
  },

  close(ws: ServerWebSocket<WsData>) {
    const listener = (ws as any)._logListener;
    if (listener) logEmitter.off("log", listener);
  },

  message(ws: ServerWebSocket<WsData>, msg: string) {
    // 客户端可动态调整过滤
    try {
      const cmd = JSON.parse(msg);
      if (cmd.type === "set_level") ws.data.minLevel = cmd.level;
      if (cmd.type === "set_filter") ws.data.filterRequestId = cmd.requestId ?? undefined;
    } catch { /* ignore */ }
  },
};
```

### 修改：`packages/proxy/src/index.ts`

Bun.serve 支持同时处理 HTTP 和 WebSocket：

```typescript
import { wsHandler } from "./ws/logs.ts";
import { validateApiKey } from "./db/keys.ts";
import { timingSafeEqual } from "./middleware.ts";

export default {
  port: config.port,
  fetch(req: Request, server: Server) {
    // WebSocket upgrade for /ws/logs
    const url = new URL(req.url);
    if (url.pathname === "/ws/logs") {
      // Auth: query token, required unless dev mode
      const token = url.searchParams.get("token");
      if (!authenticateWs(token, db, config.apiKey)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const upgraded = server.upgrade(req, {
        data: { minLevel: url.searchParams.get("level") ?? "info" },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    // Regular HTTP → Hono
    return app.fetch(req, server);
  },
  websocket: wsHandler,
  idleTimeout: 255,
};

/**
 * WS 鉴权复用 multiKeyAuth 相同语义：
 * 1. Dev mode: !envApiKey && DB 无 key → 放行
 * 2. rk- prefix → DB hash lookup
 * 3. 其他 token → timing-safe compare vs envApiKey
 * 4. 无 token 且非 dev mode → 拒绝
 */
function authenticateWs(
  token: string | null,
  db: Database,
  envApiKey?: string,
): boolean {
  const hasDbKeys = getKeyCount(db) > 0;
  // Dev mode
  if (!envApiKey && !hasDbKeys) return true;
  // No token provided
  if (!token) return false;
  // rk- prefix → DB path
  if (token.startsWith("rk-")) return validateApiKey(db, token) !== null;
  // env path
  if (envApiKey) return timingSafeEqual(token, envApiKey);
  return false;
}
```

**安全设计：**

Proxy 侧 `/ws/logs` 使用 query token 鉴权（`?token=`），鉴权逻辑完整复用 `multiKeyAuth` 三条路径（dev mode / rk- DB key / env key）。

**浏览器不直连 proxy。** 浏览器原生 `new WebSocket(url)` 不支持自定义请求头，而把长期凭证（`RAVEN_API_KEY` 或 DB key）通过任何方式下发到浏览器（server component props、`NEXT_PUBLIC_*`、inline script）都会将管理级密钥暴露到客户端 JS，安全模型不成立。

**解决方案：Dashboard BFF 做 WS 代理。** 浏览器连 Next.js 的 WS 端点，Next.js 服务端连 proxy，凭证永远不离开服务端。

```
浏览器 ←WS→ Next.js /api/ws/logs ←WS→ Proxy /ws/logs?token=${RAVEN_API_KEY}
              (NextAuth session 鉴权)      (query token 鉴权)
```

- **浏览器 → Next.js**：通过 NextAuth session cookie 鉴权（复用现有 `proxy.ts` 中间件），无需额外凭证
- **Next.js → Proxy**：服务端用 `RAVEN_API_KEY`（私有 env var）拼接 query token，凭证不暴露到客户端

**调试工具直连 proxy**（不经过 BFF）：
```bash
websocat "ws://localhost:7033/ws/logs?token=rk-xxx&level=debug"
```

### 5.2 Dashboard WS 代理

**新文件：`packages/dashboard/src/app/api/ws/logs/route.ts`**

Next.js 16 Route Handler 实现 WS 代理：

```typescript
// Next.js 16 WebSocket route handler
export function GET(req: Request) {
  // 1. 验证 NextAuth session（复用 auth()）
  // 2. 建立到 proxy 的 upstream WS 连接（附带 RAVEN_API_KEY query token）
  // 3. 双向转发消息：浏览器 ↔ Next.js ↔ proxy
  // 4. 任一端断开时清理另一端
}
```

WS 代理是轻量的消息转发，不解析或缓存日志内容。upstream URL 从 `RAVEN_PROXY_URL` 构建（`ws://` scheme）。

---

## 六、Dashboard 日志页面

### 6.1 路由与 Sidebar

- 路由：`/logs`
- Sidebar：加入 Monitor 组，位于 Requests 之后

```typescript
// sidebar.tsx NAV_GROUPS[0].items
{ href: "/logs", label: "Logs", icon: Terminal },
```

### 6.2 WS Hook

**新文件：`packages/dashboard/src/hooks/use-log-stream.ts`**

```typescript
export function useLogStream(options?: { level?: string }) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const bufferRef = useRef<LogEvent[]>([]);

  // WS 连接到 dashboard BFF: ws://raven.dev.hexly.ai/api/ws/logs?level=info
  // 鉴权通过 NextAuth session cookie 自动携带，无需传 token
  // 自动重连（exponential backoff）
  // paused 时 buffer 到 bufferRef，resume 时 flush

  return { events, connected, paused, setPaused, clear, setLevel };
}
```

WS URL 与 dashboard 同源（相对路径 `/api/ws/logs`），浏览器自动携带 session cookie，无需任何凭证配置。

### 6.3 页面组件

**新文件：`packages/dashboard/src/app/logs/page.tsx`** — Server component shell

**新文件：`packages/dashboard/src/app/logs/logs-content.tsx`** — Client component

布局：

```
┌─────────────────────────────────────────────────┐
│ Logs                          [Level ▾] [⏸ ⏹] │
│ ● Connected                   [Search...]       │
├─────────────────────────────────────────────────┤
│ ▶ 16:23:45.123 POST /v1/messages claude-opus    │
│   ├ request_start  model=claude-opus stream=true │
│   ├ sse_chunk      content_block_start tool_use  │
│   ├ sse_chunk      content_block_delta text      │
│   ├ sse_chunk      content_block_stop            │
│   ├ sse_chunk      message_delta stop_reason=end │
│   └ request_end    ✓ 3420ms  in:1234 out:567    │
│                                                  │
│ ▶ 16:23:40.001 POST /v1/chat/completions gpt-4o │
│   └ request_end    ✓ 890ms   in:100  out:50     │
│                                                  │
│ ▶ 16:23:38.500 POST /v1/messages claude-sonnet   │
│   ├ upstream_error  502 Bad Gateway              │
│   └ request_end    ✗ 1200ms  error              │
└─────────────────────────────────────────────────┘
```

**UI 要素：**

| 元素 | 说明 |
|------|------|
| 连接指示器 | 绿点 = connected，红点 = disconnected，自动重连时显示 "Reconnecting..." |
| Level 下拉 | debug / info / warn / error，动态发 `set_level` 给 WS |
| 暂停/恢复 | 暂停时红色 badge 显示 buffered 条数 |
| 搜索 | 客户端过滤 msg + model + requestId |
| 请求分组 | 按 `requestId` 分组，折叠/展开，`system` 类型不分组 |
| 颜色高亮 | info=默认，warn=黄色左边框，error=红色左边框+红色文字 |
| 时间戳 | 相对时间（3s ago）hover 显示绝对时间 |
| 自动滚动 | 新日志到达时自动滚到底部，用户手动上滚时暂停自动滚动 |

### 6.4 新增 shadcn 组件

可能需要 `ScrollArea`（如果还没有的话）。其余用现有的 `Badge`, `Button`, `Select`, `Input`。

---

## 七、环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RAVEN_LOG_LEVEL` | `info` | Terminal sink 最低输出级别（现有） |
| `RAVEN_LOG_BUFFER_SIZE` | `200` | Ring buffer 大小 |

Dashboard WS 连接为同源相对路径（`/api/ws/logs`），不需要额外 URL 配置。BFF 代理通过现有 `RAVEN_PROXY_URL` + `RAVEN_API_KEY` 连接 proxy。

---

## 八、向后兼容

- `logger.debug/info/warn/error` API 不变，调用方无需修改
- `RAVEN_LOG_LEVEL` 语义不变
- 现有 `logRequest()` + SQLite 持久化不受影响（LogEmitter 是额外通道，不替代 DB 记录）
- WebSocket 是新增端点，不影响现有 HTTP 路由

---

## 九、原子化提交

| # | Commit | 文件 |
|---|--------|------|
| 1 | `feat: add LogEvent types and LogEmitter event bus` ✅ | `util/log-event.ts`, `util/log-emitter.ts` |
| 2 | `refactor: wire logger.ts as LogEmitter terminal sink` ✅ | `util/logger.ts`, `index.ts`, `copilot/token.ts` |
| 3 | `refactor: unify requestId generation in route layer` ✅ | `middleware.ts`, `routes/messages.ts`, `routes/chat.ts` |
| 4 | `feat: instrument routes with structured log events` ✅ | `routes/messages.ts`, `routes/chat.ts` |
| 5 | `feat: add WebSocket /ws/logs endpoint with auth and backfill` ✅ | `ws/logs.ts`, `index.ts` |
| 6 | `feat: add dashboard SSE proxy route for log streaming` ✅ | dashboard: `app/api/logs/stream/route.ts` |
| 7 | `feat: add real-time log viewer dashboard page` | dashboard: `hooks/use-log-stream.ts`, `app/logs/`, `sidebar.tsx` |
| 8 | `test: add unit tests for LogEmitter and WS handler` | `test/util/log-emitter.test.ts`, `test/ws/logs.test.ts` |

---

## 十、验证

1. **单元测试**：LogEmitter ring buffer、level gating、listener 注册/清理
2. **Terminal 验证**：`RAVEN_LOG_LEVEL=debug bun run dev` → 发请求 → 看 JSON lines 含 `request_start`/`sse_chunk`/`request_end`
3. **WebSocket 验证**：`websocat ws://localhost:7033/ws/logs` → 看实时事件流
4. **Dashboard 验证**：打开 `/logs` → 发请求 → 看事件实时出现、按 requestId 折叠、error 红色高亮
5. **暂停/恢复**：暂停 → 发请求 → 恢复 → buffer 的事件一次性 flush
6. **向后兼容**：现有 `bun run test` 218 tests 仍全部通过
