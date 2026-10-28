import { Hono } from "hono"
import { handleGeneration } from "../generation"

export const systemoneRoutes = new Hono()

systemoneRoutes.post("/", (c) => handleGeneration(c, "systemone"))
