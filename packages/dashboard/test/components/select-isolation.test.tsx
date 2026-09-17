// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TimeRangePicker } from "@/components/analytics/time-range-picker";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

describe("Select focus isolation", { concurrent: false }, () => {
  it("removes a focused trigger when its view unmounts", async () => {
    const view = render(<TimeRangePicker value="24h" onChange={vi.fn()} />);
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    view.unmount();
    expect(trigger.isConnected).toBe(false);
  });

  it("opens and selects after the preceding focused trigger was removed", async () => {
    const onChange = vi.fn();
    render(<TimeRangePicker value="24h" onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Last 7 days" }));
    expect(onChange).toHaveBeenCalledWith("7d");
  });

  it("still dismisses an open Select on genuine window blur", async () => {
    render(<TimeRangePicker value="24h" onChange={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: "Last 7 days" })).toBeVisible();
    fireEvent(window, new Event("blur"));
    await waitFor(() => expect(screen.queryByRole("option", { name: "Last 7 days" })).toBeNull());
  });
});
