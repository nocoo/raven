// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

import { JsonBlock, tokenizeJson } from "@/components/requests/json-block";

describe("tokenizeJson", () => {
  it("marks quoted strings followed by colon as keys, the rest as values", () => {
    const tokens = tokenizeJson('{"name":"raven"}');
    const kinds = tokens.map((t) => t.kind);
    // expected sequence: punct({) key("name") punct(:) string("raven") punct(})
    expect(kinds).toEqual(["punct", "key", "punct", "string", "punct"]);
    expect(tokens[1]?.text).toBe('"name"');
    expect(tokens[3]?.text).toBe('"raven"');
  });

  it("classifies numbers, booleans, and null", () => {
    const tokens = tokenizeJson('{"a":42,"b":true,"c":null,"d":-3.14e2}');
    const byKind = tokens.filter((t) => t.kind !== "whitespace" && t.kind !== "punct");
    const kinds = byKind.map((t) => `${t.kind}:${t.text}`);
    expect(kinds).toContain("number:42");
    expect(kinds).toContain("boolean:true");
    expect(kinds).toContain("null:null");
    expect(kinds).toContain("number:-3.14e2");
  });

  it("does not throw on malformed input", () => {
    expect(() => tokenizeJson('{"oops": "no closing brace')).not.toThrow();
    expect(() => tokenizeJson("")).not.toThrow();
  });

  it("treats keys that contain escaped quotes correctly", () => {
    const tokens = tokenizeJson('{"a\\"b":1}');
    const key = tokens.find((t) => t.kind === "key");
    expect(key?.text).toBe('"a\\"b"');
  });
});

describe("JsonBlock", () => {
  it("pretty-prints valid JSON in the rendered output", () => {
    render(<JsonBlock value='{"a":1,"b":2}' />);
    // pretty-printed form puts each key on its own line with a 2-space indent
    const codeEl = document.querySelector("pre code");
    expect(codeEl?.textContent).toContain('"a"');
    expect(codeEl?.textContent).toContain('"b"');
    expect(codeEl?.textContent?.includes("\n  ")).toBe(true);
  });

  it("falls back to raw text when JSON parse fails", () => {
    render(<JsonBlock value="not json at all" />);
    const codeEl = document.querySelector("pre code");
    expect(codeEl?.textContent).toBe("not json at all");
  });

  it("copies pretty-printed JSON when the copy button is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<JsonBlock value='{"x":1}' />);
    await userEvent.click(screen.getByRole("button", { name: /copy json/i }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toBe('{\n  "x": 1\n}');
  });
});
