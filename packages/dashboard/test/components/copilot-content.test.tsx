// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mockRefresh }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { AccountContent } from "@/app/copilot/account/account-content";
import { CopilotModelsContent } from "@/app/copilot/models/models-content";
import { CopyButton } from "@/components/copy-button";
import type { CopilotUser, CopilotModel } from "@/lib/types";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<CopilotUser> = {}): CopilotUser {
  return {
    login: "test-user",
    copilot_plan: "business",
    ...overrides,
  };
}

function makeModel(overrides: Partial<CopilotModel> = {}): CopilotModel {
  return {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    version: "2025-01-01",
    model_picker_enabled: true,
    capabilities: {
      family: "claude",
      type: "chat",
      tokenizer: "cl100k",
      limits: { max_context_window_tokens: 200000, max_output_tokens: 8192 },
    },
    vendor: "anthropic",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockRefresh.mockClear();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// AccountContent.handleRefresh
// ---------------------------------------------------------------------------

describe("AccountContent.handleRefresh", () => {
  it("groups account metadata behind one disclosure without repeating capabilities", async () => {
    render(<AccountContent data={makeUser({ chat_enabled: true, analytics_tracking_id: "fixture-tracking", endpoints: { api: "https://fixture.invalid/api" }, fixture_property: "fixture-extra" })} />);
    expect(screen.getByRole("heading", { name: "Account" })).toBeVisible();
    expect(screen.getAllByText("Chat")).toHaveLength(1);
    expect(screen.queryByText("fixture-tracking")).toBeNull();
    expect(screen.queryByText("fixture-extra")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Endpoints and properties" }));
    expect(screen.getByText("fixture-tracking")).toBeVisible();
    expect(screen.getByText("fixture-extra")).toBeVisible();
    expect(screen.getByText("https://fixture.invalid/api")).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls GET /api/copilot/user?refresh=true", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

    render(<AccountContent data={makeUser()} />);

    const user = userEvent.setup();
    const refreshButton = screen.getByRole("button", { name: /Refresh/i });
    await user.click(refreshButton);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/copilot/user?refresh=true");
    });
  });

  it("calls router.refresh() on success", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

    render(<AccountContent data={makeUser()} />);

    const user = userEvent.setup();
    const refreshButton = screen.getByRole("button", { name: /Refresh/i });
    await user.click(refreshButton);

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
  });

  it("fetch failure → shows error feedback to user", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network error"));

    render(<AccountContent data={makeUser()} />);

    const user = userEvent.setup();
    const refreshButton = screen.getByRole("button", { name: /Refresh/i });
    await user.click(refreshButton);

    await waitFor(() => {
      expect(screen.getByText(/network error|failed|error/i)).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// CopilotModelsContent.handleRefresh
// ---------------------------------------------------------------------------

describe("CopilotModelsContent.handleRefresh", () => {
  it("renders sparse cached metadata without fabricating capability, limit or picker readiness", () => {
    render(<CopilotModelsContent data={[{ id: "sparse-a", vendor: "fixture", supported_endpoints: ["/responses"] }, { id: "sparse-b", vendor: "fixture", capabilities: { type: "chat" } }]} />);
    const first = within(screen.getByRole("row", { name: /sparse-a/ }));
    expect(first.getAllByText("Unknown")).toHaveLength(2);
    expect(first.getAllByText("—")).toHaveLength(5);
    expect(screen.getByText("sparse-b")).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();

    const unknownBadge = screen.getByRole("row", { name: /sparse-a/ }).querySelector("[data-tag-color]");
    expect(unknownBadge).toHaveTextContent("Unknown");
    expect(unknownBadge).not.toHaveAttribute("style");
  });

  it("uses stable package-owned hash colors and sorts each vendor table by type then id", () => {
    render(<CopilotModelsContent data={[
      makeModel({ id: "z-chat-b", vendor: "zeta", capabilities: { family: "z", type: "chat" } }),
      makeModel({ id: "z-chat-a", vendor: "zeta", capabilities: { family: "z", type: "chat" } }),
      makeModel({ id: "z-image-a", vendor: "zeta", capabilities: { family: "z", type: "image" } }),
      makeModel({ id: "z-audio-a", vendor: "zeta", capabilities: { family: "z", type: "audio" } }),
      makeModel({ id: "a-image-b", vendor: "alpha", capabilities: { family: "a", type: "image" } }),
      makeModel({ id: "a-chat-a", vendor: "alpha", capabilities: { family: "a", type: "chat" } }),
    ]} />);

    const vendorNames = screen.getAllByRole("heading", { level: 2 }).map(heading => heading.textContent?.trim());
    expect(vendorNames).toEqual(["alpha", "zeta"]);

    const idsInVendor = (vendor: string) => {
      const heading = screen.getByRole("heading", { name: vendor });
      const table = heading.parentElement?.parentElement?.querySelector("table");
      expect(table).not.toBeNull();
      return within(table as HTMLTableElement).getAllByRole("row").slice(1).map(row => row.querySelector("td")?.textContent?.trim());
    };

    expect(idsInVendor("alpha")).toEqual(["a-chat-a", "a-image-b"]);
    expect(idsInVendor("zeta")).toEqual(["z-audio-a", "z-chat-a", "z-chat-b", "z-image-a"]);

    const chatBadges = screen.getAllByText("chat").filter(element => element.hasAttribute("data-tag-color"));
    expect(chatBadges).toHaveLength(3);
    const colors = chatBadges.map(badge => badge.getAttribute("data-tag-color"));
    expect(new Set(colors).size).toBe(1);
    chatBadges.forEach(badge => {
      expect(badge).not.toHaveAttribute("style");
      expect(badge.className).toContain("bg-basalt-tag-");
    });
  });

  it("explicitly refreshes the persistent Copilot catalog", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

    render(<CopilotModelsContent data={[makeModel()]} />);

    const user = userEvent.setup();
    const refreshButton = screen.getByRole("button", { name: /Refresh/i });
    await user.click(refreshButton);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/upstreams/builtin%3Acopilot/models/refresh", { method: "POST" });
    });
  });

  it("calls router.refresh() on success", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

    render(<CopilotModelsContent data={[makeModel()]} />);

    const user = userEvent.setup();
    const refreshButton = screen.getByRole("button", { name: /Refresh/i });
    await user.click(refreshButton);

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
  });

  it("fetch failure → shows error feedback to user", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network error"));

    render(<CopilotModelsContent data={[makeModel()]} />);

    const user = userEvent.setup();
    const refreshButton = screen.getByRole("button", { name: /Refresh/i });
    await user.click(refreshButton);

    await waitFor(() => {
      expect(screen.getByText(/network error|failed|error/i)).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// CopyButton — clipboard error handling
// ---------------------------------------------------------------------------

describe("CopyButton", () => {
  it("clipboard.writeText throws → fails gracefully, no unhandled rejection", async () => {
    // Use fireEvent instead of userEvent to avoid userEvent overriding clipboard
    const { fireEvent } = await import("@testing-library/react");

    // Mock clipboard.writeText to throw
    const originalClipboard = navigator.clipboard;
    const clipboardMock = {
      writeText: vi.fn().mockRejectedValueOnce(new Error("Clipboard blocked")),
      readText: vi.fn(),
      read: vi.fn(),
      write: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    Object.defineProperty(navigator, "clipboard", {
      value: clipboardMock,
      writable: true,
      configurable: true,
    });

    render(<CopyButton value="test-value" />);

    const copyButton = screen.getByRole("button", { name: /Copy to clipboard/i });

    // Should not throw unhandled rejection
    fireEvent.click(copyButton);

    // Wait for async handler to settle
    await waitFor(() => {
      expect(clipboardMock.writeText).toHaveBeenCalledWith("test-value");
    });

    // Restore
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      writable: true,
      configurable: true,
    });
  });
});
