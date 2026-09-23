// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NativeProtocolStatus } from "@/components/routing/native-protocol-status";
import { nativeProtocolRows } from "@/lib/routing-model";
import { makeCopilot, makeUpstream } from "../helpers/routing-fixtures";

vi.mock("../../../proxy/src/core/protocol-evidence", () => ({ nativeProtocolEvidence: [
  { upstream: "copilot", model: "verified-fixture", protocol: "responses", stream: false, tested_at: "2026-09-23T00:00:00Z", revision: "a".repeat(40), case_id: "verified-fixture.responses.text.json" },
] }));

describe("native protocol evidence disclosure", () => {
  it("separates verified JSON from unknown SSE without claiming full feature coverage", () => {
    render(<NativeProtocolStatus upstream={makeCopilot({ models: [] })} model="verified-fixture" />);
    expect(screen.getByText("Responses native")).toBeVisible();
    expect(screen.getByText("JSON: Verified text")).toHaveAttribute("title", expect.stringContaining("verified-fixture.responses.text.json"));
    expect(screen.getByText("SSE: Unknown")).toBeVisible();
  });

  it("labels catalog and custom declarations unverified independently", () => {
    render(<NativeProtocolStatus upstream={makeUpstream({ format: "responses" })} model="verified-fixture" />);
    const group = within(screen.getByLabelText("verified-fixture native protocols"));
    expect(group.getByText("JSON: Unverified")).toBeVisible();
    expect(group.getByText("SSE: Unverified")).toBeVisible();
    expect(nativeProtocolRows(makeCopilot({ models: [{ id: "catalog", supported_endpoints: ["/messages"] }] }), "catalog")[0]?.label).toBe("Messages");
  });

  it("does not invent a native protocol for missing upstreams or empty capabilities", () => {
    expect(nativeProtocolRows(undefined, "missing")).toEqual([]);
    render(<NativeProtocolStatus upstream={makeCopilot({ models: [] })} model="missing" />);
    expect(screen.getByText("Native protocol unknown.")).toBeVisible();
  });
});
