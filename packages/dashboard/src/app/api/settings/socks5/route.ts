import { managementConfig } from "@/lib/management-config";
import { NextResponse } from "next/server";
import { proxyFetch, ProxyError } from "@/lib/proxy";


export const dynamic = "force-dynamic";

function proxyHeaders(): Record<string, string> {
  const { key: API_KEY } = managementConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  return headers;
}

export async function GET() {
  try {
    const data = await proxyFetch("/api/settings/socks5");
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof ProxyError ? (err.statusCode ?? 502) : 502;
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();

    const { url: PROXY_URL } = managementConfig();
    const res = await fetch(`${PROXY_URL}/api/settings/socks5`, {
      method: "PUT",
      headers: proxyHeaders(),
      body: JSON.stringify(body),
      cache: "no-store", redirect: "error",
    });

    // Forward proxy's JSON body as-is (preserves structured validation/bridge errors)
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
