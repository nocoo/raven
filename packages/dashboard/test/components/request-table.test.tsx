// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: vi.fn() }),
  useSearchParams: () => mockSearchParams,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { RequestTable } from "@/components/requests/request-table";
import type { RequestRecord } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: "req-1",
    timestamp: 1710600000000,
    path: "/v1/chat/completions",
    model: "claude-sonnet-4",
    resolved_model: null,
    client_format: "openai",
    status: "success",
    status_code: 200,
    upstream_status: null,
    error_message: null,
    account_name: "test",
    latency_ms: 1234,
    ttft_ms: null,
    input_tokens: 100,
    output_tokens: 200,
    stream: 1,
    session_id: "user_abc_test123456",
    client_name: "Claude Code",
    client_version: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockPush.mockClear();
  mockSearchParams = new URLSearchParams();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatTimestamp", () => {
  it("formats epoch ms to readable string", () => {
    render(
      <RequestTable
        data={[makeRecord({ timestamp: 1710600000000 })]}
        hasMore={false}
      />,
    );
    // Should render a formatted time string (locale-dependent, but should contain key parts)
    const cells = screen.getAllByRole("cell");
    const timeCell = cells[0]!;
    // Should contain month abbreviation and time
    expect(timeCell.textContent).toMatch(/\w{3}\s+\d+/);
  });
});

describe("formatLatency", () => {
  it('ms < 1000 → "123ms"', () => {
    render(
      <RequestTable
        data={[makeRecord({ latency_ms: 123 })]}
        hasMore={false}
      />,
    );
    expect(screen.getByText("123ms")).toBeDefined();
  });

  it('ms >= 1000 → "1.2s"', () => {
    render(
      <RequestTable
        data={[makeRecord({ latency_ms: 1234 })]}
        hasMore={false}
      />,
    );
    expect(screen.getByText("1.2s")).toBeDefined();
  });
});

describe("formatTokens", () => {
  it("formats input/output tokens", () => {
    render(
      <RequestTable
        data={[makeRecord({ input_tokens: 1500, output_tokens: 3000 })]}
        hasMore={false}
      />,
    );
    // toLocaleString adds separators: "1,500 / 3,000"
    expect(screen.getByText(/1.500.*\/.*3.000/)).toBeDefined();
  });

  it('null input/output → "0 / 0"', () => {
    render(
      <RequestTable
        data={[makeRecord({ input_tokens: null, output_tokens: null })]}
        hasMore={false}
      />,
    );
    expect(screen.getByText("0 / 0")).toBeDefined();
  });
});

describe("toggleSort", () => {
  it("click same column → toggles order (desc→asc)", async () => {
    // Default sort is timestamp desc
    render(<RequestTable data={[makeRecord()]} hasMore={false} />);

    const user = userEvent.setup();
    const timeButton = screen.getByRole("button", { name: /Time/i });
    await user.click(timeButton);

    expect(mockPush).toHaveBeenCalledOnce();
    const url = mockPush.mock.calls[0]![0] as string;
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("order")).toBe("asc");
  });

  it("click different column → sets new column + desc", async () => {
    render(<RequestTable data={[makeRecord()]} hasMore={false} />);

    const user = userEvent.setup();
    const latencyButton = screen.getByRole("button", { name: /Latency/i });
    await user.click(latencyButton);

    const url = mockPush.mock.calls[0]![0] as string;
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("sort")).toBe("latency_ms");
    expect(params.get("order")).toBe("desc");
  });

  it("clears cursor, offset, prevCursors", async () => {
    mockSearchParams = new URLSearchParams("cursor=abc&offset=50&prevCursors=x,y");
    render(<RequestTable data={[makeRecord()]} hasMore={false} />);

    const user = userEvent.setup();
    const latencyButton = screen.getByRole("button", { name: /Latency/i });
    await user.click(latencyButton);

    const url = mockPush.mock.calls[0]![0] as string;
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.has("cursor")).toBe(false);
    expect(params.has("offset")).toBe(false);
    expect(params.has("prevCursors")).toBe(false);
  });
});

