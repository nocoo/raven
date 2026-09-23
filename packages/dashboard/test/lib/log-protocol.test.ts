import { describe, expect, it } from "vitest";
import { logProtocol } from "@/lib/log-protocol";

describe("live log protocol classification", () => {
  for (const format of ["anthropic", "openai", "responses"]) {
    for (const upstreamFormat of ["anthropic", "openai", "responses"]) {
      it(`${format} → ${upstreamFormat} uses the actual protocol pair`, () => {
        const result = logProtocol({ format, upstreamFormat }, true);
        expect(result.label).toBe(format === upstreamFormat ? "Native" : "Translated");
        expect(result.variant).toBe(format === upstreamFormat ? "success" : "warning");
        expect(result.title).toContain(format === upstreamFormat ? "No protocol translation" : "Prefer");
      });
    }
  }

  it("marks Codex Responses requests native without relying on model or strategy names", () => {
    expect(logProtocol({ format: "responses", upstreamFormat: "responses", model: "gpt-5.6-sol", strategy: "copilot-responses" }, true))
      .toEqual({ label: "Native", variant: "success", title: "Responses → Responses · No protocol translation" });
  });

  it.each([{}, { format: "responses" }, { format: "invalid", upstreamFormat: "responses" }, { format: "openai", upstreamFormat: "toString" }])("does not guess when protocol evidence is missing: %j", data => {
    expect(logProtocol(data, false).label).toBe("Pending path");
    expect(logProtocol(data, true).label).toBe("Unknown path");
  });
});
