/**
 * Refactor E2E safety net helpers.
 *
 * Per docs/20-architecture-refactor.md §4.3 anti-ban protocol is suspended
 * for this suite. Retries allowed, but scenario count is bounded by §4.3
 * tables. Golden files are captured once on main before Step 1.
 */

const PROXY = process.env.RAVEN_PROXY_URL ?? "http://localhost:7024";
const API_KEY = process.env.RAVEN_API_KEY ?? "";

export { PROXY, API_KEY };

export function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  return h;
}

export interface SseEvent {
  event?: string;
  data: string;
}

export async function consumeSSE(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  const events: SseEvent[] = [];
  let currentEvent: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) currentEvent = line.slice(7).trim();
    else if (line.startsWith("data: ")) {
      const data = line.slice(6);
      events.push(currentEvent !== undefined ? { event: currentEvent, data } : { data });
      currentEvent = undefined;
    } else if (line === "") currentEvent = undefined;
  }
  return events;
}

export async function isProxyReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${PROXY}/health`, { signal: AbortSignal.timeout(2000) });
    void res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Event-shape normaliser: strip non-deterministic fields (ids, timestamps,
 * token counts that vary across runs) so golden diffs highlight only
 * structural regressions.
 */
export function normaliseEvents(events: SseEvent[]): SseEvent[] {
  return events.map((ev) => {
    if (!ev.data.startsWith("{")) return ev;
    try {
      const obj = JSON.parse(ev.data);
      scrub(obj);
      return { ...ev, data: JSON.stringify(obj) };
    } catch {
      return ev;
    }
  });
}

const VOLATILE_KEYS = new Set([
  "id",
  "created",
  "created_at",
  "request_id",
  "system_fingerprint",
  "x_request_id",
]);

function scrub(v: unknown): void {
  if (v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const el of v) scrub(el);
    return;
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (VOLATILE_KEYS.has(k)) o[k] = `<${k}>`;
    else scrub(o[k]);
  }
}

export interface GoldenSnapshot {
  status: number;
  events: SseEvent[];
}

/**
 * Load or capture golden snapshot. If RAVEN_CAPTURE_GOLDENS=1, overwrites
 * the file. Otherwise, returns the stored snapshot so the test can diff.
 */
export async function goldenSSE(
  relPath: string,
  fn: () => Promise<Response>,
): Promise<{ stored: GoldenSnapshot | null; live: GoldenSnapshot }> {
  const fullPath = `${import.meta.dir}/__golden__/${relPath}`;
  const res = await fn();
  const events = normaliseEvents(await consumeSSE(res));
  const live: GoldenSnapshot = { status: res.status, events };

  let stored: GoldenSnapshot | null = null;
  const file = Bun.file(fullPath);
  if (await file.exists()) {
    try {
      stored = JSON.parse(await file.text()) as GoldenSnapshot;
    } catch {
      stored = null;
    }
  }

  if (process.env.RAVEN_CAPTURE_GOLDENS === "1") {
    await Bun.write(fullPath, JSON.stringify(live, null, 2) + "\n");
    stored = live;
  }

  return { stored, live };
}
