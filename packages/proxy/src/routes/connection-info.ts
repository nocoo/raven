import { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { projectCatalog } from "../db/catalog"

export interface ConnectionInfoRouteOptions {
  db: Database
  port: number
  baseUrl: string | null
}

export function createConnectionInfoRoute(opts: ConnectionInfoRouteOptions): Hono {
  const route = new Hono()
  route.get("/connection-info", (c) => {
    const models = projectCatalog(opts.db)
    return c.json({
      base_url: opts.baseUrl || `http://localhost:${opts.port}`,
      endpoints: {
        chat_completions: "/v1/chat/completions",
        messages: "/v1/messages",
        responses: "/v1/responses",
        models: "/v1/models",
        embeddings: "/v1/embeddings",
      },
      models: models.map((model) => model.id),
      model_list: models.map((model) => ({ id: model.id, owned_by: model.owned_by })),
    })
  })
  return route
}
