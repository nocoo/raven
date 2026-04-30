// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
// Import after mocks
// ---------------------------------------------------------------------------

import { RequestDetailDrawer } from "@/components/requests/request-detail-drawer";
import {
  ColumnConfig,
  ALL_COLUMNS,
  getDefaultVisibleColumns,
} from "@/components/requests/column-config";
import type { ExtendedRequestRecord } from "@/lib/types";

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
    latency_ms: 2500,
    ttft_ms: 450,
    input_tokens: 1200,
    output_tokens: 800,
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

  it("shows link to live logs", () => {
    const req = makeExtendedRecord({ id: "req-xyz" });
    render(
      <RequestDetailDrawer request={req} open={true} onOpenChange={() => {}} />,
    );
    const link = screen.getByText("View in Live Logs");
    expect(link.closest("a")?.getAttribute("href")).toBe("/logs?requestId=req-xyz");
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
    expect(defaults.has("stream")).toBe(true);
    expect(defaults.has("path")).toBe(true);
  });

  it("does not include hidden-by-default columns", () => {
    const defaults = getDefaultVisibleColumns();
    expect(defaults.has("strategy")).toBe(false);
    expect(defaults.has("upstream")).toBe(false);
    expect(defaults.has("session_id")).toBe(false);
    expect(defaults.has("error_message")).toBe(false);
  });
});
