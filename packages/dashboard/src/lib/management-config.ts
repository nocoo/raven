import { isIP } from "node:net";

export function managementConfig(): { url: string; key: string } {
  const parsed = new URL(process.env.RAVEN_PROXY_URL ?? "http://127.0.0.1:7024");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (!local || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("RAVEN_PROXY_URL must be a loopback origin");
  const key = process.env.RAVEN_INTERNAL_KEY;
  if (!key) throw new Error("RAVEN_INTERNAL_KEY is required for management");
  return { url: parsed.origin.replace("localhost", "127.0.0.1"), key };
}
