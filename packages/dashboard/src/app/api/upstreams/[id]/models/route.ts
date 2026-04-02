import { NextResponse } from "next/server";
import { proxyFetch, ProxyError } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export interface UpstreamModelsResponse {
  healthy: boolean;
  total?: number;
  models?: Record<string, string[]>;
  error?: {
    message: string;
    type: string;
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const data = await proxyFetch<UpstreamModelsResponse>(`/api/upstreams/${id}/models`);
    return NextResponse.json(data);
  } catch (err) {
    // Proxy returns 502 for upstream errors, preserve that
    const status = err instanceof ProxyError ? (err.statusCode ?? 502) : 502;
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json(
      { healthy: false, error: { message, type: "proxy_error" } },
      { status },
    );
  }
}
