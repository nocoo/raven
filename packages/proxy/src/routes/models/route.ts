import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"
import { logEmitter } from "~/util/log-emitter"
import { generateRequestId } from "~/util/id"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  const startTime = performance.now()
  const requestId = generateRequestId()

  try {
    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_start", requestId,
      msg: "GET /v1/models",
      data: { path: "/v1/models", format: "openai", stream: false },
    })

    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models = state.models?.data.map((model) => ({
      id: model.id,
      object: "model",
      type: "model",
      created: 0, // No date available from source
      created_at: new Date(0).toISOString(), // No date available from source
      owned_by: model.vendor,
      display_name: model.name,
    }))

    const latencyMs = Math.round(performance.now() - startTime)

    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_end", requestId,
      msg: `200 models ${latencyMs}ms`,
      data: {
        path: "/v1/models", format: "openai", latencyMs,
        stream: false, status: "success", statusCode: 200,
        modelCount: models?.length ?? 0,
      },
    })

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime)
    const errorMsg = error instanceof Error ? error.message : String(error)

    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `500 models ${latencyMs}ms`,
      data: {
        path: "/v1/models", format: "openai", latencyMs,
        stream: false, status: "error", statusCode: 500,
        error: errorMsg,
      },
    })

    return await forwardError(c, error)
  }
})
