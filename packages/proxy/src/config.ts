export interface Config {
  port: number;
  tokenPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(): Config {
  const port = parseInt(process.env.RAVEN_PORT ?? "7033", 10);
  const tokenPath = process.env.RAVEN_TOKEN_PATH ?? "data/github_token";
  const logLevel = (process.env.RAVEN_LOG_LEVEL ?? "info") as Config["logLevel"];

  return { port, tokenPath, logLevel };
}
