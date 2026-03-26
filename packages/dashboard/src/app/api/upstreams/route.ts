import { NextResponse } from "next/server";
import { proxyFetch, ProxyError } from "@/lib/proxy";
import type { ProviderPublic } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await proxyFetch<ProviderPublic[]>("/api/upstreams");
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof ProxyError ? (err.statusCode ?? 502) : 502;
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const data = await proxyFetch<ProviderPublic>("/api/upstreams", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    const status = err instanceof ProxyError ? (err.statusCode ?? 502) : 502;
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json({ error: message }, { status });
  }
}
