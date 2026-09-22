/**
 * Token Sentinel — single-writer Copilot token refresh.
 *
 * 完整设计：docs/23-token-sentinel.md
 *
 * 核心不变量（验收范围 packages/proxy/src/**）：
 *   I-1 state.copilotToken 写入只在本文件
 *   I-2 经由 refreshNow() 的刷新 single-flight（setupCopilotToken 重入为例外）
 *   I-3 LLM 路径不调 getCopilotToken / 不写 state.copilotToken
 *   I-4 sentinel tick 任何异常都被 catch，必排下一 tick
 *   I-5 LLM 路径每个请求最多 2 次上游 fetch（首次 + 重试），代码层硬编码
 */

import { logger } from "../util/logger"
import { getCopilotToken } from "../services/github/get-copilot-token"
import { getModels } from "../services/copilot/get-models"
import { HTTPError } from "./error"
import { state } from "./state"
import { tokenSignal } from "./token-signal"
import type { TimerFactory } from "./token"

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const MIN_REFRESH_MS = 30_000              // STEADY 周期下限
const DEFAULT_STEADY_INTERVAL_MS = 25 * 60_000 // bootstrap 之前的兜底
const PROBE_INTERVAL_MS = 5_000
const PROBE_TICKS = 3
const MIN_REFRESH_INTERVAL_MS = 30_000     // refreshNow 最近成功后多少 ms 内不重复访问上游
const REFRESH_INITIAL_BACKOFF_MS = 5_000
const REFRESH_MAX_BACKOFF_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefreshReason = "llm-401" | "sentinel-401" | "scheduled" | "manual"

export type RefreshResult =
  | { ok: true; tokenWasUpdated: boolean; refreshInSeconds: number | null }
  | { ok: false; error: unknown; cooldownMs: number }

export interface RefreshNowOptions {
  /**
   * 仅 sentinelTick 内部调用时传 true，标记本次 inflight 为 "sentinel-owned"：
   * finally 走 dirtyAfterTick 路径（不立即 rearm），由 tick 末 scheduleNext 收尾。
   * 外部调用者（LLM 路径 / dashboard / 测试）**不要**设置该字段。
   */
  fromSentinelTick?: boolean
}

export interface BootstrapOptions {
  token: string
  refreshInSeconds: number
  timers?: TimerFactory
}

export interface SentinelHandle {
  stop(): void
}

interface SentinelState {
  mode: "steady" | "probing"
  remainingProbeTicks: number
}

// ---------------------------------------------------------------------------
// Module-global state
// ---------------------------------------------------------------------------

let inflight: Promise<RefreshResult> | null = null
/**
 * 标记当前 inflight 是否由 sentinelTick 自己 await 发起。inflight finally
 * 通过捕获的 fromSentinelTick 参数决定 rearm 行为，本变量仅服务于
 * `_debugSnapshot()` 的可观察性，便于测试断言。
 */
let inflightFromSentinelTick = false
let lastSuccessAt = 0
let lastRefreshInSeconds: number | null = null

let failureCooldownUntil = 0
let consecutiveFailures = 0
/**
 * 任意来源 refresh 失败 → true；下一次 sentinelTick 在 cooldown 结束后
 * 强制把 mode 压回 STEADY 走主动刷新，避免 PROBING 接管导致只 cacheModels
 * 不刷 token 的死锁。noteSuccess 清零。
 */
let forceSteadyAfterCooldown = false

let activeTimers: TimerFactory | null = null
let pendingTimeoutHandle: ReturnType<TimerFactory["setTimeout"]> | null = null
let sentinelState: SentinelState | null = null

let generation = 0

/**
 * 标记本 tick 内 sentinel-owned inflight 已完成、需要 tick 末统一收尾
 * （scheduleNext 在 tick 末总是会跑，所以此变量目前只供调试 / 未来扩展）。
 */
let dirtyAfterTick = false

