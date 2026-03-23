import { describe, expect, test } from "bun:test";
import { parseSSEStream, parseSSELine, events, type ServerSentEvent } from "../../src/util/sse.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ReadableStream from string chunks. */
function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Build a minimal Response wrapping string chunks. */
function responseFrom(chunks: string[]): Response {
  return new Response(streamFrom(chunks), {
    headers: { "content-type": "text/event-stream" },
  });
}

// ===========================================================================
// Low-level: parseSSELine
// ===========================================================================

describe("SSE Parser", () => {
  describe("parseSSELine", () => {
    test("parses data line", () => {
      const result = parseSSELine("data: {\"hello\":\"world\"}");
      expect(result).toEqual({ type: "data", value: "{\"hello\":\"world\"}" });
    });

    test("parses [DONE] marker", () => {
      const result = parseSSELine("data: [DONE]");
      expect(result).toEqual({ type: "done", value: "[DONE]" });
    });

    test("returns null for empty line", () => {
      expect(parseSSELine("")).toBeNull();
    });

    test("returns null for comment line", () => {
      expect(parseSSELine(": comment")).toBeNull();
    });

    test("returns null for event line", () => {
      const result = parseSSELine("event: message");
      expect(result).toEqual({ type: "event", value: "message" });
    });

    test("handles data with leading space", () => {
      const result = parseSSELine("data:  extra space");
      expect(result).toEqual({ type: "data", value: " extra space" });
    });

    test("handles data with no space after colon", () => {
      const result = parseSSELine("data:{\"no\":\"space\"}");
      expect(result).toEqual({ type: "data", value: "{\"no\":\"space\"}" });
    });

    test("parses event line without space after colon", () => {
      const result = parseSSELine("event:delta");
      expect(result).toEqual({ type: "event", value: "delta" });
    });

    test("[DONE] without space after colon", () => {
      const result = parseSSELine("data:[DONE]");
      expect(result).toEqual({ type: "done", value: "[DONE]" });
    });

    test("returns null for unknown field (no colon prefix)", () => {
      expect(parseSSELine("random text")).toBeNull();
    });
  });

  // ===========================================================================
  // Low-level: parseSSEStream
  // ===========================================================================

  describe("parseSSEStream", () => {
    test("parses complete SSE chunks", async () => {
      const chunks = [
        "data: {\"id\":1}\n\n",
        "data: {\"id\":2}\n\n",
        "data: [DONE]\n\n",
      ];

      const results: string[] = [];
      let done = false;

      for await (const event of parseSSEStream(streamFrom(chunks))) {
        if (event === null) {
          done = true;
        } else {
          results.push(event);
        }
      }

      expect(results).toEqual(["{\"id\":1}", "{\"id\":2}"]);
      expect(done).toBe(true);
    });

    test("handles chunks split across boundaries", async () => {
      const fullData = "data: {\"id\":1}\n\ndata: {\"id\":2}\n\ndata: [DONE]\n\n";
      const chunks = [
        fullData.slice(0, 8),    // "data: {\"i"
        fullData.slice(8, 20),   // "d\":1}\n\ndata"
        fullData.slice(20),      // rest
      ];

      const results: string[] = [];
      let done = false;

      for await (const event of parseSSEStream(streamFrom(chunks))) {
        if (event === null) {
          done = true;
        } else {
          results.push(event);
        }
      }

      expect(results).toEqual(["{\"id\":1}", "{\"id\":2}"]);
      expect(done).toBe(true);
    });

    test("handles empty stream", async () => {
      const results: string[] = [];
      for await (const event of parseSSEStream(streamFrom([]))) {
        if (event !== null) results.push(event);
      }

      expect(results).toEqual([]);
    });

    test("flushes remaining buffer data when stream ends without trailing newline", async () => {
      // Stream ends with data still in buffer (no \n\n terminator)
      const chunks = [
        "data: {\"id\":1}\n\ndata: {\"id\":2}",
      ];

      const results: string[] = [];
      for await (const event of parseSSEStream(streamFrom(chunks))) {
        if (event !== null) results.push(event);
      }

      expect(results).toEqual(["{\"id\":1}", "{\"id\":2}"]);
    });

    test("flushes [DONE] in buffer at stream end", async () => {
      // Stream ends with [DONE] in buffer, no trailing \n\n
      const chunks = ["data: {\"id\":1}\n\ndata: [DONE]"];

      const results: (string | null)[] = [];
      for await (const event of parseSSEStream(streamFrom(chunks))) {
        results.push(event);
      }

      expect(results).toEqual(["{\"id\":1}", null]);
    });

    test("skips comment and event lines", async () => {
      const data = ": comment\nevent: msg\ndata: {\"real\":true}\n\ndata: [DONE]\n\n";

      const results: string[] = [];
      for await (const event of parseSSEStream(streamFrom([data]))) {
        if (event !== null) results.push(event);
      }

      expect(results).toEqual(["{\"real\":true}"]);
    });
  });

  // ===========================================================================
  // High-level: events(response)
  // ===========================================================================

  describe("events", () => {
    test("yields data-only events", async () => {
      const res = responseFrom([
        "data: {\"id\":1}\n\n",
        "data: {\"id\":2}\n\n",
      ]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "{\"id\":1}", event: null, id: null, retry: null },
        { data: "{\"id\":2}", event: null, id: null, retry: null },
      ]);
    });

    test("yields events with event type", async () => {
      const res = responseFrom([
        "event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
        "event: content_block_delta\ndata: {\"delta\":\"hi\"}\n\n",
      ]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "{\"type\":\"message_start\"}", event: "message_start", id: null, retry: null },
        { data: "{\"delta\":\"hi\"}", event: "content_block_delta", id: null, retry: null },
      ]);
    });

    test("yields events with id field", async () => {
      const res = responseFrom(["id: 42\ndata: hello\n\n"]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "hello", event: null, id: "42", retry: null },
      ]);
    });

    test("yields events with retry field", async () => {
      const res = responseFrom(["retry: 5000\ndata: reconnect\n\n"]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "reconnect", event: null, id: null, retry: 5000 },
      ]);
    });

    test("ignores invalid retry values", async () => {
      const res = responseFrom(["retry: abc\ndata: ok\n\n"]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([{ data: "ok", event: null, id: null, retry: null }]);
    });

    test("concatenates multiple data lines with newlines", async () => {
      const res = responseFrom([
        "data: line1\ndata: line2\ndata: line3\n\n",
      ]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "line1\nline2\nline3", event: null, id: null, retry: null },
      ]);
    });

    test("skips comment lines", async () => {
      const res = responseFrom([
        ": this is a comment\ndata: real data\n\n",
      ]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "real data", event: null, id: null, retry: null },
      ]);
    });

    test("skips empty events (blank line with no preceding fields)", async () => {
      const res = responseFrom([
        "\n\ndata: after blanks\n\n",
      ]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "after blanks", event: null, id: null, retry: null },
      ]);
    });

    test("handles chunks split across boundaries", async () => {
      const full = "event: delta\ndata: {\"id\":1}\n\nevent: delta\ndata: {\"id\":2}\n\n";
      const res = responseFrom([
        full.slice(0, 10),    // "event: del"
        full.slice(10, 30),   // "ta\ndata: {\"id\":1}\n"
        full.slice(30),       // rest
      ]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "{\"id\":1}", event: "delta", id: null, retry: null },
        { data: "{\"id\":2}", event: "delta", id: null, retry: null },
      ]);
    });

    test("handles CRLF line endings", async () => {
      const res = responseFrom([
        "data: crlf\r\n\r\n",
      ]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "crlf", event: null, id: null, retry: null },
      ]);
    });

    test("handles CR-only line endings", async () => {
      const res = responseFrom([
        "data: cr\r\r",
      ]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "cr", event: null, id: null, retry: null },
      ]);
    });

    test("handles empty response body", async () => {
      const res = responseFrom([]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([]);
    });

    test("handles null response body", async () => {
      const res = new Response(null);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([]);
    });

    test("dispatches pending event at stream end", async () => {
      // Stream ends without trailing blank line
      const res = responseFrom(["data: last\n"]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "last", event: null, id: null, retry: null },
      ]);
    });

    test("flushes buffer with multiple lines at stream end", async () => {
      // Stream ends with buffer containing unparsed lines (no trailing blank)
      const res = responseFrom(["event: delta\ndata: tail"]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "tail", event: "delta", id: null, retry: null },
      ]);
    });

    test("handles OpenAI-style [DONE] as regular data", async () => {
      // events() is protocol-level — it yields raw SSE events.
      // [DONE] is application-level convention, not SSE spec.
      // The consumer decides how to handle it.
      const res = responseFrom([
        "data: {\"id\":1}\n\n",
        "data: [DONE]\n\n",
      ]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "{\"id\":1}", event: null, id: null, retry: null },
        { data: "[DONE]", event: null, id: null, retry: null },
      ]);
    });

    test("handles data with no space after colon (SSE spec)", async () => {
      const res = responseFrom(["data:{\"compact\":true}\n\n"]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toEqual([
        { data: "{\"compact\":true}", event: null, id: null, retry: null },
      ]);
    });

    test("works with Hono SSEMessage shape (data + event)", async () => {
      // Verify the yielded object is compatible with Hono's writeSSE
      const res = responseFrom([
        "event: chunk\ndata: hello\n\n",
      ]);

      for await (const event of events(res)) {
        // These are the fields Hono SSEMessage expects
        expect(typeof event.data).toBe("string");
        expect(event.event).toBe("chunk");
        expect(event).toHaveProperty("data");
      }
    });

    test("realistic OpenAI streaming sequence", async () => {
      const res = responseFrom([
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":" world"},"index":0}]}\n\n',
        "data: [DONE]\n\n",
      ]);

      const result: ServerSentEvent[] = [];
      for await (const event of events(res)) {
        result.push(event);
      }

      expect(result).toHaveLength(4);
      expect(JSON.parse(result[0]!.data).choices[0]!.delta.role).toBe("assistant");
      expect(JSON.parse(result[1]!.data).choices[0]!.delta.content).toBe("Hello");
      expect(JSON.parse(result[2]!.data).choices[0]!.delta.content).toBe(" world");
      expect(result[3]!.data).toBe("[DONE]");
    });
  });
});
