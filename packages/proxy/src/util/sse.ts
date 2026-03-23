// ---------------------------------------------------------------------------
// Unified SSE (Server-Sent Events) parsing module.
//
// Provides two layers:
//   1. Low-level: parseSSELine / parseSSEStream — line-oriented parsing that
//      yields raw data strings. Used by benchmarks and simple consumers.
//   2. High-level: events(response) — converts a fetch Response into an
//      AsyncGenerator of full SSE event objects ({ data, event, id, retry }).
//      Drop-in replacement for the `fetch-event-stream` package.
//
// Both layers handle chunked boundaries correctly (data split across reads).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Low-level parsed line result. */
export interface SSEEvent {
  type: "data" | "event" | "done";
  value: string;
}

/**
 * High-level SSE event object, compatible with Hono's SSEMessage.
 * Yielded by {@link events} after aggregating all fields between blank lines.
 */
export interface ServerSentEvent {
  data: string;
  event: string | null;
  id: string | null;
  retry: number | null;
}

// ---------------------------------------------------------------------------
// Low-level: line parser
// ---------------------------------------------------------------------------

/**
 * Parse a single SSE line into an event.
 * Returns null for empty lines and comments.
 */
export function parseSSELine(line: string): SSEEvent | null {
  if (!line || line.startsWith(":")) {
    return null;
  }

  if (line.startsWith("data: [DONE]") || line === "data:[DONE]") {
    return { type: "done", value: "[DONE]" };
  }

  if (line.startsWith("data:")) {
    // "data: value" or "data:value"
    const value = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
    return { type: "data", value };
  }

  if (line.startsWith("event:")) {
    const value = line.startsWith("event: ") ? line.slice(7) : line.slice(6);
    return { type: "event", value };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Low-level: stream parser (yields raw data strings)
// ---------------------------------------------------------------------------

/**
 * Async generator that parses an SSE ReadableStream.
 * Yields JSON data strings for data events, null for [DONE].
 * Handles chunks split across boundaries.
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string | null> {
  const decoder = new TextDecoder();
  let buffer = "";

  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Process any remaining buffer
        if (buffer.trim()) {
          const event = parseSSELine(buffer.trim());
          if (event?.type === "data") {
            yield event.value;
          } else if (event?.type === "done") {
            yield null;
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Split on double newline (SSE event separator)
      const parts = buffer.split("\n\n");

      // Keep the last part as potential incomplete chunk
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const lines = part.split("\n");
        for (const line of lines) {
          const event = parseSSELine(line);
          if (event?.type === "data") {
            yield event.value;
          } else if (event?.type === "done") {
            yield null;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// High-level: events(response) — full SSE event objects
// ---------------------------------------------------------------------------

/**
 * Extract the field value from an SSE line.
 * Per spec: if a space follows the colon, it is stripped (exactly one).
 * Returns undefined for comment lines (field name is empty).
 */
function parseField(line: string): { field: string; value: string } | null {
  const colonIdx = line.indexOf(":");
  if (colonIdx === 0) return null; // comment line ": ..."
  if (colonIdx === -1) return { field: line, value: "" };
  const field = line.slice(0, colonIdx);
  let value = line.slice(colonIdx + 1);
  // Per SSE spec: "If value starts with a single U+0020 SPACE, remove it"
  if (value.startsWith(" ")) value = value.slice(1);
  return { field, value };
}

/**
 * Convert a fetch `Response` body into an async generator of SSE event objects.
 *
 * Drop-in replacement for `events()` from `fetch-event-stream`.
 * Compatible with Hono's `SSEMessage` interface — yielded objects can be
 * passed directly to `stream.writeSSE()`.
 *
 * @example
 * ```ts
 * const response = await fetch(url);
 * for await (const event of events(response)) {
 *   console.log(event.data);
 * }
 * ```
 */
export async function* events(
  response: Response,
): AsyncGenerator<ServerSentEvent> {
  if (!response.body) return;

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  // Accumulated fields for current event
  let data: string[] = [];
  let eventType: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  let hasFields = false;

  function buildEvent(): ServerSentEvent | null {
    if (!hasFields) return null;
    const event: ServerSentEvent = {
      data: data.join("\n"),
      event: eventType ?? null,
      id: id ?? null,
      retry: retry ?? null,
    };
    // Reset accumulators
    data = [];
    eventType = undefined;
    id = undefined;
    retry = undefined;
    hasFields = false;
    return event;
  }

  function processLine(line: string): ServerSentEvent | null {
    // Empty line = dispatch event
    if (line === "") {
      return buildEvent();
    }
    const parsed = parseField(line);
    if (!parsed) return null; // comment
    const { field, value } = parsed;
    switch (field) {
      case "data":
        hasFields = true;
        data.push(value);
        break;
      case "event":
        hasFields = true;
        eventType = value;
        break;
      case "id":
        hasFields = true;
        id = value;
        break;
      case "retry": {
        const n = Number.parseInt(value, 10);
        if (!Number.isNaN(n)) {
          hasFields = true;
          retry = n;
        }
        break;
      }
      // Unknown fields are ignored per spec
    }
    return null;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Process remaining buffer
        if (buffer) {
          const lines = buffer.split(/\r\n|\r|\n/);
          for (const line of lines) {
            const event = processLine(line);
            if (event) yield event;
          }
        }
        // Dispatch any pending event (fields accumulated but no trailing blank line)
        const event = buildEvent();
        if (event) yield event;
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Split on newlines (CR, LF, or CRLF)
      const lines = buffer.split(/\r\n|\r|\n/);

      // Last element may be incomplete — keep it in buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const event = processLine(line);
        if (event) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