// ---------------------------------------------------------------------------
// Observability counters
//
// 累积自进程启动以来的关键事件次数，供 dashboard / /api/sentinel-status
// 端点读出，让 PR #129 修复在生产环境可观察。bootstrap/teardown 不重置
// 这些计数器——它们是进程级累计值。
// ---------------------------------------------------------------------------

interface RefreshReasonBuckets {
  llm401: number
  sentinel401: number
  scheduled: number
  manual: number
}

interface SentinelCounters {
  /** refreshNow() 入口被调用的次数 (按 reason 分桶) */
  refreshRequested: RefreshReasonBuckets
  /** refreshNow 短路（attemptedToken 不匹配，未访问上游）— 按 reason 分桶 */
  refreshShortCircuit: number
  refreshShortCircuitByReason: RefreshReasonBuckets
  /** refreshNow 命中 cooldown，被全局退避拦回 — 按 reason 分桶 */
  refreshBlockedByCooldown: number
  refreshBlockedByCooldownByReason: RefreshReasonBuckets
  /** refreshNow 命中 min-interval，未访问上游 — 按 reason 分桶 */
  refreshBlockedByMinInterval: number
  refreshBlockedByMinIntervalByReason: RefreshReasonBuckets
  /** 真正访问了上游的 getCopilotToken（无论成功失败）次数 */
  refreshUpstreamCalls: number
  refreshUpstreamCallsByReason: RefreshReasonBuckets
  /** 上游访问成功且确实换了 token — 按 reason 分桶 */
  refreshSucceededTokenUpdated: number
  refreshSucceededTokenUpdatedByReason: RefreshReasonBuckets
  /** 上游访问成功但 token 字面没变（refresh_in 续期类）— 按 reason 分桶 */
  refreshSucceededTokenSame: number
  refreshSucceededTokenSameByReason: RefreshReasonBuckets
  /** 上游访问失败次数 — 按 reason 分桶 */
  refreshFailed: number
  refreshFailedByReason: RefreshReasonBuckets
  /** stale generation 路径（旧 loop inflight 被丢弃） */
  refreshDiscardedStale: number
  /** LLM 路径上报的 401 — token-expired 文案命中 */
  llm401TokenExpired: number
  /** LLM 路径上报的 401 — 非 token-expired */
  llm401Other: number
  /** sentinel-401 (cacheModels 撞 401) 次数 */
  cacheModels401: number
  /** sentinel 进入 PROBING 模式的次数 */
  probingEntered: number
}

function zeroBuckets(): RefreshReasonBuckets {
  return { llm401: 0, sentinel401: 0, scheduled: 0, manual: 0 }
}

const counters: SentinelCounters = {
  refreshRequested: zeroBuckets(),
  refreshShortCircuit: 0,
  refreshShortCircuitByReason: zeroBuckets(),
  refreshBlockedByCooldown: 0,
  refreshBlockedByCooldownByReason: zeroBuckets(),
  refreshBlockedByMinInterval: 0,
  refreshBlockedByMinIntervalByReason: zeroBuckets(),
  refreshUpstreamCalls: 0,
  refreshUpstreamCallsByReason: zeroBuckets(),
  refreshSucceededTokenUpdated: 0,
  refreshSucceededTokenUpdatedByReason: zeroBuckets(),
  refreshSucceededTokenSame: 0,
  refreshSucceededTokenSameByReason: zeroBuckets(),
  refreshFailed: 0,
  refreshFailedByReason: zeroBuckets(),
  refreshDiscardedStale: 0,
  llm401TokenExpired: 0,
  llm401Other: 0,
  cacheModels401: 0,
  probingEntered: 0,
}

function reasonKey(reason: RefreshReason): keyof RefreshReasonBuckets {
  switch (reason) {
    case "llm-401":      return "llm401"
    case "sentinel-401": return "sentinel401"
    case "scheduled":    return "scheduled"
    case "manual":       return "manual"
  }
}

function bumpBy(reason: RefreshReason, bucket: RefreshReasonBuckets): void {
  bucket[reasonKey(reason)] += 1
}

