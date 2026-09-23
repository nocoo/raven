// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LogsDock } from "@/components/logs/logs-dock";
import { LogDockProvider, useLogDock } from "@/components/logs/log-dock-context";

const viewport = vi.hoisted(() => ({ compact: false }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => viewport.compact }));
vi.mock("@/app/logs/logs-content", () => ({
  LogsContent: ({ onClose, requestIdFilter, onClearRequestIdFilter }: { onClose: () => void; requestIdFilter?: string; onClearRequestIdFilter: () => void }) => <>
    <button type="button" onClick={onClose}>Close logs dock</button>
    {requestIdFilter && <button type="button" onClick={onClearRequestIdFilter}>Clear {requestIdFilter}</button>}
  </>,
}));

function RequestLink() {
  const { openLogs } = useLogDock();
  return <button type="button" onClick={() => openLogs("request-1")}>Inspect request logs</button>;
}

beforeEach(() => { viewport.compact = false; });

describe("LogsDock", () => {
  it("opens the push dock from its FAB and restores focus after closing", async () => {
    render(<LogDockProvider><LogsDock /></LogDockProvider>);
    const launcher = screen.getByRole("button", { name: "Open live logs" });
    launcher.focus();
    fireEvent.click(launcher);
    const dock = screen.getByRole("complementary", { name: "Live logs dock" });
    expect(dock).not.toHaveAttribute("inert");
    const surface = dock.querySelector(".logs-dock-surface");
    expect(surface).toHaveAttribute("data-basalt-surface-root");
    expect(surface).toHaveClass("overflow-hidden");
    expect(screen.queryByRole("button", { name: "Close live logs dock" })).toBeNull();
    expect(launcher).toHaveAttribute("inert");
    const close = screen.getByRole("button", { name: "Close logs dock" });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.click(close);
    expect(dock).toHaveAttribute("inert");
    expect(launcher).toHaveFocus();
  });

  it("uses a dismissible overlay in a compact frame and retains request filtering", async () => {
    viewport.compact = true;
    render(<LogDockProvider><RequestLink /><LogsDock /></LogDockProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Inspect request logs" }));
    expect(screen.getByRole("region", { name: "Live logs dock" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear request-1" }));
    expect(screen.queryByRole("button", { name: "Clear request-1" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Close logs dock" })).toHaveFocus());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Live logs dock" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open live logs" }));
    fireEvent.click(screen.getByRole("button", { name: "Close live logs dock" }));
    expect(screen.queryByRole("region", { name: "Live logs dock" })).toBeNull();
  });
});
