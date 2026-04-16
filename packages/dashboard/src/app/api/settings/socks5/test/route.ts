import { NextResponse } from "next/server";

const PROXY_URL = process.env.RAVEN_PROXY_URL ?? "http://localhost:7024";
const API_KEY = process.env.RAVEN_INTERNAL_KEY ?? process.env.RAVEN_API_KEY ?? "";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (API_KEY) {
      headers["Authorization"] = `Bearer ${API_KEY}`;
    }

    const res = await fetch(`${PROXY_URL}/api/settings/socks5/test`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });

    // Forward the proxy's JSON body as-is (preserves structured error + latencyMs)
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
