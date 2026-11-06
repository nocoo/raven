import { Hono } from "hono"
import { handleGeneration } from "../generation"

export const imagesRoutes = new Hono()
export const imageEditsRoutes = new Hono()

imagesRoutes.post("/", (c) => handleGeneration(c, "images"))
imageEditsRoutes.post("/", (c) => handleGeneration(c, "images", "/v1/images/edits"))
