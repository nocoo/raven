import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { dispatchImageGeneration } from "../../composition/images"
import { buildContext } from "../../core/context"
import { HTTPError } from "../../lib/error"
import { logEmitter } from "../../util/log-emitter"

export function createImageRoutes(dispatch = dispatchImageGeneration): Hono {
  const routes = new Hono()
  routes.use(
    "*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            error: {
              message: "Image request body exceeds the 1 MiB limit.",
              type: "invalid_request_error",
            },
          },
          413,
        ),
    }),
  )

  routes.post("/", async (c) => {
    const ctx = buildContext(c, "openai")
    const data = {
      path: ctx.path,
      format: "openai",
      stream: false,
      accountName: ctx.accountName,
    }
    logEmitter.emitLog({
      ts: Date.now(),
      level: "info",
      type: "request_start",
      requestId: ctx.requestId,
      msg: "Image generation request",
      data,
    })
    let response: Response
    try {
      let payload: unknown
      try {
        payload = await c.req.json()
      } catch {
        throw new HTTPError("Request body must be valid JSON.", 400)
      }
      response = await dispatch(payload, c.req.raw.signal)
    } catch (error) {
      // Only local HTTPError messages are safe. Fetch/SOCKS errors can contain
      // credentials or URLs. Upstream bodies are returned, never thrown/logged.
      const status = error instanceof HTTPError ? error.status : 502
      const message =
        error instanceof HTTPError
          ? error.message
          : "Image upstream request failed. Check the configured upstream and connection."
      response = c.json(
        {
          error: {
            message,
            type: status === 400 ? "invalid_request_error" : "api_error",
          },
        },
        status as ContentfulStatusCode,
      )
    }
    logEmitter.emitLog({
      ts: Date.now(),
      level: response.ok ? "info" : "error",
      type: "request_end",
      requestId: ctx.requestId,
      msg: `Image generation completed (${response.status})`,
      data: {
        ...data,
        statusCode: response.status,
        status: response.ok ? "success" : "error",
        latencyMs: Math.round(performance.now() - ctx.startTime),
      },
    })
    return response
  })
  return routes
}

export const imageRoutes = createImageRoutes()
