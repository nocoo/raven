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
const mockRefresh = vi.fn();
let mockSearchParams = new URLSearchParams();
const mockPathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
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
  mockRefresh.mockClear();
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
  it.each([
    ["model", "model=gpt-5"],
    ["key_id", "key_id=key-1"],
    ["key_id", "account=Editor"],
  ] as const)("does not duplicate the %s tab selection (%s) as filter chips or a count", (tabDimension, query) => {
    mockSearchParams = new URLSearchParams(query);
    render(<FilterBar tabDimension={tabDimension} />);
    expect(screen.queryByRole("button", { name: /^Remove .* filter$/ })).toBeNull();
    expect(screen.queryByText(/\d+ active/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it.each([
    ["model", "model=gpt-5"],
    ["key_id", "key_id=key-1"],
    ["key_id", "account=Editor"],
  ] as const)("keeps the %s tab (%s) when resetting other filters", async (tabDimension, query) => {
    mockSearchParams = new URLSearchParams(`${query}&status=error&range=7d`);
    render(<FilterBar tabDimension={tabDimension} />);
    expect(screen.getAllByRole("button", { name: /^Remove .* filter$/ })).toHaveLength(1);
    expect(screen.getByText("1 active")).toBeDefined();
    await userEvent.setup().click(screen.getByRole("button", { name: "Reset" }));
    expect(mockPush).toHaveBeenCalledWith(`/?${query}`);
  });

  it.each([["Every 1s", 1000], ["Every 5s", 5000], ["Auto: off", 0]] as const)("sets automatic refresh to %s without navigating or clearing filters", async (label, milliseconds) => {
    const timer = vi.spyOn(window, "setInterval");
    try {
      mockSearchParams = new URLSearchParams("model=gpt-5&cursor=cursor-2&sort=latency");
      const { rerender } = render(<FilterBar />);
      expect(screen.queryByRole("combobox", { name: "Auto-refresh interval" })).toBeNull();
      rerender(<FilterBar autoRefresh />);
      const interval = screen.getByRole("combobox", { name: "Auto-refresh interval" });
      expect(interval).toHaveTextContent("Every 3s");
      expect(timer).toHaveBeenLastCalledWith(expect.any(Function), 3000);
      const user = userEvent.setup();
      await user.click(interval);
      await user.click(screen.getByRole("option", { name: label }));
      expect(interval).toHaveTextContent(label);
      if (milliseconds) expect(timer).toHaveBeenLastCalledWith(expect.any(Function), milliseconds);
      await user.click(screen.getByRole("button", { name: "Refresh monitoring data" }));
      expect(mockRefresh).toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
      expect(mockSearchParams.toString()).toBe("model=gpt-5&cursor=cursor-2&sort=latency");
    } finally {
      timer.mockRestore();
    }
  });

  it("selects a stable key ID without retaining a historical name filter", async () => {
    mockSearchParams = new URLSearchParams("range=7d&model=gpt-5&account=Editor&protocol_mode=native");
    render(<FilterBar keys={[{ id: "key-1", label: "Editor" }, { id: "key-2", label: "Editor" }, { id: "legacy:Editor", label: "Editor" }]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Filter by API key" }));
    expect(screen.getByRole("option", { name: "Editor · historical" })).toBeDefined();
    await user.click(screen.getByRole("option", { name: "Editor · key-2" }));
    const params = new URLSearchParams(String(mockPush.mock.calls[0]![0]).split("?")[1]);
    expect(params.get("key_id")).toBe("key-2");
    expect(params.has("account")).toBe(false);
    expect(params.get("model")).toBe("gpt-5");
    expect(params.get("range")).toBe("7d");
    expect(params.get("protocol_mode")).toBe("native");
  });

  it("clears a key selection while keeping the selected time interval", async () => {
    mockSearchParams = new URLSearchParams("range=custom&from=0&to=60000&key_id=key-1");
    render(<FilterBar keys={[{ id: "key-1", label: "Editor" }]} />);
    const user = userEvent.setup();
    expect(screen.getByText(/Selected interval:/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Remove Key filter" })).toBeDefined();
    await user.click(screen.getByRole("combobox", { name: "Filter by API key" }));
    await user.click(screen.getByRole("option", { name: "All keys" }));
    expect(mockPush).toHaveBeenCalledWith("/?range=custom&from=0&to=60000");
  });

  it.each([["", "Unknown", "unknown"], ["protocol_mode=native", "All protocols", null]])("changes the protocol selection from %s", async (query, label, expected) => {
    mockSearchParams = new URLSearchParams(query!);
    render(<FilterBar />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Filter by protocol" }));
    await user.click(screen.getByRole("option", { name: label! }));
    const params = new URLSearchParams(String(mockPush.mock.calls[0]![0]).split("?")[1]);
    expect(params.get("protocol_mode")).toBe(expected);
  });

  it("refreshes the current monitoring snapshot", async () => {
    render(<FilterBar />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh monitoring data" }));
    expect(mockRefresh).toHaveBeenCalledOnce();
  });

  it("applies exact client, session and upstream values while preserving the model and key", async () => {
    mockSearchParams = new URLSearchParams("model=gpt-5&key_id=key-1");
    render(<FilterBar investigation />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Client & session filters"));
    await user.type(screen.getByRole("textbox", { name: "Client name" }), " Editor ");
    await user.type(screen.getByRole("textbox", { name: "Session ID" }), "sess&2");
    await user.type(screen.getByRole("textbox", { name: "Upstream name" }), "provider");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    const params = new URLSearchParams(String(mockPush.mock.calls[0]![0]).split("?")[1]);
    expect(Object.fromEntries(params)).toEqual({ model: "gpt-5", key_id: "key-1", client: "Editor", session: "sess&2", upstream: "provider" });
  });

  it("clears exact-match investigation fields without widening the time range", async () => {
    mockSearchParams = new URLSearchParams("range=7d&client=Editor&session=sess-1&upstream=provider");
    render(<FilterBar investigation />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Client & session filters"));
    for (const name of ["Client name", "Session ID", "Upstream name"]) await user.clear(screen.getByRole("textbox", { name }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(mockPush).toHaveBeenCalledWith("/?range=7d");
  });

  it("shows every deep-linked dimension, including zero latency and synchronous mode", () => {
    mockSearchParams = new URLSearchParams({
      model: "m", resolved_model: "resolved", strategy: "native", upstream: "fixture-provider",
      account: "fixture-account", client: "fixture-client", client_version: "1.2.3",
      session: "fixture-session", path: "/v1/messages", status: "error", status_code: "429",
      stream: "false", has_error: "true", min_latency: "0", max_latency: "1000",
      stop_reason: "length", routing_path: "fallback",
    });
    render(<FilterBar upstreams={["fixture-provider"]} />);
    expect(screen.getByText("17 active")).toBeDefined();
    expect(screen.getAllByRole("button", { name: /^Remove .* filter$/ })).toHaveLength(17);
    expect(screen.getByText("0ms")).toBeDefined();
    expect(screen.getByText("Version:")).toBeDefined();
  });

  it.each([
    ["fixture-model", "model"], ["fixture-strategy", "strategy"],
    ["fixture-provider", "upstream"], ["error", "status"], ["cancelled", "status"],
  ])("selects %s through the actual dropdown", async (value, key) => {
    render(<FilterBar models={["fixture-model"]} strategies={["fixture-strategy"]} upstreams={["fixture-provider"]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: `Filter by ${key}` }));
    await user.click(screen.getByRole("option", { name: value }));
    const params = new URLSearchParams(String(mockPush.mock.calls[0]![0]).split("?")[1]);
    expect(params.get(key)).toBe(value);
  });

  it("clears the last upstream selection without retaining an empty query string", async () => {
    mockSearchParams = new URLSearchParams("upstream=fixture-provider");
    render(<FilterBar upstreams={["fixture-provider"]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Filter by upstream" }));
    await user.click(screen.getByRole("option", { name: "All upstreams" }));
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it.each([
    ["stream=false", "Streaming", "/?stream=true"],
    ["stream=true", "Synchronous", "/?stream=false"],
    ["stream=true", "All modes", "/"],
  ])("changes request mode from %s to %s", async (query, label, expected) => {
    mockSearchParams = new URLSearchParams(query);
    render(<FilterBar />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Filter by stream" }));
    await user.click(screen.getByRole("option", { name: label }));
    expect(mockPush).toHaveBeenCalledWith(expected);
  });

  it("clears old custom bounds when selecting the default time range", async () => {
    mockSearchParams = new URLSearchParams("range=custom&from=1000&to=2000");
    render(<FilterBar />);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("combobox")[0]!);
    await user.click(screen.getByRole("option", { name: "Last 24 hours" }));
    expect(mockPush).toHaveBeenCalledWith("/");
  });

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
    expect(triggers.length).toBe(5);
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
