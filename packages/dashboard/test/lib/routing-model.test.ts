import { describe, expect, it } from "vitest";
import { compatibility, COPILOT_UPSTREAM_ID, dragState, FORMATS, IDLE_DRAG, modelIds, moveItem, newRule, previewChain, ruleDraft, rulePayload, validateChain } from "@/lib/routing-model";
import { makeCopilot, makeRule, makeUpstream } from "../helpers/routing-fixtures";
import type { CatalogModel } from "@/lib/routing-types";

const copilot = makeCopilot();
const custom = makeUpstream();
const upstreams = [copilot, custom];
const target = { upstream_id: COPILOT_UPSTREAM_ID, model: "gpt-5.6-sol" };

describe("rule payloads", () => {
  it("creates an explicit terminal target with conversion disabled", () => {
    expect(newRule()).toMatchObject({ allow_conversion: false, mode: "all_day", default_chain: [target], windows: [] });
  });
  it("loads shared DTOs without mutating chains and serializes normalized UTC", () => {
    const rule = makeRule({ mode: "daily", periods: [{ id: "night", start_minute: 1380, end_minute: 1440, targets: [target] }, { id: "night", start_minute: 0, end_minute: 60, targets: [target] }] });
    const draft = ruleDraft(rule, 0);
    draft.name = "  My rule  ";
    draft.default_chain[0]!.model = "  raw.model  ";
    draft.windows[0]!.value[0]!.model = "custom.model";
    const payload = rulePayload(draft, upstreams, 0);
    expect(payload.name).toBe("My rule");
    expect(payload.default_chain[0]?.model).toBe("raw.model");
    expect(payload.periods.map(period => period.targets[0]?.model)).toEqual(["custom.model", "custom.model"]);
    expect(rule.default_chain).toEqual([target]);
  });
  it("validates all chains and never saves a reserved auto target or a missing upstream", () => {
    expect(() => rulePayload(newRule(), upstreams, 0)).toThrow("name");
    expect(() => validateChain([], upstreams)).toThrow("terminal fallback");
    expect(() => validateChain([{ ...target, model: "auto" }], upstreams)).toThrow("reserved");
    expect(() => validateChain([{ ...target, model: " " }], upstreams)).toThrow("explicit");
    expect(() => validateChain([{ ...target, upstream_id: "gone" }], upstreams)).toThrow("missing upstream");
    expect(() => validateChain([{ ...target, model: "AUTO" }], upstreams)).not.toThrow();
    const draft = { ...newRule(), name: "valid", mode: "daily" as const, windows: [{ id: "empty", day: 0, start: 0, end: 30, value: [] }] };
    expect(() => rulePayload(draft, upstreams, 0)).toThrow("terminal fallback");
  });
  it("unions fetched/manual IDs exactly without inventing catalog membership", () => {
    expect(modelIds(undefined)).toEqual([]);
    expect(modelIds(makeUpstream({ models: [{ id: "auto" }, { id: "A" }, { id: "a" }], manual_models: ["A", "manual", "auto"] }))).toEqual(["A", "a", "manual"]);
  });
});

describe("target drag state", () => {
  it("moves a quota candidate into the terminal position, preserving model/upstream pairing", () => {
    const original = [target, { upstream_id: custom.id, model: "manual-id" }];
    const result = moveItem(original, 0, 1);
    expect(result).toEqual([original[1], target]);
    expect(original[0]).toBe(target);
    expect(moveItem(original, 1, 0)).toEqual([original[1], target]);
  });
  it.each([[-1, 0], [0, 2], [0.5, 1], [1, 1]])("ignores invalid or unchanged move %i → %i", (from, to) => {
    const original = [target, target];
    expect(moveItem(original, from, to)).toBe(original);
  });
  it("starts only within the chain and clears cancelled/completed drags", () => {
    expect(dragState(IDLE_DRAG, { type: "over", index: 1 }, 2)).toBe(IDLE_DRAG);
    const started = dragState(IDLE_DRAG, { type: "start", index: 0 }, 2);
    expect(started).toEqual({ source: 0, over: 0 });
    expect(dragState(started, { type: "over", index: 1 }, 2)).toEqual({ source: 0, over: 1 });
    expect(dragState(started, { type: "over", index: 8 }, 2)).toBe(started);
    expect(dragState(started, { type: "end" }, 2)).toBe(IDLE_DRAG);
  });
});

