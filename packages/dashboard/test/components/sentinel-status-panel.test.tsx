// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("recharts", async () => {
  const { rechartsMockFactory } = await import("../helpers/recharts-mock");
  return rechartsMockFactory();
});

import { SentinelStatusPanel } from "@/app/sentinel-status-panel";
import type {
  SentinelStatus,
  SentinelReasonBuckets,
} from "@/lib/types";

function emptyBuckets(): SentinelReasonBuckets {
  return { llm401: 0, sentinel401: 0, scheduled: 0, manual: 0 };
}

function buildStatus(overrides: Partial<SentinelStatus> = {}): SentinelStatus {
  return {
    generation: 1,
    mode: "steady",
    cooldownRemainingMs: 0,
    consecutiveFailures: 0,
    forceSteadyAfterCooldown: false,
    lastRefreshInSeconds: 1500,
    lastSuccessAt: Date.now(),
    hasInflight: false,
    pendingTimer: true,
    signalScore: 0,
    counters: {
      refreshRequested: { llm401: 0, sentinel401: 0, scheduled: 1, manual: 0 },
      refreshShortCircuit: 0,
      refreshShortCircuitByReason: emptyBuckets(),
      refreshBlockedByCooldown: 0,
      refreshBlockedByCooldownByReason: emptyBuckets(),
      refreshBlockedByMinInterval: 0,
      refreshBlockedByMinIntervalByReason: emptyBuckets(),
      refreshUpstreamCalls: 1,
      refreshUpstreamCallsByReason: { llm401: 0, sentinel401: 0, scheduled: 1, manual: 0 },
      refreshSucceededTokenUpdated: 1,
      refreshSucceededTokenUpdatedByReason: { llm401: 0, sentinel401: 0, scheduled: 1, manual: 0 },
      refreshSucceededTokenSame: 0,
      refreshSucceededTokenSameByReason: emptyBuckets(),
      refreshFailed: 0,
      refreshFailedByReason: emptyBuckets(),
      refreshDiscardedStale: 0,
      llm401TokenExpired: 0,
      llm401Other: 0,
      cacheModels401: 0,
      probingEntered: 0,
    },
    ...overrides,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SentinelStatusPanel", () => {
  it("renders three panels with section title", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildStatus(),
    } as Response);

    render(<SentinelStatusPanel />);

    await waitFor(() => {
      expect(screen.getByText("Token Refresh Sentinel")).toBeTruthy();
    });
    expect(screen.getByText("401 Occurrences")).toBeTruthy();
    expect(screen.getByText("LLM-401 Auto Retry")).toBeTruthy();
    expect(screen.getByText("Live State")).toBeTruthy();
  });

  it("shows STEADY mode badge via aria-label", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildStatus(),
    } as Response);

    render(<SentinelStatusPanel />);
    await waitFor(() => {
      expect(screen.getByLabelText("Sentinel mode: STEADY")).toBeTruthy();
    });
  });

  it("shows PROBING mode badge when mode is probing", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildStatus({ mode: "probing", signalScore: 5 }),
    } as Response);

    render(<SentinelStatusPanel />);
    await waitFor(() => {
      expect(screen.getByLabelText("Sentinel mode: PROBING")).toBeTruthy();
    });
  });

  it("shows OFFLINE mode badge when mode is null", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildStatus({ mode: null }),
    } as Response);

    render(<SentinelStatusPanel />);
    await waitFor(() => {
      expect(screen.getByLabelText("Sentinel mode: OFFLINE")).toBeTruthy();
    });
  });

  it("renders error message on fetch failure (no initial data)", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    render(<SentinelStatusPanel />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load/)).toBeTruthy();
    });
  });

  it("keeps a loading status while the first poll is pending", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<SentinelStatusPanel />);
    expect(screen.getByRole("status", { name: "Loading Token Refresh Sentinel" })).toHaveAttribute("aria-busy", "true");
  });

  it("uses initialData immediately without waiting for fetch", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<SentinelStatusPanel initialData={buildStatus()} />);
    expect(screen.getByLabelText("Sentinel mode: STEADY")).toBeTruthy();
  });

  it("donut slices expose count + percent via aria-label", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(
      <SentinelStatusPanel
        initialData={buildStatus({
          counters: {
            ...buildStatus().counters,
            llm401TokenExpired: 3,
            llm401Other: 1,
            cacheModels401: 0,
          },
        })}
      />,
    );
    // Total = 4 → expired=3 (75%), other=1 (25%)
    expect(screen.getAllByLabelText(/Token Expired: 3 \(75%\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText(/Other 401: 1 \(25%\)/).length).toBeGreaterThan(0);
  });

  it("donut empty state shows hint when no 401s", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<SentinelStatusPanel initialData={buildStatus()} />);
    expect(screen.getByText("No 401s recorded")).toBeTruthy();
  });

  it("retry stack panel uses by-reason llm401 counters (ignores scheduled work)", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(
      <SentinelStatusPanel
        initialData={buildStatus({
          counters: {
            ...buildStatus().counters,
            refreshSucceededTokenUpdated: 7,
            refreshSucceededTokenUpdatedByReason: {
              llm401: 2,
              sentinel401: 0,
              scheduled: 5, // background — must NOT inflate retry stack
              manual: 0,
            },
            refreshFailedByReason: emptyBuckets(),
          },
        })}
      />,
    );

    // The Refreshed segment shows 2 (100% since other reasons are 0)
    expect(screen.getAllByLabelText(/Refreshed: 2 \(100%\)/).length).toBeGreaterThan(0);
    // Background OK cell still reflects the scheduled work
    const bgCell = screen.getByText("Background OK").parentElement;
    expect(bgCell?.textContent).toContain("5");
  });

  it("retry stack empty state shows hint", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<SentinelStatusPanel initialData={buildStatus()} />);
    expect(screen.getByLabelText("No LLM-401 retry attempts yet")).toBeTruthy();
  });

  it("CooldownBar exposes remaining duration via progressbar role", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<SentinelStatusPanel initialData={buildStatus({ cooldownRemainingMs: 5_500 })} />);
    expect(screen.getByLabelText(/Cooldown remaining: 5\.5s/)).toBeTruthy();
  });

  it("SignalGauge exposes score via aria-label", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<SentinelStatusPanel initialData={buildStatus({ signalScore: 7 })} />);
    expect(
      screen.getByLabelText(/Signal score: 7 of 10 \(threshold 5\)/),
    ).toBeTruthy();
  });

  it("handles fetch returning non-ok response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response);

    render(<SentinelStatusPanel />);
    await waitFor(() => {
      expect(screen.getByText(/HTTP 503/)).toBeTruthy();
    });
  });
});
