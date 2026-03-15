import { Hono } from "hono";

const MODELS = [
  "claude-sonnet-4-20250514",
  "claude-3.5-sonnet",
  "claude-haiku-4.5",
  "gpt-5-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "o4-mini",
  "o3-mini",
];

const modelsResponse = {
  object: "list" as const,
  data: MODELS.map((id) => ({
    id,
    object: "model" as const,
    created: 1700000000,
    owned_by: "github-copilot",
  })),
};

export const modelsRoute = new Hono();

modelsRoute.get("/models", (c) => c.json(modelsResponse));
