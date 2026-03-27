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
// Mock clipboard (configurable so @testing-library/user-event can also redefine)
// ---------------------------------------------------------------------------

const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: mockWriteText },
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { ConnectContent } from "@/app/connect/connect-content";
import type { ApiKeyPublic, ConnectionInfo } from "@/lib/types";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeConnectionInfo(): ConnectionInfo {
  return {
    base_url: "http://localhost:7033",
    endpoints: {
      chat_completions: "/v1/chat/completions",
      messages: "/v1/messages",
      models: "/v1/models",
      embeddings: "/v1/embeddings",
    },
    models: ["claude-sonnet-4"],
  };
}

function makeKey(overrides: Partial<ApiKeyPublic> = {}): ApiKeyPublic {
  return {
    id: "key-1",
    name: "test-key",
    key_prefix: "rk-abc",
    created_at: 1704067200000,
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockRefresh.mockClear();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// ApiKeysSection tests
// ---------------------------------------------------------------------------

describe("ApiKeysSection", () => {
  describe("handleAction — revoke", () => {
    it("calls POST /api/keys/{id}/revoke", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

      render(
        <ConnectContent
          keys={[makeKey({ id: "key-abc" })]}
          connectionInfo={makeConnectionInfo()}
        />,
      );

      const user = userEvent.setup();
      const revokeButton = screen.getByRole("button", { name: /^Revoke$/i });
      await user.click(revokeButton);

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith("/api/keys/key-abc/revoke", { method: "POST" });
      });
    });

    it("calls router.refresh() on success", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

      render(
        <ConnectContent
          keys={[makeKey()]}
          connectionInfo={makeConnectionInfo()}
        />,
      );

      const user = userEvent.setup();
      const revokeButton = screen.getByRole("button", { name: /^Revoke$/i });
      await user.click(revokeButton);

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalled();
      });
    });

    it("fetch failure → shows error feedback to user", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("network error"));

      render(
        <ConnectContent
          keys={[makeKey()]}
          connectionInfo={makeConnectionInfo()}
        />,
      );

      const user = userEvent.setup();
      const revokeButton = screen.getByRole("button", { name: /^Revoke$/i });
      await user.click(revokeButton);

      // After bug fix: should show error to user, NOT throw unhandled
      await waitFor(() => {
        expect(screen.getByText(/network error|failed/i)).toBeDefined();
      });
    });
  });

  describe("handleAction — delete", () => {
    it("calls DELETE /api/keys/{id}", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

      render(
        <ConnectContent
          keys={[makeKey({ id: "key-xyz", revoked_at: 1704153600000 })]}
          connectionInfo={makeConnectionInfo()}
        />,
      );

      const user = userEvent.setup();
      const deleteButton = screen.getByRole("button", { name: /^Delete$/i });
      await user.click(deleteButton);

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith("/api/keys/key-xyz", { method: "DELETE" });
      });
    });

    it("calls router.refresh() on success", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

      render(
        <ConnectContent
          keys={[makeKey({ revoked_at: 1704153600000 })]}
          connectionInfo={makeConnectionInfo()}
        />,
      );

      const user = userEvent.setup();
      const deleteButton = screen.getByRole("button", { name: /^Delete$/i });
      await user.click(deleteButton);

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalled();
      });
    });

    it("fetch failure → shows error feedback to user", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("connection refused"));

      render(
        <ConnectContent
          keys={[makeKey({ revoked_at: 1704153600000 })]}
          connectionInfo={makeConnectionInfo()}
        />,
      );

      const user = userEvent.setup();
      const deleteButton = screen.getByRole("button", { name: /^Delete$/i });
      await user.click(deleteButton);

      // After bug fix: should show error to user
      await waitFor(() => {
        expect(screen.getByText(/connection refused|failed/i)).toBeDefined();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// CreateKeyDialog tests
// ---------------------------------------------------------------------------

describe("CreateKeyDialog", () => {
  function renderWithDialog() {
    return render(
      <ConnectContent
        keys={[]}
        connectionInfo={makeConnectionInfo()}
      />,
    );
  }

  async function openDialog() {
    const user = userEvent.setup();
    const createButton = screen.getByRole("button", { name: /Create Key/i });
    await user.click(createButton);
    return user;
  }

  it("submit → calls POST /api/keys with name", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "1", key: "rk-full-key" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderWithDialog();
    const user = await openDialog();

    const input = screen.getByPlaceholderText(/cursor-mbp/i);
    await user.type(input, "my-key");

    const submitButton = screen.getByRole("button", { name: /^Create$/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "my-key" }),
      });
    });
  });

  it("success → shows created key for copy", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "1", key: "rk-full-key-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderWithDialog();
    const user = await openDialog();

    const input = screen.getByPlaceholderText(/cursor-mbp/i);
    await user.type(input, "my-key");

    const submitButton = screen.getByRole("button", { name: /^Create$/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("rk-full-key-123")).toBeDefined();
    });
  });

  it("res.ok=false → shows actual error message from response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Key name already exists" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderWithDialog();
    const user = await openDialog();

    const input = screen.getByPlaceholderText(/cursor-mbp/i);
    await user.type(input, "dup-key");

    const submitButton = screen.getByRole("button", { name: /^Create$/i });
    await user.click(submitButton);

    // After bug fix: should show actual error from response, not generic fallback
    await waitFor(() => {
      expect(screen.getByText("Key name already exists")).toBeDefined();
    });
  });

  it('fetch throws → shows "Failed to create key"', async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network failure"));

    renderWithDialog();
    const user = await openDialog();

    const input = screen.getByPlaceholderText(/cursor-mbp/i);
    await user.type(input, "my-key");

    const submitButton = screen.getByRole("button", { name: /^Create$/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Failed to create key")).toBeDefined();
    });
  });
});
