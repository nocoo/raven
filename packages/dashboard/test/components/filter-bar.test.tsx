// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Polyfill pointer/scroll APIs missing from jsdom (required by Radix UI)
// ---------------------------------------------------------------------------

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();
const mockPathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: vi.fn() }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => mockPathname,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { FilterBar } from "@/components/analytics/filter-bar";
import { TimeRangePicker } from "@/components/analytics/time-range-picker";
import { FilterChip } from "@/components/analytics/filter-chip";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockPush.mockClear();
  mockSearchParams = new URLSearchParams();
});

// ---------------------------------------------------------------------------
// TimeRangePicker
// ---------------------------------------------------------------------------

describe("TimeRangePicker", () => {
  it("renders with current value displayed", () => {
    const onChange = vi.fn();
    render(<TimeRangePicker value="24h" onChange={onChange} />);
    expect(screen.getByText("Last 24 hours")).toBeDefined();
  });

  it("renders a combobox trigger", () => {
    const onChange = vi.fn();
    render(<TimeRangePicker value="7d" onChange={onChange} />);
    expect(screen.getByRole("combobox")).toBeDefined();
    expect(screen.getByText("Last 7 days")).toBeDefined();
  });

  it("displays correct label for each range value", () => {
    const onChange = vi.fn();
    const { rerender } = render(<TimeRangePicker value="15m" onChange={onChange} />);
    expect(screen.getByText("Last 15 min")).toBeDefined();

    rerender(<TimeRangePicker value="1h" onChange={onChange} />);
    expect(screen.getByText("Last 1 hour")).toBeDefined();

    rerender(<TimeRangePicker value="6h" onChange={onChange} />);
    expect(screen.getByText("Last 6 hours")).toBeDefined();

    rerender(<TimeRangePicker value="30d" onChange={onChange} />);
    expect(screen.getByText("Last 30 days")).toBeDefined();
  });

  it("opens dropdown showing all range options on click", async () => {
    const onChange = vi.fn();
    render(<TimeRangePicker value="24h" onChange={onChange} />);

    const user = userEvent.setup();
    const trigger = screen.getByRole("combobox");
    await user.click(trigger);

    // All options should be visible in the popover
    expect(screen.getByRole("option", { name: "Last 15 min" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Last 1 hour" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Last 6 hours" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Last 24 hours" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Last 7 days" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Last 30 days" })).toBeDefined();
  });

  it("calls onChange when selecting a different option", async () => {
    const onChange = vi.fn();
    render(<TimeRangePicker value="24h" onChange={onChange} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Last 7 days" }));

    expect(onChange).toHaveBeenCalledWith("7d");
  });
});

// ---------------------------------------------------------------------------
// FilterChip
// ---------------------------------------------------------------------------

describe("FilterChip", () => {
  it("renders label and string value", () => {
    const onRemove = vi.fn();
    render(<FilterChip filterKey="model" value="claude-3" onRemove={onRemove} />);
    expect(screen.getByText("Model:")).toBeDefined();
    expect(screen.getByText("claude-3")).toBeDefined();
  });

  it("renders boolean true as Yes", () => {
    const onRemove = vi.fn();
    render(<FilterChip filterKey="has_error" value={true} onRemove={onRemove} />);
    expect(screen.getByText("Has Error:")).toBeDefined();
    expect(screen.getByText("Yes")).toBeDefined();
  });

  it("renders boolean false as No", () => {
    const onRemove = vi.fn();
    render(<FilterChip filterKey="stream" value={false} onRemove={onRemove} />);
    expect(screen.getByText("Stream:")).toBeDefined();
    expect(screen.getByText("No")).toBeDefined();
  });

  it("renders numeric value as string", () => {
    const onRemove = vi.fn();
    render(<FilterChip filterKey="status_code" value={429} onRemove={onRemove} />);
    expect(screen.getByText("Status Code:")).toBeDefined();
    expect(screen.getByText("429")).toBeDefined();
  });

  it("calls onRemove when X button is clicked", async () => {
    const onRemove = vi.fn();
    render(<FilterChip filterKey="model" value="claude-3" onRemove={onRemove} />);

    const user = userEvent.setup();
    const removeBtn = screen.getByRole("button", { name: /Remove Model filter/i });
    await user.click(removeBtn);

    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("uses filterLabel for human-readable key names", () => {
    const onRemove = vi.fn();
    render(<FilterChip filterKey="routing_path" value="native" onRemove={onRemove} />);
    expect(screen.getByText("Routing:")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------

describe("FilterBar", () => {
  it("renders time range picker with default 24h", () => {
    render(<FilterBar />);
    expect(screen.getByText("Last 24 hours")).toBeDefined();
  });

  it("renders time range picker reflecting URL param", () => {
    mockSearchParams = new URLSearchParams("range=7d");
    render(<FilterBar />);
    expect(screen.getByText("Last 7 days")).toBeDefined();
  });

  it("renders model dropdown when models are provided", () => {
    render(<FilterBar models={["claude-3", "gpt-4o"]} />);
    // Should have multiple comboboxes (time range + model + status + stream)
    const triggers = screen.getAllByRole("combobox");
    expect(triggers.length).toBeGreaterThan(1);
  });

  it("renders strategy dropdown when strategies are provided", () => {
    render(<FilterBar strategies={["copilot-native", "custom-openai"]} />);
    const triggers = screen.getAllByRole("combobox");
    // time + strategy + status + stream = 4
    expect(triggers.length).toBe(4);
  });

  it("shows active filter count when filters are active", () => {
    mockSearchParams = new URLSearchParams("model=claude-3&status=error");
    render(<FilterBar models={["claude-3"]} />);
    expect(screen.getByText("2 active")).toBeDefined();
  });

  it("shows Reset button when dimension filters are active", () => {
    mockSearchParams = new URLSearchParams("model=claude-3");
    render(<FilterBar models={["claude-3"]} />);
    expect(screen.getByText("Reset")).toBeDefined();
  });

  it("does not show Reset when no dimension filters (only range)", () => {
    mockSearchParams = new URLSearchParams("range=7d");
    render(<FilterBar />);
    expect(screen.queryByText("Reset")).toBeNull();
  });

  it("renders filter chips for active model filter", () => {
    mockSearchParams = new URLSearchParams("model=gpt-4o");
    render(<FilterBar />);
    expect(screen.getByText("Model:")).toBeDefined();
    // gpt-4o appears in chip (and potentially in select trigger too)
    expect(screen.getAllByText("gpt-4o").length).toBeGreaterThanOrEqual(1);
  });

  it("renders filter chips for stream=true", () => {
    mockSearchParams = new URLSearchParams("stream=true");
    render(<FilterBar />);
    expect(screen.getByText("Stream:")).toBeDefined();
    // "Yes" from FilterChip
    expect(screen.getByText("Yes")).toBeDefined();
  });

  it("renders filter chips for has_error", () => {
    mockSearchParams = new URLSearchParams("has_error=true");
    render(<FilterBar />);
    expect(screen.getByText("Has Error:")).toBeDefined();
  });

  it("removes filter chip via X button and pushes URL", async () => {
    mockSearchParams = new URLSearchParams("model=gpt-4o&status=error");
    render(<FilterBar />);

    const user = userEvent.setup();
    const removeBtn = screen.getByRole("button", { name: /Remove Model filter/i });
    await user.click(removeBtn);

    expect(mockPush).toHaveBeenCalledOnce();
    const url = mockPush.mock.calls[0]![0] as string;
    expect(url).not.toContain("model=");
    // status should remain
    expect(url).toContain("status=error");
  });

  it("resets all filters when Reset is clicked", async () => {
    mockSearchParams = new URLSearchParams("range=7d&model=gpt-4o&status=error");
    render(<FilterBar models={["gpt-4o"]} />);

    const user = userEvent.setup();
    const resetBtn = screen.getByText("Reset");
    await user.click(resetBtn);

    expect(mockPush).toHaveBeenCalledOnce();
    const url = mockPush.mock.calls[0]![0] as string;
    // Default range is 24h (not serialized), so should be just pathname
    expect(url).toBe("/");
  });

  it("renders in compact mode without dimension dropdowns", () => {
    render(<FilterBar compact models={["claude-3"]} strategies={["native"]} />);
    // Should still have time range picker but no other dropdowns
    const triggers = screen.getAllByRole("combobox");
    expect(triggers.length).toBe(1);
    expect(screen.getByText("Last 24 hours")).toBeDefined();
  });

  it("changes range via time range picker", async () => {
    render(<FilterBar />);
    const user = userEvent.setup();

    // Open time range picker — it's the first combobox
    const triggers = screen.getAllByRole("combobox");
    await user.click(triggers[0]!);
    await user.click(screen.getByRole("option", { name: "Last 7 days" }));

    expect(mockPush).toHaveBeenCalledOnce();
    const url = mockPush.mock.calls[0]![0] as string;
    expect(url).toContain("range=7d");
  });

  it("renders multiple chips for multiple active filters", () => {
    mockSearchParams = new URLSearchParams("model=gpt-4o&status=error&routing_path=native");
    render(<FilterBar />);

    expect(screen.getByText("Model:")).toBeDefined();
    expect(screen.getByText("Status:")).toBeDefined();
    expect(screen.getByText("Routing:")).toBeDefined();
    expect(screen.getByText("3 active")).toBeDefined();
  });
});
