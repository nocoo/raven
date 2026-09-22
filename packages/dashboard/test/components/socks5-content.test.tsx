// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Socks5Content, type Socks5Data } from "@/app/settings/socks5-content";
import { selectOption } from "../helpers/routing-interactions";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
afterEach(() => vi.restoreAllMocks());

describe("SOCKS5 provider policies", () => {
  it("keeps the initial connection editable and reveals optional authentication and policies without writes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
    render(<Socks5Content data={{ enabled: false, host: null, port: null, username: null, hasPassword: false, copilotPolicy: "default", bridgeStatus: "stopped", bridgePort: null, providerPolicies: [] }} />);
    expect(screen.getByRole("textbox", { name: "Host" })).toBeVisible();
    expect(screen.getByRole("switch", { name: "Use SOCKS5 proxy" })).not.toBeChecked();
    expect(screen.queryByLabelText(/Username/)).toBeNull();
    expect(screen.queryByRole("combobox", { name: "GitHub Copilot proxy policy" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Authentication (optional)" }));
    expect(screen.getByLabelText(/Username/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Upstream policies" }));
    expect(screen.getByRole("combobox", { name: "GitHub Copilot proxy policy" })).toBeVisible();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("edits custom policies independently of Copilot without model discovery metadata", async () => {
    const data: Socks5Data = {
      enabled: true, host: "proxy.fixture.invalid", port: 1080,
      username: null, hasPassword: true, copilotPolicy: "default",
      bridgeStatus: "running", bridgePort: 1081,
      providerPolicies: [
        { id: "custom:inherited", name: "Inherited gateway", use_socks5: null },
        { id: "custom:proxied", name: "Proxied gateway", use_socks5: 1 },
        { id: "custom:direct", name: "Direct gateway", use_socks5: 0 },
        { id: "custom:unchanged", name: "Unchanged gateway", use_socks5: null },
      ],
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true }));
    render(<Socks5Content data={data} />);
    expect(screen.getByRole("combobox", { name: "GitHub Copilot proxy policy" })).toHaveTextContent("Default (On)");
    expect(screen.getByRole("combobox", { name: "Inherited gateway proxy policy" })).toHaveTextContent("Default (Off)");
    expect(screen.getByRole("combobox", { name: "Proxied gateway proxy policy" })).toHaveTextContent("Force On");
    expect(screen.getByRole("combobox", { name: "Direct gateway proxy policy" })).toHaveTextContent("Force Off");
    expect(fetchSpy).not.toHaveBeenCalled();

    await selectOption("GitHub Copilot proxy policy", "Force Off");
    await selectOption("Inherited gateway proxy policy", "Force On");
    await selectOption("Proxied gateway proxy policy", "Force Off");
    await selectOption("Direct gateway proxy policy", "Default (Off)");
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "Save" }));

    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith("/api/settings/socks5", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true, host: "proxy.fixture.invalid", port: 1080,
        username: null, copilotPolicy: "off",
        providerPolicies: [
          { id: "custom:inherited", use_socks5: 1 },
          { id: "custom:proxied", use_socks5: 0 },
          { id: "custom:direct", use_socks5: null },
        ],
      }),
    });
    expect(await screen.findByText("Settings saved")).toBeVisible();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
