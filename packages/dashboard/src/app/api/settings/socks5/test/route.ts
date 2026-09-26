import { managementConfig } from "@/lib/management-config";
import { NextResponse } from "next/server";


export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { url: PROXY_URL, key: API_KEY } = managementConfig();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (API_KEY) {
      headers.Authorization = `Bearer ${API_KEY}`;
    }

    const res = await fetch(`${PROXY_URL}/api/settings/socks5/test`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store", redirect: "error",
    });

    // Forward the proxy's JSON body as-is (preserves structured error + latencyMs)
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
