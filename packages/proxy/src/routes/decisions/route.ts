import { Hono } from "hono"
import { handleGeneration } from "../generation"

export const decisionsRoutes = new Hono()

decisionsRoutes.post("/", (c) => handleGeneration(c, "decisions"))
