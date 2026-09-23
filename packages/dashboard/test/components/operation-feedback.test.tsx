// @vitest-environment jsdom
import { Toaster, toast } from "@nocoo/basalt";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationFeedback } from "@/components/routing/operation-feedback";
import { RoutingRequestError } from "@/lib/routing-client";
import { makeDiagnostic } from "../helpers/routing-fixtures";

afterEach(() => { toast.dismiss(); vi.restoreAllMocks(); });

describe("operation feedback", () => {
  it("keeps inline success feedback beside its operation without emitting a toast", () => {
    const success = vi.spyOn(toast, "success");
    render(<OperationFeedback feedback={{ kind: "success", message: "Models refreshed." }} inlineSuccess />);
    expect(screen.getByRole("status")).toHaveTextContent("Models refreshed.");
    expect(success).not.toHaveBeenCalled();
  });

  it("shows the actual unexpected answer and opens the native response for debugging", async () => {
    const user = userEvent.setup({ delay: null });
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const result = makeDiagnostic({ answer: "I can help you debug this connection.", expected_pong: false, answer_truncated: true });
    render(<OperationFeedback feedback={{ kind: "diagnostic", result }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Request succeeded · unexpected answer");
    expect(screen.getByLabelText("Model reply")).toHaveTextContent(result.answer);
    expect(screen.getByText(/Reply excerpt/)).toBeVisible();
    expect(screen.getByLabelText("Response body")).toHaveTextContent('"content":"pong"');
    expect(screen.getByText("fixture-request")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));
    expect(JSON.parse(copy.mock.lastCall![0])).toMatchObject({ details: result.details });
  });

  it("makes empty reasoning-only Responses output explicit instead of displaying an empty success box", () => {
    const result = makeDiagnostic({ model: "glm-5.3", protocol: "responses", answer: "", expected_pong: false, details: { operation: "generation_test", upstream_status: 200, response_status: "incomplete", finish_reason: "max_output_tokens", response_body: '{"output":[{"type":"reasoning"}],"incomplete_details":{"reason":"max_output_tokens"}}', response_body_truncated: true } });
    render(<OperationFeedback feedback={{ kind: "diagnostic", result }} />);
    expect(screen.getByRole("status")).toHaveTextContent("no text returned");
    expect(screen.queryByLabelText("Model reply")).toBeNull();
    expect(screen.getByText(/no visible text/)).toBeVisible();
    expect(screen.getByText("incomplete", { exact: true })).toBeVisible();
    expect(screen.getByLabelText("Response body")).toHaveTextContent("reasoning");
    expect(screen.getByText(/remaining content omitted/)).toBeVisible();
  });

  it("keeps expected replies concise while leaving evidence available by keyboard", async () => {
    const user = userEvent.setup({ delay: null });
    const result = makeDiagnostic({ details: { operation: "generation_test", url: "https://fixture.invalid/messages", response_body: "" } });
    render(<OperationFeedback feedback={{ kind: "diagnostic", result }} />);
    expect(screen.getByText("Received pong")).toBeVisible();
    expect(screen.getByLabelText("Model reply")).toHaveTextContent("pong");
    expect(screen.queryByLabelText("Response body")).toBeNull();
    screen.getByRole("button", { name: "Response details" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Response body")).toHaveTextContent("(empty response body)");
  });

  it("distinguishes the management failure from a successful but invalid provider response", async () => {
    const user = userEvent.setup({ delay: null });
    const details = { operation: "model_discovery" as const, method: "GET", url: "https://fixture.invalid/v1/models", upstream_status: 200, content_type: "application/json", response_body: '{"models":[]}' };
    const error = new RoutingRequestError("Model discovery did not return a data array", { method: "POST", path: "/api/upstreams/fixture/models/refresh", status: 503 }, { message: "Invalid catalog", type: "catalog_refresh_failed", details });
    render(<OperationFeedback feedback={{ kind: "error", title: "Model refresh failed", cause: error }} />);
    const banner = within(screen.getByRole("alert"));
    expect(banner.getByText("Model refresh failed")).toBeVisible();
    expect(banner.getByText("Upstream HTTP 200")).toBeVisible();
    await user.click(banner.getByRole("button", { name: "Response details" }));
    expect(banner.getByText("503", { exact: true })).toBeVisible();
    expect(banner.getByText("GET https://fixture.invalid/v1/models")).toBeVisible();
    expect(banner.getByLabelText("Response body")).toHaveTextContent('"models":[]');
  });

  it("presents empty HTML proxy failures and transport failures without inventing upstream evidence", async () => {
    const user = userEvent.setup({ delay: null });
    const { rerender } = render(<OperationFeedback feedback={{ kind: "error", title: "Save failed", cause: new RoutingRequestError("Bad gateway", { method: "PUT", path: "/api/upstreams/fixture", status: 502, content_type: "text/html", response_body: "<h1>Gateway unavailable</h1>", response_body_truncated: true }) }} />);
    await user.click(screen.getByRole("button", { name: "Response details" }));
    expect(screen.getByText("Proxy response")).toBeVisible();
    expect(screen.getByLabelText("Response body")).toHaveTextContent("<h1>Gateway unavailable</h1>");
    expect(screen.queryByRole("heading", { name: "Gateway unavailable" })).toBeNull();
    rerender(<OperationFeedback feedback={{ kind: "error", title: "Save failed", cause: new RoutingRequestError("Connection refused", { method: "PUT", path: "/api/upstreams/fixture" }) }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Connection refused");
    expect(screen.queryByText("Upstream HTTP status")).toBeNull();
    expect(screen.queryByLabelText("Response body")).toBeNull();
  });

  it("shows local validation, then uses a transient global toast for success", async () => {
    render(<Toaster duration={50} />);
    const success = vi.spyOn(toast, "success");
    const { rerender } = render(<OperationFeedback feedback={null} />);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<OperationFeedback feedback={{ kind: "error", title: "Rule could not be saved", cause: new Error("Give this rule a name.") }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Give this rule a name.");
    expect(screen.queryByRole("button", { name: "Response details" })).toBeNull();
    const feedback = { kind: "success" as const, message: "Rule saved." };
    rerender(<OperationFeedback feedback={feedback} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await screen.findByText("Rule saved.")).toBeVisible();
    expect(screen.getByText("Rule saved.").closest("[data-sonner-toast]")).not.toBeNull();
    rerender(<OperationFeedback feedback={feedback} />);
    expect(success).toHaveBeenCalledTimes(1);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    await waitFor(() => expect(screen.queryByText("Rule saved.")).toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
  });
});