function incRefreshRequested(reason: RefreshReason): void {
  bumpBy(reason, counters.refreshRequested)
}

/** External: report an llm-side 401 outcome (called by upstream clients). */
export function noteLlm401(kind: "token-expired" | "other-401"): void {
  if (kind === "token-expired") counters.llm401TokenExpired += 1
  else counters.llm401Other += 1
}

/** External: snapshot all counters + current state. Used by status endpoint. */
export function getSentinelStatus(): {
  generation: number
  mode: SentinelState["mode"] | null
  cooldownRemainingMs: number
  consecutiveFailures: number
  forceSteadyAfterCooldown: boolean
  lastRefreshInSeconds: number | null
  lastSuccessAt: number
  hasInflight: boolean
  pendingTimer: boolean
  signalScore: number
  counters: SentinelCounters
} {
  return {
    generation,
    mode: sentinelState?.mode ?? null,
    cooldownRemainingMs: getRefreshCooldownRemaining(),
    consecutiveFailures,
    forceSteadyAfterCooldown,
    lastRefreshInSeconds,
    lastSuccessAt,
    hasInflight: inflight !== null,
    pendingTimer: pendingTimeoutHandle !== null,
    signalScore: tokenSignal.readScore(),
    counters: {
      ...counters,
      refreshRequested: { ...counters.refreshRequested },
      refreshShortCircuitByReason: { ...counters.refreshShortCircuitByReason },
      refreshBlockedByCooldownByReason: { ...counters.refreshBlockedByCooldownByReason },
      refreshBlockedByMinIntervalByReason: { ...counters.refreshBlockedByMinIntervalByReason },
      refreshUpstreamCallsByReason: { ...counters.refreshUpstreamCallsByReason },
      refreshSucceededTokenUpdatedByReason: { ...counters.refreshSucceededTokenUpdatedByReason },
      refreshSucceededTokenSameByReason: { ...counters.refreshSucceededTokenSameByReason },
      refreshFailedByReason: { ...counters.refreshFailedByReason },
    },
  }
}

/** Test-only: reset all observability counters. Production never calls this. */
export function _resetSentinelCountersForTest(): void {
  counters.refreshRequested = zeroBuckets()
  counters.refreshShortCircuit = 0
  counters.refreshShortCircuitByReason = zeroBuckets()
  counters.refreshBlockedByCooldown = 0
  counters.refreshBlockedByCooldownByReason = zeroBuckets()
  counters.refreshBlockedByMinInterval = 0
  counters.refreshBlockedByMinIntervalByReason = zeroBuckets()
  counters.refreshUpstreamCalls = 0
  counters.refreshUpstreamCallsByReason = zeroBuckets()
  counters.refreshSucceededTokenUpdated = 0
  counters.refreshSucceededTokenUpdatedByReason = zeroBuckets()
  counters.refreshSucceededTokenSame = 0
  counters.refreshSucceededTokenSameByReason = zeroBuckets()
  counters.refreshFailed = 0
  counters.refreshFailedByReason = zeroBuckets()
  counters.refreshDiscardedStale = 0
  counters.llm401TokenExpired = 0
  counters.llm401Other = 0
  counters.cacheModels401 = 0
  counters.probingEntered = 0
}

// ---------------------------------------------------------------------------
// Bookkeeping helpers
// ---------------------------------------------------------------------------

function noteSuccess(refreshInSeconds: number): void {
  consecutiveFailures = 0
  failureCooldownUntil = 0
  forceSteadyAfterCooldown = false
  lastSuccessAt = Date.now()
  lastRefreshInSeconds = refreshInSeconds
}

function noteFailure(): number {
  consecutiveFailures += 1
  const backoff = Math.min(
    REFRESH_INITIAL_BACKOFF_MS * 2 ** (consecutiveFailures - 1),
    REFRESH_MAX_BACKOFF_MS,
  )
  failureCooldownUntil = Date.now() + backoff
  forceSteadyAfterCooldown = true
  return backoff
}

