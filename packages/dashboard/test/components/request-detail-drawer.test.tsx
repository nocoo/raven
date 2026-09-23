// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Polyfills for Radix UI in jsdom
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/requests",
  useSearchParams: () => new URLSearchParams(),
}));

// ---------------------------------------------------------------------------
// Mock log dock context
// ---------------------------------------------------------------------------

const mockOpenLogs = vi.fn();
vi.mock("@/components/logs/log-dock-context", () => ({
  useLogDock: () => ({
    openLogs: mockOpenLogs,
    closeLogs: vi.fn(),
    toggleLogs: vi.fn(),
    isOpen: false,
    requestIdFilter: null,
    setRequestIdFilter: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { RequestDetailDrawer } from "@/components/requests/request-detail-drawer";
import {
  ColumnConfig,
  ALL_COLUMNS,
  getDefaultVisibleColumns,
} from "@/components/requests/column-config";
import type { ExtendedRequestRecord, RequestRouting } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExtendedRecord(overrides: Partial<ExtendedRequestRecord> = {}): ExtendedRequestRecord {
  return {
    id: "req-test-001",
    timestamp: 1710600000000,
    path: "/v1/chat/completions",
    model: "claude-sonnet-4",
    resolved_model: "claude-sonnet-4-20250514",
    client_format: "openai",
    status: "success",
    status_code: 200,
    upstream_status: null,
    error_message: null,
    account_name: "alice",
    api_key_id: "key-alice",
    key_id: "key-alice",
    protocol_mode: "translated",
    server_tools_used: 0,
    latency_ms: 2500,
    ttft_ms: 450,
    input_tokens: 1200,
    output_tokens: 800,
    cache_read_tokens: 9000,
    cache_write_tokens: 600,
    stream: 1,
    session_id: "sess_abc123",
    client_name: "Claude Code",
    client_version: "1.2.3",
    processing_ms: 1800,
    strategy: "copilot-translated",
    upstream: "openrouter",
    upstream_format: "openai",
    translated_model: "anthropic/claude-sonnet-4",
    copilot_model: "claude-sonnet-4",
    routing_path: "translated",
    stop_reason: "stop",
    tool_call_count: 3,
    ...overrides,
  };
}

// ===========================================================================
// RequestDetailDrawer
// ===========================================================================

describe("RequestDetailDrawer", () => {
  it("warns only for translated requests and recommends the actual upstream protocol", () => {
    const { rerender } = render(<RequestDetailDrawer request={makeExtendedRecord({ client_format: "anthropic", upstream_format: "responses", strategy: "protocol-converted" })} open onOpenChange={vi.fn()} />);
    expect(screen.getByText("Translation · Messages → Responses")).toBeVisible();
    expect(screen.getByText(/Prefer Responses in your client/)).toBeVisible();
    rerender(<RequestDetailDrawer request={makeExtendedRecord({ protocol_mode: "native" })} open onOpenChange={vi.fn()} />);
    expect(screen.queryByText(/compatibility risk/)).toBeNull();
    rerender(<RequestDetailDrawer request={makeExtendedRecord({ upstream_format: "unknown", strategy: "protocol-converted" })} open onOpenChange={vi.fn()} />);
    expect(screen.getByText(/Prefer the model's native protocol/)).toBeVisible();
  });
  const routing: RequestRouting = {
    requested_model: "auto", resolved_model: "gpt-5.6-sol", rule_id: "rule:work", period_id: "period:morning",
    upstream_id: "builtin:copilot", upstream_name: "GitHub Copilot", quota_window_id: "window:fixture",
    multiplier: 0.5, weighted_tokens: 12.75, usage_complete: true, accounting_healthy: true,
    admitted_at: 1710600000000, diagnostic: false,
    skipped: [{ upstream_id: "custom:research", reason: "quota_exhausted" }, { upstream_id: "custom:research", reason: "quota_exhausted" }],
  };

  it("shows the captured routing choice while preserving the incoming model in the title and analytics link", () => {
    render(<RequestDetailDrawer request={makeExtendedRecord({ model: "auto", routing })} open onOpenChange={vi.fn()} />);
    const section = within(screen.getByRole("region", { name: "Routing details" }));
    expect(section.getByText("GitHub Copilot")).toBeVisible();
    expect(section.getByText("gpt-5.6-sol")).toBeVisible();
    expect(section.getByText("rule:work")).toBeVisible();
    expect(section.getByText("period:morning")).toBeVisible();
    expect(section.getByText("window:fixture")).toBeVisible();
    expect(section.getByText("0.5×")).toBeVisible();
    expect(section.getByText("12.75 tokens")).toBeVisible();
    expect(section.getByText("Complete")).toBeVisible();
    expect(section.getByText("Healthy")).toBeVisible();
    expect(section.getByText("custom:research · quota_exhausted; custom:research · quota_exhausted")).toBeVisible();
    expect(screen.getByRole("heading", { name: "success auto" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Analyze auto" })).toHaveAttribute("href", expect.stringContaining("model=auto"));
    expect(screen.queryByText("Diagnostic · quota accounted")).toBeNull();
  });

  it("labels a diagnostic with default-chain, quota-free and incomplete accounting states without inventing usage", () => {
    render(<RequestDetailDrawer request={makeExtendedRecord({ routing: { ...routing, diagnostic: true, period_id: null, quota_window_id: null, weighted_tokens: 0, usage_complete: false, accounting_healthy: false, skipped: [] } })} open onOpenChange={vi.fn()} />);
    const section = within(screen.getByRole("region", { name: "Routing details" }));
    expect(section.getByText("Diagnostic · quota accounted")).toBeVisible();
    expect(section.getByText("Default chain")).toBeVisible();
    expect(section.getByText("No quota")).toBeVisible();
    expect(section.getByText("0 tokens")).toBeVisible();
    expect(section.getByText("Incomplete")).toBeVisible();
    expect(section.getByText("Blocked")).toBeVisible();
    expect(section.queryByText("Skipped candidates")).toBeNull();
  });

  it.each(["native", "unknown"] as const)("exposes %s routing, stable key identity and server-tool execution", (mode) => {
    render(<RequestDetailDrawer request={makeExtendedRecord({ protocol_mode: mode, server_tools_used: 1, key_id: "legacy:Editor", account_name: "" })} open onOpenChange={() => {}} filters={{ range: "7d", protocol_mode: mode }} />);
    expect(screen.getByText(mode === "native" ? "Native" : "Unknown")).toBeDefined();
    expect(screen.getByText("Server tools")).toBeDefined();
    expect(screen.getByText("Historical name · ID not recorded")).toBeDefined();
    const keyLink = screen.getByRole("link", { name: "Unattributed" });
    const params = new URL(keyLink.getAttribute("href")!, "https://raven.test").searchParams;
    expect(params.get("key_id")).toBe("legacy:Editor");
    expect(params.get("range")).toBe("7d");
  });
  it("renders sparse non-streaming requests without fabricated token or routing details", () => {
    const request = makeExtendedRecord({
      latency_ms: 0, ttft_ms: 0, processing_ms: 0, stream: 0,
      input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
      translated_model: "", strategy: "", upstream: "", upstream_format: "", routing_path: "",
      copilot_model: "", account_name: "", client_name: "", stop_reason: "", tool_call_count: 0,
    });
    render(<RequestDetailDrawer request={request} open onOpenChange={() => {}} />);
    expect(screen.getByText("No")).toBeDefined();
    expect(screen.getAllByText("—")).toHaveLength(5);
    expect(screen.queryByText("Strategy")).toBeNull();
    expect(screen.queryByText("Tool Calls")).toBeNull();
    expect(screen.getAllByText("0ms").length).toBeGreaterThan(0);
    expect(screen.queryByRole("region", { name: "Routing details" })).toBeNull();
  });

  it.each([null, {}])("leaves the drawer usable when clipboard support is %j", (clipboard) => {
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    try {
      render(<RequestDetailDrawer request={makeExtendedRecord()} open onOpenChange={() => {}} />);
      fireEvent.click(screen.getByLabelText("Copy request ID"));
      expect(screen.getByText("req-test-001")).toBeDefined();
    } finally {
      if (previous) Object.defineProperty(navigator, "clipboard", previous);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("handles denied clipboard writes without an unhandled rejection", async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<RequestDetailDrawer request={makeExtendedRecord()} open onOpenChange={() => {}} />);
      fireEvent.click(screen.getByLabelText("Copy request ID"));
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith("req-test-001");
    } finally {
      if (previous) Object.defineProperty(navigator, "clipboard", previous);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("renders nothing when request is null", () => {
    const { container } = render(
      <RequestDetailDrawer request={null} open={false} onOpenChange={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("shows request model and status when open", () => {
    const req = makeExtendedRecord();
    render(
      <RequestDetailDrawer request={req} open={true} onOpenChange={() => {}} />,
    );
    // Model appears in title and details section
    expect(screen.getAllByText("claude-sonnet-4").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("success").length).toBeGreaterThanOrEqual(1);
  });

  it("shows request ID with copy button", () => {
    const req = makeExtendedRecord({ id: "req-unique-id" });
    render(
      <RequestDetailDrawer request={req} open={true} onOpenChange={() => {}} />,
    );
    expect(screen.getByText("req-unique-id")).toBeDefined();
    expect(screen.getByLabelText("Copy request ID")).toBeDefined();
  });

  it("shows timing breakdown waterfall", () => {
    const req = makeExtendedRecord({ latency_ms: 3000, ttft_ms: 500, processing_ms: 2000 });
    render(
      <RequestDetailDrawer request={req} open={true} onOpenChange={() => {}} />,
    );
    expect(screen.getByText("Timing")).toBeDefined();
    expect(screen.getByText("Total Latency")).toBeDefined();
    // "TTFT" appears in both waterfall label and detail row
    expect(screen.getAllByText("TTFT").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Processing").length).toBeGreaterThanOrEqual(1);
  });

  it("shows routing info", () => {
    const req = makeExtendedRecord({ strategy: "copilot-translated", upstream: "openrouter" });
    render(
      <RequestDetailDrawer request={req} open={true} onOpenChange={() => {}} />,
    );
    expect(screen.getByText("copilot-translated")).toBeDefined();
    expect(screen.getByText("openrouter")).toBeDefined();
  });

  it("shows error message when present", () => {
    const req = makeExtendedRecord({
      status: "error",
      error_message: "Rate limit exceeded",
    });
    render(
      <RequestDetailDrawer request={req} open={true} onOpenChange={() => {}} />,
    );
    expect(screen.getByText("Rate limit exceeded")).toBeDefined();
    expect(screen.getByText("Error")).toBeDefined();
  });

  it("shows token breakdown", () => {
    const req = makeExtendedRecord({ input_tokens: 1200, output_tokens: 800 });
    render(
      <RequestDetailDrawer request={req} open={true} onOpenChange={() => {}} />,
    );
    expect(screen.getByText("1,200")).toBeDefined();
    expect(screen.getByText("800")).toBeDefined();
    expect(screen.getByText("2,000")).toBeDefined();
  });

  it("shows client context", () => {
    const req = makeExtendedRecord({
      client_name: "Cursor",
      account_name: "bob",
      client_version: "2.0.1",
    });
    render(
      <RequestDetailDrawer request={req} open={true} onOpenChange={() => {}} />,
    );
    expect(screen.getByText("Cursor")).toBeDefined();
    expect(screen.getByText("bob")).toBeDefined();
    expect(screen.getByText("2.0.1")).toBeDefined();
  });

  it("shows tool call count when > 0", () => {
    const req = makeExtendedRecord({ tool_call_count: 5 });
    render(
      <RequestDetailDrawer request={req} open={true} onOpenChange={() => {}} />,
    );
    expect(screen.getByText("5")).toBeDefined();
  });

  it("renders short session id as a plain detail row", () => {
    const req = makeExtendedRecord({ session_id: "sess_abc123" });
    render(
      <RequestDetailDrawer request={req} open={true} onOpenChange={() => {}} />,
    );
    expect(screen.getByText("sess_abc123")).toBeDefined();
    // No <pre> json block should be rendered for a plain id
    expect(document.querySelector("pre")).toBeNull();
  });

  it("renders JSON-shaped session id inside a JsonBlock", () => {
    const req = makeExtendedRecord({
      session_id: '{"device_id":"dev-xyz","session_id":"sess-1"}',
    });
    render(
      <RequestDetailDrawer request={req} open={true} onOpenChange={() => {}} />,
    );
    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    // pretty-printed multi-line content
    expect(pre?.textContent).toContain('"device_id"');
    expect(pre?.textContent).toContain("\n");
    expect(screen.getByLabelText("Copy JSON")).toBeDefined();
  });

  it("shows button to live logs and opens dock on click", async () => {
    mockOpenLogs.mockClear();
    const onOpenChange = vi.fn();
    const req = makeExtendedRecord({ id: "req-xyz" });
    render(
      <RequestDetailDrawer request={req} open={true} onOpenChange={onOpenChange} />,
    );
    const button = screen.getByRole("button", { name: /view in live logs/i });
    expect(button).toBeDefined();

    const user = userEvent.setup();
    await user.click(button);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockOpenLogs).toHaveBeenCalledWith("req-xyz");
  });
});

// ===========================================================================
// ColumnConfig
// ===========================================================================

describe("ColumnConfig", () => {
  it("renders the Columns button", () => {
    render(
      <ColumnConfig visibleColumns={new Set(["timestamp"])} onToggle={() => {}} />,
    );
    expect(screen.getByLabelText("Configure columns")).toBeDefined();
  });

  it("opens dropdown on click", async () => {
    render(
      <ColumnConfig visibleColumns={new Set(["timestamp"])} onToggle={() => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Configure columns"));
    expect(screen.getByText("Toggle columns")).toBeDefined();
  });

  it("shows all column options", async () => {
    render(
      <ColumnConfig visibleColumns={new Set(["timestamp"])} onToggle={() => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Configure columns"));
    for (const col of ALL_COLUMNS) {
      expect(screen.getByText(col.label)).toBeDefined();
    }
  });

  it("calls onToggle when a column is clicked", async () => {
    const toggle = vi.fn();
    render(
      <ColumnConfig visibleColumns={new Set(["timestamp"])} onToggle={toggle} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Configure columns"));
    await user.click(screen.getByText("Strategy"));
    expect(toggle).toHaveBeenCalledWith("strategy");
  });

  it("marks visible columns as checked", async () => {
    const visible = new Set(["timestamp", "model", "strategy"]);
    render(
      <ColumnConfig visibleColumns={visible} onToggle={() => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Configure columns"));

    const items = screen.getAllByRole("menuitemcheckbox");
    const timestampItem = items.find((i) => i.textContent?.includes("Time"));
    const strategyItem = items.find((i) => i.textContent?.includes("Strategy"));
    const upstreamItem = items.find((i) => i.textContent?.includes("Upstream"));

    expect(timestampItem?.getAttribute("aria-checked")).toBe("true");
    expect(strategyItem?.getAttribute("aria-checked")).toBe("true");
    expect(upstreamItem?.getAttribute("aria-checked")).toBe("false");
  });
});

// ===========================================================================
// getDefaultVisibleColumns
// ===========================================================================

describe("getDefaultVisibleColumns", () => {
  it("returns a Set with all default-visible column keys", () => {
    const defaults = getDefaultVisibleColumns();
    expect(defaults.has("timestamp")).toBe(true);
    expect(defaults.has("model")).toBe(true);
    expect(defaults.has("status")).toBe(true);
    expect(defaults.has("latency_ms")).toBe(true);
    expect(defaults.has("protocol_mode")).toBe(true);
    expect(defaults.has("account_name")).toBe(true);
  });

  it("does not include hidden-by-default columns", () => {
    const defaults = getDefaultVisibleColumns();
    expect(defaults.has("strategy")).toBe(false);
    expect(defaults.has("upstream")).toBe(false);
    expect(defaults.has("session_id")).toBe(false);
    expect(defaults.has("error_message")).toBe(false);
  });
});
