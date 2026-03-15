export interface SSEEvent {
  type: "data" | "event" | "done";
  value: string;
}

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
