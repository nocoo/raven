import { NextResponse } from "next/server";
import { proxyFetch, ProxyError } from "@/lib/proxy";
import type { PaginatedRequests } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const queryString = url.searchParams.toString();
  const fullPath = `/api/requests${queryString ? `?${queryString}` : ""}`;

  try {
    const data = await proxyFetch<PaginatedRequests>(fullPath);
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof ProxyError ? (err.statusCode ?? 502) : 502;
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json({ error: message }, { status });
  }
}