/** Sentinel 调度 / 外部观察用：剩余冷却时间 */
export function getRefreshCooldownRemaining(): number {
  return Math.max(0, failureCooldownUntil - Date.now())
}

/** Sentinel 调度 / 外部观察用：上游最近一次返回的 refresh_in（秒） */
export function getLastRefreshInSeconds(): number | null {
  return lastRefreshInSeconds
}

/** Test-only: snapshot module-global state (供单元测试断言) */
export function _debugSnapshot(): {
  generation: number
  consecutiveFailures: number
  cooldownRemaining: number
  forceSteadyAfterCooldown: boolean
  lastRefreshInSeconds: number | null
  hasInflight: boolean
  inflightFromSentinelTick: boolean
  pendingTimer: boolean
  dirtyAfterTick: boolean
  mode: SentinelState["mode"] | null
} {
  return {
    generation,
    consecutiveFailures,
    cooldownRemaining: getRefreshCooldownRemaining(),
    forceSteadyAfterCooldown,
    lastRefreshInSeconds,
    hasInflight: inflight !== null,
    inflightFromSentinelTick,
    pendingTimer: pendingTimeoutHandle !== null,
    dirtyAfterTick,
    mode: sentinelState?.mode ?? null,
  }
}

// ---------------------------------------------------------------------------
// Tick scheduling
// ---------------------------------------------------------------------------

function intervalFromRefreshIn(refreshInSeconds: number): number {
  return Math.max((refreshInSeconds - 60) * 1000, MIN_REFRESH_MS)
}

function currentSteadyIntervalMs(): number {
  const r = lastRefreshInSeconds
  return r != null ? intervalFromRefreshIn(r) : DEFAULT_STEADY_INTERVAL_MS
}

function computeNextDelay(mode: "steady" | "probing"): number {
  const cooldown = getRefreshCooldownRemaining()
  if (cooldown > 0) return cooldown
  if (mode === "probing") return PROBE_INTERVAL_MS
  return currentSteadyIntervalMs()
}

function isAuthError(err: unknown): boolean {
  return err instanceof HTTPError && err.status === 401
}

/**
 * 仅在 inflight 完成的 finally 调用：根据"是否 sentinel-owned"决定
 * 立即 rearm 还是仅打 dirty 标志。
 */
function rearmSentinelAfterRefresh(fromSentinelTick: boolean): void {
  if (!sentinelState || !activeTimers) return
  if (fromSentinelTick) {
    dirtyAfterTick = true
    return
  }
  if (pendingTimeoutHandle) {
    activeTimers.clearTimeout(pendingTimeoutHandle)
    pendingTimeoutHandle = null
  }
  scheduleNext(sentinelState, activeTimers)
}

