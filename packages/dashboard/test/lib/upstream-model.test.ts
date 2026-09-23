import { describe, expect, it } from "vitest";
import { effectiveReset, quotaDraft, quotaPayload, upstreamDraft, upstreamPayload } from "@/lib/upstream-model";
import { FIXTURE_NOW, fixtureQuota, makeCopilot, makeUpstream } from "../helpers/routing-fixtures";

describe("upstream configuration", () => {
  it("starts with one native format, no quota and an empty secret", () => {
    expect(upstreamDraft(null, -480, FIXTURE_NOW)).toMatchObject({ format: "chat_completions", api_key: "", is_enabled: true, auth_style: null, use_socks5: null, quota: { enabled: false, window: "300" } });
  });
  it("never echoes the saved secret and omits empty replacement keys", () => {
    const upstream = makeUpstream({ manual_models: ["a", "b"] });
    const draft = upstreamDraft(upstream, 0, FIXTURE_NOW);
    expect(draft.api_key).toBe("");
    expect(draft.manual).toBe("a\nb");
    expect(upstreamPayload(draft, upstream, 0)).not.toHaveProperty("api_key");
    expect(upstreamPayload({ ...draft, api_key: " new-fixture-value " }, upstream, 0)).toMatchObject({ api_key: "new-fixture-value" });
  });
  it("saves raw manual IDs independently from fetched models and has no pattern fields", () => {
    const draft = { ...upstreamDraft(null, 0, FIXTURE_NOW), name: " Local ", base_url: "https://fixture.invalid/v1/", api_key: "fixture", manual: "Raw/Model, Raw/Model\nraw/model\n  " };
    expect(upstreamPayload(draft, null, 0)).toMatchObject({ name: "Local", base_url: "https://fixture.invalid/v1", manual_models: ["Raw/Model", "raw/model"], format: "chat_completions", quota: null });
    expect(upstreamPayload(draft, null, 0)).not.toHaveProperty("models");
    expect(upstreamPayload(draft, null, 0)).not.toHaveProperty("model_patterns");
  });
  it("restricts Copilot edits to manual catalog and shared quota", () => {
    const copilot = makeCopilot();
    const draft = { ...upstreamDraft(copilot, 0, FIXTURE_NOW), name: "must not send", base_url: "must not send", api_key: "must not send", is_enabled: false, manual: "manual-copilot" };
    expect(upstreamPayload(draft, copilot, 0)).toEqual({ manual_models: ["manual-copilot"], quota: null });
  });
  it("rejects missing required fields and reserved IDs before transport", () => {
    const draft = upstreamDraft(null, 0, FIXTURE_NOW);
    expect(() => upstreamPayload(draft, null, 0)).toThrow("name");
    expect(() => upstreamPayload({ ...draft, name: "x" }, null, 0)).toThrow("absolute");
    expect(() => upstreamPayload({ ...draft, name: "x", base_url: "https://fixture.invalid" }, null, 0)).toThrow("API key");
    expect(() => upstreamPayload({ ...draft, manual: "auto" }, makeCopilot(), 0)).toThrow("reserved");
  });
  it.each(["ftp://fixture.invalid", "https://user:pass@fixture.invalid", "https://fixture.invalid?q=1", "https://fixture.invalid/#part"])("rejects unsafe or ambiguous base URL %s", base_url => {
    const draft = { ...upstreamDraft(makeUpstream(), 0, FIXTURE_NOW), base_url };
    expect(() => upstreamPayload(draft, makeUpstream(), 0)).toThrow("without credentials");
  });
});

describe("shared quota editor", () => {
  it("defaults to a five-hour window and uses local reset inputs", () => {
    const draft = quotaDraft(null, -345, FIXTURE_NOW);
    expect(draft).toMatchObject({ enabled: false, limit: "100000", window: "300", reset: "2026-09-22T18:45", mode: "all_day", windows: [] });
    expect(quotaPayload(draft, -345)).toBeNull();
  });
  it("preserves reset calibration, fractional multipliers, and logical overnight identity", () => {
    const policy = { ...fixtureQuota, mode: "daily" as const, multipliers: [{ id: "discount", start_minute: 1320, end_minute: 1440, multiplier: 0.25 }, { id: "discount", start_minute: 0, end_minute: 90, multiplier: 0.25 }] };
    const draft = quotaDraft(policy, -345, FIXTURE_NOW);
    const result = quotaPayload(draft, -345);
    expect(result).toMatchObject({ limit_tokens: policy.limit_tokens, window_minutes: 300, next_reset_at: policy.next_reset_at });
    expect(result?.multipliers).toEqual([policy.multipliers[1], policy.multipliers[0]]);
    expect(result).not.toHaveProperty("used_tokens");
  });
  it.each(["daily", "weekly"] as const)("keeps only non-default multipliers in a %s schedule", mode => {
    const policy = { ...fixtureQuota, mode, multipliers: [
      { id: "baseline", start_minute: 0, end_minute: 60, multiplier: 1 },
      { id: "peak", start_minute: 60, end_minute: 120, multiplier: 2 },
      { id: "discount", start_minute: 120, end_minute: 180, multiplier: 0.5 },
    ] };
    const draft = quotaDraft(policy, -345, FIXTURE_NOW);
    expect(draft.windows.map(window => window.value)).toEqual([2, 0.5]);
    expect(quotaPayload(draft, -345)?.multipliers).toEqual(policy.multipliers.slice(1));
    draft.windows[0]!.value = 1;
    expect(quotaPayload(draft, -345)?.multipliers).toEqual([policy.multipliers[2]]);
    draft.windows[1]!.value = 1;
    expect(quotaPayload(draft, -345)).toMatchObject({ mode, multipliers: [], limit_tokens: policy.limit_tokens, next_reset_at: policy.next_reset_at });
  });
  it.each(["0", "-1", "Infinity", "1.25", ""])("rejects invalid allowance %s", limit => {
    expect(() => quotaPayload({ ...quotaDraft(fixtureQuota, 0, FIXTURE_NOW), limit }, 0)).toThrow("allowance");
  });
  it.each(["0", "-5", "1.5"])("rejects invalid duration %s", window => {
    expect(() => quotaPayload({ ...quotaDraft(fixtureQuota, 0, FIXTURE_NOW), window }, 0)).toThrow("Window length");
  });
  it("rejects invalid reset dates and nonpositive multipliers", () => {
    const draft = quotaDraft(fixtureQuota, 0, FIXTURE_NOW);
    expect(() => quotaPayload({ ...draft, reset: "invalid" }, 0)).toThrow("reset");
    for (const value of [0, -1, Number.NaN]) expect(() => quotaPayload({ ...draft, mode: "daily", windows: [{ id: "bad", day: 0, start: 0, end: 30, value }] }, 0)).toThrow("greater than zero");
  });
  it("previews an edited reset without pretending to clear charged usage", () => {
    expect(effectiveReset(FIXTURE_NOW + 1000, 300, FIXTURE_NOW)).toBe(FIXTURE_NOW + 1000);
    expect(effectiveReset(FIXTURE_NOW, 300, FIXTURE_NOW)).toBe(FIXTURE_NOW + 300 * 60_000);
    expect(effectiveReset(FIXTURE_NOW - 601 * 60_000, 300, FIXTURE_NOW)).toBe(FIXTURE_NOW + 299 * 60_000);
  });
});
