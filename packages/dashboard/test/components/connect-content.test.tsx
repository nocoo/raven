// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render as baseRender, screen, waitFor, within } from "@testing-library/react";
import { TooltipProvider } from "@nocoo/basalt";
import type { ReactNode } from "react";
import { userEvent } from "@testing-library/user-event";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";

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
import { fixtureRules } from "../helpers/routing-fixtures";
import { selectOption } from "../helpers/routing-interactions";
import type { ApiKeyPublic, ConnectionInfo } from "@/lib/types";

const render = (ui: ReactNode) => baseRender(ui, { wrapper: TooltipProvider });

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeConnectionInfo(): ConnectionInfo {
  return {
    base_url: "http://localhost:7024",
    endpoints: {
      chat_completions: "/v1/chat/completions",
      responses: "/v1/responses",
      messages: "/v1/messages",
      models: "/v1/models",
      embeddings: "/v1/embeddings",
    },
    models: ["claude-sonnet-4"],
    model_list: [
      { id: "claude-sonnet-4", owned_by: "anthropic" },
    ],
  };
}

function makeKey(overrides: Partial<ApiKeyPublic> = {}): ApiKeyPublic {
  return {
    id: "key-1",
    name: "test-key",
    key_prefix: "rk-abc",
    rule_id: "builtin:copilot",
    created_at: 1704067200000,
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockRefresh.mockClear();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// ApiKeysSection tests
// ---------------------------------------------------------------------------

describe("ApiKeysSection", () => {
  it("links each key name to its own statistics even when names match", () => {
    render(<ConnectContent rules={fixtureRules} keys={[makeKey(), makeKey({ id: "key/2?source=client" })]} connectionInfo={makeConnectionInfo()} />);
    const links = screen.getAllByRole("link", { name: "test-key" });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/keys?key_id=key-1");
    expect(links[1]).toHaveAttribute("href", "/keys?key_id=key%2F2%3Fsource%3Dclient");
  });

  it("groups icon-only IP access, activity and revoke actions with hover hints", async () => {
    render(<ConnectContent rules={fixtureRules} keys={[makeKey()]} connectionInfo={makeConnectionInfo()} />);
    const access = screen.getByRole("button", { name: "IP access" });
    const revoke = screen.getByRole("button", { name: "Revoke" });
    const activity = screen.getByRole("link", { name: "IP activity" });
    expect(access.closest("td")).toBe(revoke.closest("td"));
    expect(activity.closest("td")).toBe(revoke.closest("td"));
    expect(activity).toHaveAttribute("href", "/keys?key_id=key-1");
    expect(access.textContent).toBe("");
    expect(revoke.textContent).toBe("");
    const user = userEvent.setup();
    await user.hover(access);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("IP access");
    await user.unhover(access);
    await user.hover(activity);
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("IP activity"));
    await user.unhover(activity);
    await user.hover(revoke);
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Revoke"));
    await user.unhover(revoke);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValueOnce(Response.json({ enabled: false, ranges: [] }));
    await user.click(access);
    expect(await screen.findByRole("dialog")).toHaveTextContent("IP access · test-key");
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/keys/key-1/ip-policy", undefined));
  });

  it("hydrates key dates in the browser timezone when the server day differs", async () => {
    const offset = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
    const ui = <TooltipProvider><ConnectContent rules={fixtureRules} keys={[makeKey({ created_at: Date.UTC(2026, 8, 22, 21), last_used_at: 0 })]} connectionInfo={makeConnectionInfo()} /></TooltipProvider>;
    const container = document.createElement("div");
    const errors = vi.fn();
    let root: Root | undefined;
    try {
      container.innerHTML = renderToString(ui);
      expect([...container.querySelectorAll("time")].map(time => time.textContent)).toEqual(["—", "—"]);
      document.body.append(container);
      offset.mockReturnValue(-480);
      await act(async () => { root = hydrateRoot(container, ui, { onRecoverableError: errors }); });
      expect([...container.querySelectorAll("time")].map(time => time.textContent)).toEqual(["2026-09-23", "1970-01-01"]);
      expect(errors).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount());
      container.remove();
      offset.mockRestore();
    }
  });

  describe("handleAction — revoke", () => {
    it("calls POST /api/keys/{id}/revoke", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("", { status: 200 }));

      render(
        <ConnectContent
          rules={fixtureRules}
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
          rules={fixtureRules}
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
          rules={fixtureRules}
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
          rules={fixtureRules}
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
          rules={fixtureRules}
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
          rules={fixtureRules}
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
  it("shows each key binding and creates a key with the chosen non-default rule", async () => {
    render(<ConnectContent rules={fixtureRules} keys={[makeKey()]} connectionInfo={makeConnectionInfo()} />);
    expect(screen.getByRole("button", { name: "Change rule for test-key" })).toHaveTextContent("GitHub Copilot");
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Create Key" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Research laptop");
    await selectOption("Routing rule", "Working hours");
    fetchSpy.mockResolvedValueOnce(Response.json({ id: "new:key", key: "rk-fixture-once" }));
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith("/api/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Research laptop", rule_id: "rule:working-hours" }) });
    expect(screen.getByText("rk-fixture-once")).toBeVisible();
  });

  it("does not allow an unbound key when no rules are available", async () => {
    render(<ConnectContent rules={[]} keys={[]} connectionInfo={makeConnectionInfo()} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Create Key" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Unbound{Enter}");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  function renderWithDialog() {
    return render(
      <ConnectContent
          rules={fixtureRules}
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
        body: JSON.stringify({ name: "my-key", rule_id: "builtin:copilot" }),
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

  it("re-opening dialog after a successful create resets to the name-input view", async () => {
    // First create succeeds and surfaces the key.
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "1", key: "rk-first-key" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderWithDialog();
    const user = await openDialog();

    let input = screen.getByPlaceholderText(/cursor-mbp/i);
    await user.type(input, "first-key");
    await user.click(screen.getByRole("button", { name: /^Create$/i }));

    await waitFor(() => {
      expect(screen.getByText("rk-first-key")).toBeDefined();
    });

    // Close (Done) and re-open: dialog must prompt for a fresh name, not
    // re-display the stale created-key view.
    await user.click(screen.getByRole("button", { name: /Done/i }));

    await waitFor(() => {
      expect(screen.queryByText("rk-first-key")).toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /Create Key/i }));

    input = await screen.findByPlaceholderText(/cursor-mbp/i);
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("rk-first-key")).toBeNull();
  });
});

describe("routing-aware connection examples", () => {
  it("groups endpoints and examples into peer cards and discloses client guides on demand", async () => {
    render(<ConnectContent rules={fixtureRules} keys={[]} connectionInfo={makeConnectionInfo()} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: "Code" }));
    const endpoints = screen.getByRole("heading", { name: "Endpoints" }).closest<HTMLElement>("[data-basalt-surface]")!;
    const examples = screen.getByRole("heading", { name: "Code examples" }).closest<HTMLElement>("[data-basalt-surface]")!;
    expect(endpoints.parentElement).toBe(examples.parentElement);
    expect(endpoints.querySelectorAll("[data-basalt-surface]")).toHaveLength(0);
    expect(within(examples).getByRole("combobox", { name: "Model selection" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Claude Code" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Client setup guides" }));
    expect(screen.getByRole("tab", { name: "Claude Code" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Client setup guides" }));
    expect(screen.queryByRole("tab", { name: "Claude Code" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("explains the selected upstream, conversion and embeddings boundaries and switches raw model examples", async () => {
    render(<ConnectContent rules={fixtureRules} keys={[]} connectionInfo={makeConnectionInfo()} />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("tab", { name: "Code" }));
    expect(screen.queryByText(/Embeddings currently require/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Routing and protocol details" }));
    expect(screen.getByText(/same upstream selection/)).toHaveTextContent("Errors stop on that upstream");
    expect(screen.getByText(/Embeddings currently require/)).toHaveTextContent("cached embedding capability");
    expect(screen.getByText("http://localhost:7024/v1/responses")).toBeVisible();
    const curl = () => within(screen.getByRole("tabpanel", { name: "curl" })).getByRole("code");
    expect(curl()).toHaveTextContent('"model": "auto"');
    await selectOption("Model selection", "Explicit · preserve model ID");
    fireEvent.change(screen.getByRole("textbox", { name: "Explicit model ID" }), { target: { value: "vendor/it's-model" } });
    expect(curl()).toHaveTextContent('"model": "vendor/it\'\\\'\'s-model"');
    await user.click(screen.getByRole("tab", { name: "Python" }));
    expect(screen.getByRole("tabpanel", { name: "Python" })).toHaveTextContent('model="vendor/it\'s-model"');
    await user.click(screen.getByRole("tab", { name: "TypeScript" }));
    expect(screen.getByRole("tabpanel", { name: "TypeScript" })).toHaveTextContent('model: "vendor/it\'s-model"');
    expect(screen.getByRole("tabpanel", { name: "TypeScript" })).toHaveTextContent('baseURL: "http://localhost:7024"');
    await selectOption("Model selection", "auto · configured target model");
    expect(screen.queryByRole("textbox", { name: "Explicit model ID" })).toBeNull();
    expect(screen.getByRole("tabpanel", { name: "TypeScript" })).toHaveTextContent('model: "auto"');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
