export interface Config {
  port: number;
  apiKey: string;
  tokenPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(): Config {
  const port = parseInt(process.env.RAVEN_PORT ?? "7033", 10);
  const apiKey = process.env.RAVEN_API_KEY ?? "";
  const tokenPath = process.env.RAVEN_TOKEN_PATH ?? "data/github_token";
  const logLevel = (process.env.RAVEN_LOG_LEVEL ?? "info") as Config["logLevel"];

  if (!apiKey) {
    console.warn(
      "[config] RAVEN_API_KEY is not set — proxy will accept any request",
    );
  }

  return { port, apiKey, tokenPath, logLevel };
}
