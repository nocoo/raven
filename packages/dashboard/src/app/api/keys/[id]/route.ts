import { NextResponse } from "next/server";
import { proxyFetch, ProxyError } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const data = await proxyFetch<{ ok: boolean }>(`/api/keys/${id}`, {
      method: "DELETE",
    });
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof ProxyError ? (err.statusCode ?? 502) : 502;
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json({ error: message }, { status });
  }
}