function scheduleNext(
  s: SentinelState,
  timers: TimerFactory,
  opts: { tickFailed?: boolean } = {},
): void {
  // Stale guard: if this scheduleNext is being called from a tick whose state
  // / timer factory no longer matches the currently active loop (because
  // bootstrap re-entry or stop() happened mid-tick), do not touch global
  // state. Otherwise an old tick can:
  //   - clear the new loop's pendingTimeoutHandle (orphan it), and/or
  //   - install its own setTimeout, effectively reviving the dead sentinel.
  if (s !== sentinelState || timers !== activeTimers) {
    return
  }
  if (opts.tickFailed) {
    // 失败 / fatal：强制 STEADY，让 cooldown 结束后必走主动 scheduled refresh
    s.mode = "steady"
    s.remainingProbeTicks = 0
    // Drain the fresh-report flag so it doesn't immediately re-trigger PROBING
    // on the next tick — failure path should land on STEADY, period.
    tokenSignal.consumeFreshReport()
  } else {
    const wantsProbe = tokenSignal.shouldProbeNow() // 在 decay 之前调用
    const hadFreshReport = tokenSignal.consumeFreshReport()
    if (wantsProbe && s.mode !== "probing") {
      // Fresh entry into PROBING
      s.mode = "probing"
      s.remainingProbeTicks = PROBE_TICKS
      counters.probingEntered += 1
    } else if (s.mode === "probing") {
      // Hard upper bound: tick budget decrements regardless of score.
      // Only a NEW signal arriving during PROBING refreshes the budget.
      // Without this, a sustained 401 burst would pin shouldProbeNow() above
      // threshold and PROBING would never exit.
      if (hadFreshReport) {
        s.remainingProbeTicks = PROBE_TICKS
      } else {
        s.remainingProbeTicks -= 1
      }
      if (s.remainingProbeTicks <= 0) {
        s.mode = "steady"
      }
    }
  }

  const nextMs = computeNextDelay(s.mode)
  // Defensively clear any existing pending handle before assigning a new one.
  // (Race: external LLM refreshNow rearm during this tick's await of
  // cacheModels could have already scheduled a timer.)
  // We've already verified above that timers === activeTimers.
  if (pendingTimeoutHandle) {
    timers.clearTimeout(pendingTimeoutHandle)
  }
  pendingTimeoutHandle = timers.setTimeout(() => {
    // Return the promise so harnesses that await `callback()` (e.g. fake
    // timers) wait for the whole tick to settle. Real setTimeout ignores
    // the return value.
    return sentinelTick(s, timers)
  }, nextMs) as ReturnType<TimerFactory["setTimeout"]>
}

async function sentinelTick(s: SentinelState, timers: TimerFactory): Promise<void> {
  // Stale guard at entry: if a teardown/bootstrap happened between this
  // tick being scheduled and now firing, just exit. Don't touch
  // pendingTimeoutHandle / forceSteadyAfterCooldown — those belong to the
  // currently active loop. Anything written here would be a stray side
  // effect from a dead loop.
  if (s !== sentinelState || timers !== activeTimers) {
    return
  }

  // tick 已触发 → 不再代表未来挂起
  pendingTimeoutHandle = null
  dirtyAfterTick = false

  const inCooldown = getRefreshCooldownRemaining() > 0

  // 消费 forceSteadyAfterCooldown：上一次失败留下的强制 STEADY 标志
  if (forceSteadyAfterCooldown && !inCooldown && s.mode === "probing") {
    s.mode = "steady"
    s.remainingProbeTicks = 0
  }

  try {
    // ── STEADY: 主动 scheduled refresh ──
    if (s.mode === "steady" && !inCooldown) {
      const result = await refreshNow("scheduled", undefined, { fromSentinelTick: true })
      // Re-check staleness after await: bootstrap/stop could have run while
      // refreshNow was in flight.
      if (s !== sentinelState || timers !== activeTimers) return
      if (!result.ok) {
        logger.warn("scheduled refresh failed in steady tick", {
          error: String(result.error),
          cooldownMs: result.cooldownMs,
        })
        scheduleNext(s, timers, { tickFailed: true })
        return
      }
    }

    // ── 闭环 / 探活：cooldown 期间彻底跳过 ──
    if (!inCooldown) {
      try {
        await getModels()
        if (s !== sentinelState || timers !== activeTimers) return
      } catch (e) {
        if (s !== sentinelState || timers !== activeTimers) return
        if (isAuthError(e)) {
          counters.cacheModels401 += 1
          await refreshNow("sentinel-401", undefined, { fromSentinelTick: true })
          if (s !== sentinelState || timers !== activeTimers) return
          // 本 tick 不递归 cacheModels
        } else {
          logger.warn("sentinel /models failed (non-auth)", { error: String(e) })
        }
      }
    }

    // I-Order: 先判 mode（在 decay 之前），再 decay
    scheduleNext(s, timers)
    tokenSignal.decay()
  } catch (fatal) {
    // I-4: 任何意外异常都不让 loop 死
    logger.error("sentinel tick fatal", { error: String(fatal) })
    if (s !== sentinelState || timers !== activeTimers) return
    try {
      scheduleNext(s, timers, { tickFailed: true })
    } catch (rescheduleErr) {
      // 兜底兜底：scheduleNext 本身抛错（理论不应发生）→ 用最低开销的方式排下一 tick
      logger.error("sentinel scheduleNext fatal; falling back to raw setTimeout", {
        error: String(rescheduleErr),
      })
      pendingTimeoutHandle = timers.setTimeout(() => {
        return sentinelTick(s, timers)
      }, currentSteadyIntervalMs()) as ReturnType<TimerFactory["setTimeout"]>
    }
  }
}

