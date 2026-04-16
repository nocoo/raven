import { APP_VERSION } from "@/lib/version";
import { safeFetch } from "@/lib/proxy";

export const dynamic = "force-dynamic";

interface ProxyLive {
  status: string;
  database?: { connected: boolean; error?: string };
}

export async function GET() {
  const timestamp = new Date().toISOString();
  const uptime = Math.floor(process.uptime());

  let database: { connected: boolean; error?: string } = { connected: false };
  try {
    const result = await safeFetch<ProxyLive>("/api/live");
    if (result.ok) {
      database = result.data.database ?? { connected: true };
    } else {
      database = {
        connected: false,
        error: result.error.replace(/\bok\b/gi, "***"),
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    database = { connected: false, error: msg.replace(/\bok\b/gi, "***") };
  }

  const healthy = database.connected;
  return Response.json(
    {
      status: healthy ? "ok" : "error",
      version: APP_VERSION,
      component: "dashboard",
      timestamp,
      uptime,
      database,
    },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
