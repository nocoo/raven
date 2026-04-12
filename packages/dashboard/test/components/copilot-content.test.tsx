// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// AccountContent.handleRefresh
// ---------------------------------------------------------------------------

describe("AccountContent.handleRefresh", () => {
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
  it("calls GET /api/copilot/models?refresh=true", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

    render(<CopilotModelsContent data={[makeModel()]} />);

    const user = userEvent.setup();
    const refreshButton = screen.getByRole("button", { name: /Refresh/i });
    await user.click(refreshButton);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/copilot/models?refresh=true");
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
