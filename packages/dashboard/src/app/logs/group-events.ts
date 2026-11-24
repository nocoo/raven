import type { LogEvent } from "@/hooks/use-log-stream";

export interface EventGroup {
  key: string;
  events: LogEvent[];
}

/**
 * Group events by requestId. System events (no requestId) are standalone.
 *
 * Group keys must be stable across renders — the DOM-anchor scroll
 * compensator in logs-content looks up the same key on the next commit
 * to recompute the user's viewport offset. Non-deterministic keys
 * (`Math.random()`, `Date.now()` reads during render) also break
 * React's reconciliation.
 */
export function groupEvents(events: LogEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  const requestMap = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;
    if (!event.requestId) {
      // System events have no requestId. `_seq` (client-assigned by
      // useLogStream) is the stable id — falls back to `ts-i` only in
      // tests / synthetic streams that construct LogEvents by hand.
      const seq = event._seq ?? `${event.ts}-${i}`;
      groups.push({ key: `sys-${seq}`, events: [event] });
    } else {
      const existing = requestMap.get(event.requestId);
      const existingGroup = existing !== undefined ? groups[existing] : undefined;
      if (existingGroup) {
        existingGroup.events.push(event);
      } else {
        requestMap.set(event.requestId, groups.length);
        groups.push({ key: event.requestId, events: [event] });
      }
    }
  }

  // Newest first — reverse so latest groups appear at the top
  return groups.reverse();
}
