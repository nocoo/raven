// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalTime } from "@/components/local-time";

afterEach(() => vi.restoreAllMocks());

describe("local timestamps", () => {
  it("shows browser time while retaining an unambiguous machine-readable instant", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-345);
    render(<LocalTime timestamp={Date.UTC(2026, 8, 22, 21, 15, 30, 125)} precision="millisecond" />);
    expect(screen.getByText("2026-09-23 03:00:30.125")).toHaveAttribute("dateTime", "2026-09-22T21:15:30.125Z");
  });

  it("hydrates browser-local time without exposing server time or hydration errors", async () => {
    const offset = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
    const errors = vi.fn();
    const ui = <LocalTime timestamp={Date.UTC(2026, 8, 22, 0, 30)} />;
    const container = document.createElement("div");
    container.innerHTML = renderToString(ui);
    expect(container.textContent).toBe("—");
    document.body.append(container);
    offset.mockReturnValue(240);
    let root!: Root;
    await act(async () => { root = hydrateRoot(container, ui, { onRecoverableError: errors }); });
    expect(container.textContent).toBe("2026-09-21 20:30");
    expect(errors).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps missing timestamps visibly unknown", () => {
    render(<LocalTime timestamp={Number.NaN} precision="second" />);
    expect(screen.getByText("—")).not.toHaveAttribute("dateTime");
  });

  it("shows the local calendar date for date-only tables", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480);
    render(<LocalTime timestamp={Date.UTC(2026, 8, 22, 21)} precision="day" />);
    expect(screen.getByText("2026-09-23")).toHaveAttribute("dateTime", "2026-09-22T21:00:00.000Z");
  });
});
