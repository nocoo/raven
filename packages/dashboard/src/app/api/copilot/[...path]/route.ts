import { NextResponse } from "next/server";
import { proxyFetch, ProxyError } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const subPath = path.join("/");

  // Forward query params
  const url = new URL(_request.url);
  const queryString = url.searchParams.toString();
  const fullPath = `/api/copilot/${subPath}${queryString ? `?${queryString}` : ""}`;

  try {
    const data = await proxyFetch(fullPath);
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof ProxyError ? (err.statusCode ?? 502) : 502;
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json({ error: message }, { status });
  }
}
