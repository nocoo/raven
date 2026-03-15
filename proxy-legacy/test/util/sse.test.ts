import { describe, expect, test } from "bun:test";
import { parseSSEStream, parseSSELine } from "../../src/util/sse.ts";

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
  });

  describe("parseSSEStream", () => {
    test("parses complete SSE chunks", async () => {
      const chunks = [
        "data: {\"id\":1}\n\n",
        "data: {\"id\":2}\n\n",
        "data: [DONE]\n\n",
      ];

      const events: string[] = [];
      let done = false;

      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      });

      for await (const event of parseSSEStream(stream)) {
        if (event === null) {
          done = true;
        } else {
          events.push(event);
        }
      }

      expect(events).toEqual(["{\"id\":1}", "{\"id\":2}"]);
      expect(done).toBe(true);
    });

    test("handles chunks split across boundaries", async () => {
      // Split "data: {\"id\":1}\n\ndata: {\"id\":2}\n\n" into odd chunks
      const fullData = "data: {\"id\":1}\n\ndata: {\"id\":2}\n\ndata: [DONE]\n\n";
      const chunks = [
        fullData.slice(0, 8),    // "data: {\"i"
        fullData.slice(8, 20),   // "d\":1}\n\ndata"
        fullData.slice(20),      // rest
      ];

      const events: string[] = [];
      let done = false;

      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      });

      for await (const event of parseSSEStream(stream)) {
        if (event === null) {
          done = true;
        } else {
          events.push(event);
        }
      }

      expect(events).toEqual(["{\"id\":1}", "{\"id\":2}"]);
      expect(done).toBe(true);
    });

    test("handles empty stream", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      const events: string[] = [];
      for await (const event of parseSSEStream(stream)) {
        if (event !== null) events.push(event);
      }

      expect(events).toEqual([]);
    });

    test("skips comment and event lines", async () => {
      const data = ": comment\nevent: msg\ndata: {\"real\":true}\n\ndata: [DONE]\n\n";

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(data));
          controller.close();
        },
      });

      const events: string[] = [];
      for await (const event of parseSSEStream(stream)) {
        if (event !== null) events.push(event);
      }

      expect(events).toEqual(["{\"real\":true}"]);
    });
  });
});
