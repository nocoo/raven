import { NextResponse } from "next/server";
import { proxyFetch, ProxyError } from "@/lib/proxy";

export const dynamic = "force-dynamic";

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
    const data = await proxyFetch("/api/settings/socks5", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof ProxyError ? (err.statusCode ?? 502) : 502;
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json({ error: message }, { status });
  }
}
