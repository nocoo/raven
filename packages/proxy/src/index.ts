import { Hono } from "hono";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const app = new Hono();

// health check
app.get("/health", (c) => c.json({ status: "ok" }));

// placeholder routes — will be replaced in subsequent commits
app.get("/v1/models", (c) => c.json({ object: "list", data: [] }));

app.post("/v1/chat/completions", (c) =>
  c.json({ error: "not implemented" }, 501),
);

app.post("/v1/messages", (c) =>
  c.json({ error: "not implemented" }, 501),
);

export default {
  port: config.port,
  fetch: app.fetch,
};

export { app, config };
