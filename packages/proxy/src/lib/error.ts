import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { RoutingError, type UpstreamOperationDetails } from "../core/routing-types"
import { Socks5BridgeUnavailableError } from "./socks5-bridge"

/** Protocol-layer failures from shim translators (name-matched; no lib→protocols import). */
const UPSTREAM_PROTOCOL_ERROR_NAMES = new Set([
  "ResponsesProtocolError",
  "ResponsesStreamFailedError",
])

function isUpstreamProtocolError(error: unknown): error is Error {
  return error instanceof Error && UPSTREAM_PROTOCOL_ERROR_NAMES.has(error.name)
}

/** Max upstream response body length persisted in logs / DB. */
const MAX_BODY_LENGTH = 512

export class HTTPError extends Error {
  status: number
  responseBody: string

  constructor(message: string, status: number, responseBody = "", public readonly details?: UpstreamOperationDetails) {
    super(message)
    this.status = status
    this.responseBody = responseBody
  }

  /**
   * Eagerly reads the response body so it can be logged and forwarded
   * without worrying about the one-shot `Response.body` stream.
   */
  static async fromResponse(
    message: string,
    response: Response,
  ): Promise<HTTPError> {
    const body = await response.text().catch(() => "")
    return new HTTPError(message, response.status, body)
  }
}

/** Local client input rejection — not an upstream failure. */
export class ClientInputError extends Error {
  readonly status = 400 as const
  readonly type = "invalid_request_error" as const

  constructor(message: string) {
    super(message)
    this.name = "ClientInputError"
  }
}

export class RequestCancelledError extends Error {
  readonly status = 499 as const
  readonly type = "request_cancelled" as const

  constructor(cause?: unknown) {
    super(cause instanceof Error ? cause.message : "The client cancelled the request", { cause })
    this.name = "RequestCancelledError"
  }
}

export function normalizeRequestError(error: unknown, signal?: AbortSignal): unknown {
  if (!signal?.aborted) return error
  if (error !== signal.reason && !(error instanceof Error && error.name === "AbortError")) return error
  if (signal.reason instanceof Error && signal.reason.name === "TimeoutError") return signal.reason
  return new RequestCancelledError(signal.reason)
}

function nonHttpStatus(error: unknown): number {
  if (error instanceof Error && error.name === "TimeoutError") return 504
  if (isUpstreamProtocolError(error) || error instanceof Socks5BridgeUnavailableError) return 502
  if (error instanceof Error && "code" in error && ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(String(error.code))) return 502
  return 500
}

/**
 * Extract structured error details from a caught error.
 * Used by every handler's request_end log to unify error reporting.
 */
export function extractErrorDetails(error: unknown): {
  errorDetail: string
  upstreamStatus: number | null
  statusCode: number
} {
  if (error instanceof ClientInputError || error instanceof RoutingError || error instanceof RequestCancelledError) {
    return {
      errorDetail: error.message,
      upstreamStatus: null,
      statusCode: error.status,
    }
  }
  const errorMsg = error instanceof Error ? error.message : String(error)
  const upstreamStatus =
    error instanceof HTTPError ? error.status : null
  const statusCode = upstreamStatus ?? nonHttpStatus(error)
  const body =
    error instanceof HTTPError ? error.responseBody : ""
  const errorDetail = body
    ? `${errorMsg}: ${body.slice(0, MAX_BODY_LENGTH)}`
    : errorMsg
  return { errorDetail, upstreamStatus, statusCode }
}

export async function forwardError(c: Context, error: unknown) {
  // Error details are already logged by the handler's request_end event.
  // This function only builds the HTTP response for the client.

  if (error instanceof ClientInputError || error instanceof RoutingError || error instanceof RequestCancelledError) {
    return c.json(
      {
        ...(c.req.path.includes("/messages") ? { type: "error" } : {}),
        error: { message: error.message, type: error.type },
      },
      error.status as ContentfulStatusCode,
    )
  }

  if (error instanceof HTTPError) {
    return c.json(
      {
        error: {
          message: error.responseBody || error.message,
          type: "error",
        },
      },
      error.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: "error",
      },
    },
    nonHttpStatus(error) as ContentfulStatusCode,
  )
}
