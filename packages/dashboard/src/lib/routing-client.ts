export interface ApiErrorDetail { message: string; type?: string; references?: unknown }

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
  const response = await fetch(path, init);
  const body: unknown = await response.json().catch(() => null);
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
    throw new Error(message);
  }
  return body as T;
}

export function jsonRequest(method: "POST" | "PUT" | "PATCH", body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