// ---------------------------------------------------------------------------
// refreshNow
// ---------------------------------------------------------------------------

/**
 * 请求哨兵刷新 token。
 *
 * @param reason - 触发原因（日志 / 指标）
 * @param attemptedToken - 调用方本次请求使用的 token；用于"并发尾部请求"短路：
 *   若 state.copilotToken 此刻已不是它，说明已被他人成功刷新，直接返回
 *   tokenWasUpdated=true 让调用方重试，不再访问上游。
 * @param opts.fromSentinelTick - 仅 sentinelTick 自己调用时传 true。
 */
export async function refreshNow(
  reason: RefreshReason,
  attemptedToken?: string,
  opts: RefreshNowOptions = {},
): Promise<RefreshResult> {
  incRefreshRequested(reason)

  // 1. 短路：state 已比 caller 用的更新 → 让 caller 重试
  if (attemptedToken && state.copilotToken !== attemptedToken) {
    counters.refreshShortCircuit += 1
    bumpBy(reason, counters.refreshShortCircuitByReason)
    return { ok: true, tokenWasUpdated: true, refreshInSeconds: null }
  }

  // 2. single-flight：所有并发调用共享同一个 Promise
  if (inflight) return inflight

  // 3. 失败冷却：拒绝调用、报告剩余冷却
  const cooldownLeft = getRefreshCooldownRemaining()
  if (cooldownLeft > 0) {
    counters.refreshBlockedByCooldown += 1
    bumpBy(reason, counters.refreshBlockedByCooldownByReason)
    return {
      ok: false,
      error: new Error("refresh in cooldown"),
      cooldownMs: cooldownLeft,
    }
  }

  // 4. min-interval 兜底
  //    sentinel-401 (post-refresh /models 401 validation) bypasses this:
  //    a scheduled refresh that just landed could have produced a fresh token
  //    that still isn't accepted by /models. min-interval would block the
  //    corrective re-refresh and leave a bad token in place for the full
  //    MIN_REFRESH_INTERVAL_MS window. Cooldown (step 3) and single-flight
  //    (step 2) still apply, so this exemption is bounded.
  if (reason !== "sentinel-401") {
    const sinceLast = Date.now() - lastSuccessAt
    if (sinceLast < MIN_REFRESH_INTERVAL_MS && lastSuccessAt > 0) {
      counters.refreshBlockedByMinInterval += 1
      bumpBy(reason, counters.refreshBlockedByMinIntervalByReason)
      return { ok: true, tokenWasUpdated: false, refreshInSeconds: null }
    }
  }

  // 5. capture generation + sentinel-owned 标志
  const myGeneration = generation
  const fromSentinelTick = opts.fromSentinelTick === true
  inflightFromSentinelTick = fromSentinelTick

  inflight = (async (): Promise<RefreshResult> => {
    try {
      const oldToken = state.copilotToken
      counters.refreshUpstreamCalls += 1
      bumpBy(reason, counters.refreshUpstreamCallsByReason)
      const { token, refresh_in } = await getCopilotToken()

      // generation 校验：旧 loop 飞行刷新被废弃
      if (myGeneration !== generation) {
        counters.refreshDiscardedStale += 1
        logger.debug("refreshNow result discarded (stale generation)", {
          reason,
          myGeneration,
          currentGeneration: generation,
        })
        return { ok: true, tokenWasUpdated: false, refreshInSeconds: null }
      }

      state.copilotToken = token // I-1 唯一写入点
      noteSuccess(refresh_in)
      const tokenWasUpdated = token !== oldToken
      if (tokenWasUpdated) {
        counters.refreshSucceededTokenUpdated += 1
        bumpBy(reason, counters.refreshSucceededTokenUpdatedByReason)
      } else {
        counters.refreshSucceededTokenSame += 1
        bumpBy(reason, counters.refreshSucceededTokenSameByReason)
      }
      return {
        ok: true,
        tokenWasUpdated,
        refreshInSeconds: refresh_in,
      }
    } catch (error) {
      // generation 校验：旧 loop 失败不该影响新 loop cooldown
      if (myGeneration !== generation) {
        counters.refreshDiscardedStale += 1
        logger.debug("refreshNow failure discarded (stale generation)", {
          reason,
          error: String(error),
        })
        return {
          ok: false,
          error: new Error("stale generation"),
          cooldownMs: 0,
        }
      }
      counters.refreshFailed += 1
      bumpBy(reason, counters.refreshFailedByReason)
      const cooldownMs = noteFailure()
      logger.error("refreshNow failed", {
        reason,
        consecutiveFailures,
        cooldownMs,
        error: String(error),
      })
      return { ok: false, error, cooldownMs }
    } finally {
      // 注意：清 inflight 与 rearm 只对当前 generation 生效
      if (myGeneration === generation) {
        inflight = null
        inflightFromSentinelTick = false
        rearmSentinelAfterRefresh(fromSentinelTick)
      }
      // 若 generation 已切换：新 loop 自己的 refreshNow 调用会重新设置 inflight
    }
  })()

  return inflight
}

