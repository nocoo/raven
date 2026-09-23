// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LogsContent } from "@/app/logs/logs-content";
import type { LogEvent } from "@/hooks/use-log-stream";

const stream = vi.hoisted(() => ({ events: [] as LogEvent[] }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/use-log-stream", () => ({ useLogStream: () => ({ ...stream, eventSeq: 1, connected: true, paused: false, setPaused: vi.fn(), clear: vi.fn(), setLevel: vi.fn() }) }));
vi.mock("@/app/logs/logs-stats", () => ({ LogsStats: () => null }));

describe("Logs request badges", () => {
  it.each([
    ["responses", "responses", "copilot-responses", "Native"],
    ["openai", "openai", "copilot-openai-direct", "Native"],
    ["anthropic", "anthropic", "copilot-native", "Native"],
    ["anthropic", "openai", "custom-openai", "Translated"],
    ["openai", "responses", "copilot-chat-via-responses", "Translated"],
    ["responses", "anthropic", "protocol-converted", "Translated"],
  ])("renders %s → %s as %s / %s", (format, upstreamFormat, strategy, label) => {
    stream.events = [
      { ts: 1, type: "request_start", level: "info", requestId: "fixture", msg: "start", data: { path: "/v1/responses", format, model: "gpt-fixture" } },
      { ts: 2, type: "request_end", level: "info", requestId: "fixture", msg: "end", data: { format, upstreamFormat, strategy, status: "success" } },
    ];
    render(<LogsContent />);
    expect(screen.getByText(label, { exact: true })).toBeVisible();
    expect(screen.queryByText(strategy, { exact: true })).toBeNull();
  });

  it("labels incomplete and rejected requests without claiming native forwarding", () => {
    stream.events = [{ ts: 1, type: "request_start", level: "info", requestId: "fixture", msg: "start", data: { format: "responses" } }];
    const { rerender } = render(<LogsContent />);
    expect(screen.getByText("Pending path")).toBeVisible();
    stream.events = [...stream.events, { ts: 2, type: "request_end", level: "error", requestId: "fixture", msg: "rejected", data: { status: "error" } }];
    rerender(<LogsContent />);
    expect(screen.getByText("Unknown path")).toBeVisible();
    expect(screen.queryByText("Native")).toBeNull();
  });
});
