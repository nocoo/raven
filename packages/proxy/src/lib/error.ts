import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

/** Max upstream response body length persisted in logs / DB. */
const MAX_BODY_LENGTH = 512

export class HTTPError extends Error {
  status: number
  responseBody: string

  constructor(message: string, status: number, responseBody: string = "") {
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

/**
 * Extract structured error details from a caught error.
 * Used by every handler's request_end log to unify error reporting.
 */
export function extractErrorDetails(error: unknown): {
  errorDetail: string
  upstreamStatus: number | null
  statusCode: number
} {
  const errorMsg = error instanceof Error ? error.message : String(error)
  const upstreamStatus =
    error instanceof HTTPError ? error.status : null
  const statusCode = upstreamStatus ?? 502
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
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
