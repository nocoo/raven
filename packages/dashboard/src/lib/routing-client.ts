import type { UpstreamDiagnostic, UpstreamOperationDetails } from "./routing-types";

export interface ApiErrorDetail { message: string; type?: string; references?: unknown; details?: UpstreamOperationDetails }

export interface FailedRequest {
  method: string;
  path: string;
  status?: number;
  content_type?: string;
  response_body?: string;
  response_body_truncated?: boolean;
}

export class RoutingRequestError extends Error {
  constructor(message: string, public readonly request: FailedRequest, public readonly detail?: ApiErrorDetail) {
    super(message);
    this.name = "RoutingRequestError";
  }
}

export type RoutingFeedback =
  | { kind: "success"; message: string }
  | { kind: "error"; title: string; cause: unknown }
  | { kind: "diagnostic"; result: UpstreamDiagnostic };

export function apiErrorDetail(body: unknown): ApiErrorDetail | undefined {
  if (!body || typeof body !== "object" || !("error" in body)) return undefined;
  const error = body.error;
  if (typeof error === "string") return { message: error };
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error as ApiErrorDetail;
  return undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

export async function routingRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const request: FailedRequest = { method: init?.method ?? "GET", path };
  let response: Response;
  let raw: string;
  try {
    response = await fetch(path, init);
    raw = await response.text();
  } catch (cause) {
    throw new RoutingRequestError(errorMessage(cause), request);
  }
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* An HTML or empty error response is still useful diagnostic evidence. */ }
  if (!response.ok) {
    const detail = apiErrorDetail(body);
    let message = detail?.message ?? `Request failed (${response.status}).`;
    if (Array.isArray(detail?.references) && detail.references.length) {
      const names = detail.references.map((reference: unknown) => {
        if (typeof reference === "string") return reference;
        if (reference && typeof reference === "object") {
          if ("name" in reference && typeof reference.name === "string") return reference.name;
          if ("id" in reference && typeof reference.id === "string") return reference.id;
        }
        return "Referenced configuration";
      });
      message += ` Referenced by: ${names.join(", ")}.`;
    }
    throw new RoutingRequestError(message, {
      ...request, status: response.status, content_type: response.headers.get("content-type") ?? "Unknown",
      ...(!detail ? { response_body: raw.slice(0, 8192), response_body_truncated: raw.length > 8192 } : {}),
    }, detail);
  }
  return body as T;
}

export function jsonRequest(method: "POST" | "PUT" | "PATCH", body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
