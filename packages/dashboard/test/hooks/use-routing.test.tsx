// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { useRoutingRules } from "@/hooks/use-routing-rules";
import { useUpstreams } from "@/hooks/use-upstreams";
import { fixtureRules, fixtureUpstreams, FIXTURE_NOW, makeCopilot, makeDiagnostic, makeRule, makeUpstream } from "../helpers/routing-fixtures";
import { errorMessage, type RoutingFeedback } from "@/lib/routing-client";

let fetchSpy: MockInstance<typeof fetch>;
let offsetSpy: MockInstance<() => number>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
  offsetSpy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
});
afterEach(() => vi.restoreAllMocks());
const message = (feedback: RoutingFeedback | null) => feedback?.kind === "error" ? errorMessage(feedback.cause) : "";

describe("upstream operation guards", () => {
  it.each(["refresh", "reload", "test"] as const)("blocks %s for an unsaved or dirty configuration without network traffic", async operation => {
    const { result } = renderHook(() => useUpstreams([], 0, FIXTURE_NOW));
    await act(() => result.current[operation]());
    expect(message(result.current.feedback)).toContain("Save or discard");
    expect(fetchSpy).not.toHaveBeenCalled();
    act(() => result.current.load(makeUpstream()));
    act(() => result.current.change({ ...result.current.draft, name: "Dirty" }));
    await act(() => result.current[operation]());
    expect(result.current.dirty).toBe(true);
    expect(message(result.current.feedback)).toContain("Save or discard");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["", "  auto  "])("rejects invalid diagnostic model %j before sending a request", async model => {
    const { result } = renderHook(() => useUpstreams([makeUpstream({ models: [], manual_models: [] })], 0, FIXTURE_NOW));
    act(() => result.current.setTestModel(model));
    await act(() => result.current.test());
    expect(message(result.current.feedback)).toContain("explicit model ID");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("locks concurrent actions synchronously until the single diagnostic finishes", async () => {
    let finish!: (response: Response) => void;
    fetchSpy.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useUpstreams([makeUpstream()], 0, FIXTURE_NOW));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.test();
      void result.current.test();
      void result.current.refresh();
      void result.current.remove();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe("test");
    const diagnostic = makeDiagnostic();
    await act(async () => { finish(Response.json(diagnostic)); await pending; });
    expect(result.current.feedback).toEqual({ kind: "diagnostic", result: diagnostic, action: "test" });
    expect(result.current.busy).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not delete Copilot or a new draft even through the view-model action", async () => {
    const { result } = renderHook(() => useUpstreams([makeCopilot()], 0, FIXTURE_NOW));
    await act(() => result.current.remove());
    act(() => result.current.load(null));
    await act(() => result.current.remove());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retains a valid draft after the browser timezone offset changes", async () => {
    const { result } = renderHook(() => useUpstreams([makeUpstream()], 0, FIXTURE_NOW));
    act(() => result.current.change({ ...result.current.draft, name: "Keep local time" }));
    offsetSpy.mockReturnValue(-60);
    await act(() => result.current.save());
    expect(message(result.current.feedback)).toContain("timezone offset changed");
    expect(result.current.draft.name).toBe("Keep local time");
    expect(result.current.dirty).toBe(true);
    expect(result.current.busy).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("routing rule operation guards", () => {
  it("serializes a save and a conflicting delete even before React can render busy state", async () => {
    let finish!: (response: Response) => void;
    fetchSpy.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const initial = makeRule({ id: "custom:rule", is_builtin: false });
    const { result } = renderHook(() => useRoutingRules([initial], fixtureUpstreams, 0));
    act(() => result.current.change({ ...result.current.draft, name: "Pending rule" }));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.save();
      void result.current.save();
      void result.current.remove();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);
    await act(async () => { finish(Response.json({ ...initial, name: "Pending rule" })); await pending; });
    expect(result.current.dirty).toBe(false);
    expect(result.current.feedback).toEqual({ kind: "success", message: "Rule saved. New requests will use this configuration." });
  });

  it("keeps protected built-in and new rules intact when delete is invoked", async () => {
    const { result } = renderHook(() => useRoutingRules(fixtureRules, fixtureUpstreams, 0));
    await act(() => result.current.remove());
    act(() => result.current.load(null));
    await act(() => result.current.remove());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks a duplicate delete and restores an editable new draft after deleting the final rule", async () => {
    let finish!: (response: Response) => void;
    fetchSpy.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useRoutingRules([fixtureRules[1]!], fixtureUpstreams, 0));
    let pending!: Promise<void>;
    act(() => { pending = result.current.remove(); void result.current.remove(); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await act(async () => { finish(Response.json({ success: true })); await pending; });
    expect(result.current.active).toBeNull();
    expect(result.current.rules).toEqual([]);
    expect(result.current.draft.name).toBe("");
    expect(result.current.busy).toBe(false);
  });
});