describe("protocol compatibility preview", () => {
  it.each(FORMATS)("respects the single custom $short format and the conversion switch", format => {
    const upstream = makeUpstream({ format: format.value });
    for (const incoming of FORMATS) {
      expect(compatibility(upstream, "unlisted", incoming.value, false)).toBe(incoming.value === format.value ? "Native" : "Blocked");
      expect(compatibility(upstream, "unlisted", incoming.value, true)).toBe(incoming.value === format.value ? "Native" : "Convert");
    }
  });
  it("uses usable cached Copilot endpoint declarations including v1 paths", () => {
    expect(compatibility(copilot, "gpt-5.6-sol", "responses", false)).toBe("Native");
    expect(compatibility(copilot, "gpt-5.6-sol", "anthropic_messages", false)).toBe("Blocked");
    expect(compatibility(copilot, "gpt-5.6-sol", "anthropic_messages", true)).toBe("Convert");
    const versioned = makeCopilot({ models: [{ id: "v1", supported_endpoints: ["/v1/chat/completions", "/v1/responses"] }] });
    expect(compatibility(versioned, "v1", "chat_completions", false)).toBe("Native");
    expect(compatibility(versioned, "v1", "responses", false)).toBe("Native");
  });
  it.each([[], [{ id: "unknown" }], [{ id: "unknown", supported_endpoints: ["/weird", 17] }], [{ id: "unknown", supported_endpoints: "bad" }]].map(models => ({ models })))("keeps auto unavailable without capabilities: $models", ({ models }) => {
    const upstream = makeCopilot({ models: models as unknown as CatalogModel[] });
    expect(compatibility(upstream, "unknown", "responses", true)).toBe("Unavailable");
    expect(compatibility(upstream, "unknown", "anthropic_messages", true, false)).toBe("Convert");
    expect(compatibility(upstream, "unknown", "anthropic_messages", false, false)).toBe("Native");
    expect(compatibility(upstream, "unknown", "responses", true, false)).toBe("Native");
  });
  it("does not invent a protocol for a missing upstream", () => {
    expect(compatibility(undefined, "model", "responses", true)).toBe("Unavailable");
  });
});

describe("cached reachability preview", () => {
  const chain = [{ upstream_id: custom.id, model: "a" }, target];
  it("skips exhausted quotas and resumes the first candidate after reset", () => {
    const exhausted = makeUpstream({ quota_status: { ...custom.quota_status, remaining_tokens: 0 } });
    expect(previewChain(chain, [exhausted, copilot]).selected).toBe(1);
    expect(previewChain(chain, upstreams).selected).toBe(0);
    expect(previewChain(chain, [exhausted, copilot]).labels[0]).toBe("Exhausted · skip");
  });
  it("flags unbounded candidates and never skips a disabled or broken accounting target", () => {
    const unbounded = makeUpstream({ quota: null });
    expect(previewChain(chain, [unbounded, copilot]).warnings[0]).toContain("unreachable");
    expect(previewChain(chain, [makeUpstream({ is_enabled: false }), copilot])).toMatchObject({ selected: null, labels: ["Disabled · request stops", "Later target"] });
    expect(previewChain(chain, [makeUpstream({ quota_status: { ...custom.quota_status, healthy: false } }), copilot]).labels[0]).toBe("Accounting blocked");
    expect(previewChain(chain, [makeUpstream({ quota: null, quota_status: { ...custom.quota_status, healthy: false } }), copilot]).selected).toBe(0);
  });
  it("reports absent snapshots, missing targets and a fully exhausted chain", () => {
    expect(previewChain(chain, [copilot]).labels[0]).toBe("Missing upstream");
    expect(previewChain(chain, [makeUpstream({ quota_status: { ...custom.quota_status, remaining_tokens: null } }), copilot]).labels[0]).toBe("Quota state unavailable");
    expect(previewChain([chain[0]!], [makeUpstream({ quota_status: { ...custom.quota_status, remaining_tokens: 0 } })]).warnings[0]).toContain("429");
    expect(previewChain([], []).warnings).toEqual([]);
  });
});
