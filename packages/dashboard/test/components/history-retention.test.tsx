// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { HistoryRetentionContent } from "@/app/settings/history-retention-content";
import "../helpers/routing-interactions";

afterEach(() => vi.restoreAllMocks());

it("offers exactly five retention choices and retains the previous value on failure", async () => {
  const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "Fixture save failure" }, { status: 500 }));
  render(<HistoryRetentionContent days={30} />);
  const select = screen.getByRole("combobox", { name: "History retention" });
  expect(select).toHaveTextContent("30 days");
  expect(screen.getByRole("heading", { name: "Request history" }).closest("[data-basalt-surface]")).not.toBeNull();
  await userEvent.click(select);
  expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["7 days", "14 days", "30 days", "60 days", "90 days"]);
  await userEvent.click(screen.getByRole("option", { name: /^7 days$/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Fixture save failure");
  expect(select).toHaveTextContent("30 days");
  expect(request).toHaveBeenCalledTimes(1);
});