describe("pagination — cursor mode (sort=timestamp)", () => {
  it("next page → pushes current cursor to prevCursors, sets nextCursor", async () => {
    mockSearchParams = new URLSearchParams("cursor=cur-1");
    render(
      <RequestTable
        data={[makeRecord()]}
        hasMore={true}
        nextCursor="cur-2"
      />,
    );

    const user = userEvent.setup();
    const nextButton = screen.getByRole("button", { name: /Next/i });
    await user.click(nextButton);

    const url = mockPush.mock.calls[0]![0] as string;
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("cursor")).toBe("cur-2");
    expect(params.get("prevCursors")).toBe("cur-1");
  });

  it("prev page → pops from prevCursors stack", async () => {
    mockSearchParams = new URLSearchParams("cursor=cur-2&prevCursors=cur-0,cur-1");
    render(<RequestTable data={[makeRecord()]} hasMore={false} />);

    const user = userEvent.setup();
    const prevButton = screen.getByRole("button", { name: /Previous/i });
    await user.click(prevButton);

    const url = mockPush.mock.calls[0]![0] as string;
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("cursor")).toBe("cur-1");
    expect(params.get("prevCursors")).toBe("cur-0");
  });

  it("prev page on first page → deletes cursor param", async () => {
    mockSearchParams = new URLSearchParams("cursor=cur-1");
    render(<RequestTable data={[makeRecord()]} hasMore={false} />);

    const user = userEvent.setup();
    const prevButton = screen.getByRole("button", { name: /Previous/i });
    await user.click(prevButton);

    const url = mockPush.mock.calls[0]![0] as string;
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.has("cursor")).toBe(false);
  });

  it("canGoPrev = true when cursor param exists", () => {
    mockSearchParams = new URLSearchParams("cursor=abc");
    render(<RequestTable data={[makeRecord()]} hasMore={false} />);
    expect(screen.getByRole("button", { name: /Previous/i })).toBeDefined();
  });
});

describe("pagination — offset mode (sort=latency_ms)", () => {
  it("next page → offset += limit", async () => {
    mockSearchParams = new URLSearchParams("sort=latency_ms&offset=0&limit=20");
    render(<RequestTable data={[makeRecord()]} hasMore={true} />);

    const user = userEvent.setup();
    const nextButton = screen.getByRole("button", { name: /Next/i });
    await user.click(nextButton);

    const url = mockPush.mock.calls[0]![0] as string;
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("offset")).toBe("20");
  });

  it("prev page → offset -= limit, min 0", async () => {
    mockSearchParams = new URLSearchParams("sort=latency_ms&offset=40&limit=20");
    render(<RequestTable data={[makeRecord()]} hasMore={false} />);

    const user = userEvent.setup();
    const prevButton = screen.getByRole("button", { name: /Previous/i });
    await user.click(prevButton);

    const url = mockPush.mock.calls[0]![0] as string;
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("offset")).toBe("20");
  });

  it("offset=0 → deletes offset param", async () => {
    mockSearchParams = new URLSearchParams("sort=latency_ms&offset=20&limit=20");
    render(<RequestTable data={[makeRecord()]} hasMore={false} />);

    const user = userEvent.setup();
    const prevButton = screen.getByRole("button", { name: /Previous/i });
    await user.click(prevButton);

    const url = mockPush.mock.calls[0]![0] as string;
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.has("offset")).toBe(false);
  });

  it("canGoPrev = true when offset > 0", () => {
    mockSearchParams = new URLSearchParams("sort=latency_ms&offset=20");
    render(<RequestTable data={[makeRecord()]} hasMore={false} />);
    expect(screen.getByRole("button", { name: /Previous/i })).toBeDefined();
  });
});

describe("empty state", () => {
  it('data=[] → shows "No requests found"', () => {
    render(<RequestTable data={[]} hasMore={false} />);
    expect(screen.getByText("No requests found")).toBeDefined();
  });
});
