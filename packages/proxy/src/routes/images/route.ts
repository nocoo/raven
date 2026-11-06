import { Hono } from "hono"
import { handleGeneration } from "../generation"

export const imagesRoutes = new Hono()

imagesRoutes.post("/", (c) => handleGeneration(c, "images"))