// ---------------------------------------------------------------------------
// bootstrap / teardown
// ---------------------------------------------------------------------------

function teardownInternal(): void {
  if (activeTimers && pendingTimeoutHandle) {
    activeTimers.clearTimeout(pendingTimeoutHandle)
  }
  pendingTimeoutHandle = null
  sentinelState = null
  activeTimers = null
  // generation 递增：任何已飞行 refreshNow inflight 完成时校验 generation 不匹配
  // → 丢弃结果。堵住"旧 loop 飞行刷新污染新 loop"。
  generation += 1
  // 同时清掉失败状态，让新 loop 从干净起点开始
  failureCooldownUntil = 0
  consecutiveFailures = 0
  forceSteadyAfterCooldown = false
  lastSuccessAt = 0
  lastRefreshInSeconds = null
  // 不主动清 inflight：旧 inflight 仍挂着，但 finally 会因 generation 不匹配
  // 走废弃路径。新 loop 的 refreshNow 调用会重设 inflight。
  inflight = null
  inflightFromSentinelTick = false
  dirtyAfterTick = false
}

/**
 * 单一入口：写入首把 token + 启动哨兵 loop。
 * 返回 stop() 句柄给测试 / 关停使用。
 *
 * 重入语义：若已有活动 loop，先 teardownInternal() 清旧再建新。
 */
export function bootstrap(opts: BootstrapOptions): SentinelHandle {
  const timers = opts.timers ?? defaultBootstrapTimers()

  if (sentinelState || pendingTimeoutHandle) {
    logger.warn("sentinel.bootstrap called while loop is active; resetting")
    teardownInternal()
  } else {
    // 即使没有 active loop，也保证 generation 递增隔离任何遗留 inflight
    // （例如外部代码直接调过 refreshNow 后再 bootstrap）
    generation += 1
    inflight = null
    inflightFromSentinelTick = false
  }

  state.copilotToken = opts.token // I-1 写入点（bootstrap 路径）
  noteSuccess(opts.refreshInSeconds)

  sentinelState = {
    mode: "steady",
    remainingProbeTicks: 0,
  }
  activeTimers = timers

  pendingTimeoutHandle = timers.setTimeout(() => {
    return sentinelTick(sentinelState!, timers)
  }, currentSteadyIntervalMs()) as ReturnType<TimerFactory["setTimeout"]>

  return {
    stop: teardownInternal,
  }
}

function defaultBootstrapTimers(): TimerFactory {
  return {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  }
}
