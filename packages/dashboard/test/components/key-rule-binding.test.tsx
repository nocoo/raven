// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { KeyRuleBinding } from "@/app/connect/key-rule-binding";
import type { ApiKeyPublic } from "@/lib/types";
import { fixtureRules } from "../helpers/routing-fixtures";
import { selectOption } from "../helpers/routing-interactions";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const key: ApiKeyPublic = { id: "key:laptop/1", name: "Work laptop", rule_id: "builtin:copilot", key_prefix: "rk-fixture", created_at: 0, last_used_at: null, revoked_at: null };
let fetchSpy: MockInstance<typeof fetch>;
beforeEach(() => {
  refresh.mockClear();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
});
afterEach(() => vi.restoreAllMocks());
const user = () => userEvent.setup({ delay: null });
const open = () => user().click(screen.getByRole("button", { name: "Change rule for Work laptop" }));

describe("key rule binding", () => {
  it("shows the bound rule, requires a change and patches only rule_id without rotating the key", async () => {
    let finish!: (response: Response) => void;
    render(<KeyRuleBinding apiKey={key} rules={fixtureRules} />);
    expect(screen.getByText("GitHub Copilot")).toBeVisible();
    await open();
    expect(screen.getByText(/secret stays unchanged/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save binding" })).toBeDisabled();
    await selectOption("Routing rule", "Working hours");
    fetchSpy.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    await user().click(screen.getByRole("button", { name: "Save binding" }));
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith("/api/keys/key%3Alaptop%2F1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rule_id: "rule:working-hours" }) });
    expect(screen.getByRole("combobox", { name: "Routing rule" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user().keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();
    await act(async () => finish(Response.json({ ...key, rule_id: "rule:working-hours" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("retains a failed binding, shows reference details and clears the draft when reopened", async () => {
    render(<KeyRuleBinding apiKey={key} rules={fixtureRules} />);
    await open(); await selectOption("Routing rule", "Working hours");
    fetchSpy.mockResolvedValueOnce(Response.json({ error: { message: "Rule no longer exists", references: [{ id: "rule:working-hours", name: "Working hours" }] } }, { status: 409 }));
    await user().click(screen.getByRole("button", { name: "Save binding" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Rule no longer exists Referenced by: Working hours");
    expect(screen.getByRole("combobox", { name: "Routing rule" })).toHaveTextContent("Working hours");
    expect(refresh).not.toHaveBeenCalled();
    await user().click(screen.getByRole("button", { name: "Cancel" }));
    await open();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Routing rule" })).toHaveTextContent("GitHub Copilot");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("shows a missing binding explicitly and allows selecting a known rule", async () => {
    render(<KeyRuleBinding apiKey={{ ...key, rule_id: "missing:rule" }} rules={fixtureRules} />);
    expect(screen.getByText("Unknown rule (missing:rule)")).toBeVisible();
    await open();
    expect(screen.getByRole("button", { name: "Save binding" })).toBeDisabled();
    await selectOption("Routing rule", "GitHub Copilot");
    expect(screen.getByRole("button", { name: "Save binding" })).toBeEnabled();
    await user().click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
