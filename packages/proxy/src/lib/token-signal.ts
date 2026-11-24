/**
 * Token signal channel — used by upstream clients to report auth failures.
 *
 * 完整实现（阶段 2）：score 累积 + decay + 阈值判定。
 *
 * 决策语义（docs/23-token-sentinel.md §8）：
 *   - reportAuthFailure("token-expired") → score += 3
 *   - reportAuthFailure("other-401")     → score += 1
 *   - shouldProbeNow() → score >= SIGNAL_THRESHOLD (5)
 *   - decay()         → score = max(0, score - 1)
 *
 * 信号只决定 PROBING 频率档，**不决定**是否触发刷新——刷新决策由
 * client 直接调 refreshNow 完成。
 */

export type AuthFailureReason = "token-expired" | "other-401";

export interface TokenSignal {
  reportAuthFailure(reason: AuthFailureReason): void;
  shouldProbeNow(): boolean;
  decay(): void;
  /**
   * Returns true if reportAuthFailure() has been called at least once since
   * the previous consumeFreshReport() call. Used by the sentinel to decide
   * whether to extend PROBING's remainingProbeTicks (only fresh signals
   * extend; sustained high score alone does not).
   */
  consumeFreshReport(): boolean;
  /** For tests / metrics only. */
  readScore(): number;
}

const SIGNAL_THRESHOLD = 5;
const SIGNAL_TOKEN_EXPIRED_WEIGHT = 3;
const SIGNAL_OTHER_401_WEIGHT = 1;
// Bound score so a sustained 401 burst cannot pin shouldProbeNow() above
// threshold for arbitrarily long. With cap = THRESHOLD * 2, a burst takes at
// most (cap - THRESHOLD + 1) decay ticks to fall below threshold once burst
// ends — bounded recovery time independent of burst size.
const SIGNAL_SCORE_CAP = SIGNAL_THRESHOLD * 2;

let score = 0;
let pendingFreshReport = false;

export const tokenSignal: TokenSignal = {
  reportAuthFailure(reason: AuthFailureReason): void {
    const delta =
      reason === "token-expired" ? SIGNAL_TOKEN_EXPIRED_WEIGHT : SIGNAL_OTHER_401_WEIGHT;
    score = Math.min(SIGNAL_SCORE_CAP, score + delta);
    pendingFreshReport = true;
  },
  shouldProbeNow(): boolean {
    return score >= SIGNAL_THRESHOLD;
  },
  decay(): void {
    score = Math.max(0, score - 1);
  },
  consumeFreshReport(): boolean {
    const had = pendingFreshReport;
    pendingFreshReport = false;
    return had;
  },
  readScore(): number {
    return score;
  },
};

/** Test-only: reset internal score to 0. Production code never calls this. */
export function _resetTokenSignalForTest(): void {
  score = 0;
  pendingFreshReport = false;
}

// ---------------------------------------------------------------------------
// isTokenExpiredBody — fuzzy match the recoverable-401 body wording.
//
// Used by Copilot upstream clients to decide whether to:
//   - report "token-expired" (vs "other-401") to tokenSignal
//   - await sentinel.refreshNow("llm-401") + retry once
//
// 误判风险（上游措辞变动）会退化为 "用户看见 401"——可观察、可恢复，
// 由哨兵 tick 兜底。所以判据保守：只要 body 同时包含 "token" 和 "expired"
// (任意顺序、大小写、空白) 就命中。
// ---------------------------------------------------------------------------

export function isTokenExpiredBody(status: number, body: string): boolean {
  if (status !== 401) return false;
  const lower = body.toLowerCase();
  return lower.includes("token") && lower.includes("expired");
}
