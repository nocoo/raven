/**
 * SSE keepalive — sends `: keepalive\n\n` comments to prevent idle timeout.
 *
 * SSE spec allows lines starting with `:` as comments; compliant clients
 * silently ignore them. This resets Bun.serve's idleTimeout counter so
 * long-running streams (e.g. LLM thinking) are never killed.
 */

const KEEPALIVE_INTERVAL_MS = 30_000;
const KEEPALIVE_BYTES = new TextEncoder().encode(": keepalive\n\n");

export interface Keepalive {
  /** Call this whenever real data is enqueued to reset the timer. */
  ping(): void;
  /** Stop the keepalive timer (call in finally block). */
  stop(): void;
}

/**
 * Start a keepalive timer that enqueues SSE comments into the controller.
 *
 * Usage:
 * ```ts
 * const ka = startKeepalive(controller);
 * try {
 *   for await (const data of stream) {
 *     controller.enqueue(encode(data));
 *     ka.ping();
 *   }
 * } finally {
 *   ka.stop();
 * }
 * ```
 */
export function startKeepalive(
  controller: ReadableStreamDefaultController<Uint8Array>,
): Keepalive {
  let timer: ReturnType<typeof setInterval> | null = null;

  const schedule = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      try {
        controller.enqueue(KEEPALIVE_BYTES);
      } catch {
        // Controller closed — stop silently
        stop();
      }
    }, KEEPALIVE_INTERVAL_MS);
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  // Start immediately
  schedule();

  return {
    ping: schedule, // reset interval on each real write
    stop,
  };
}
