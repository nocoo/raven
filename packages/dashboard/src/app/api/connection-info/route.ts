import { NextResponse } from "next/server";
import { proxyFetch, ProxyError } from "@/lib/proxy";
import type { ConnectionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await proxyFetch<ConnectionInfo>("/api/connection-info");
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof ProxyError ? (err.statusCode ?? 502) : 502;
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json({ error: message }, { status });
  }
}
