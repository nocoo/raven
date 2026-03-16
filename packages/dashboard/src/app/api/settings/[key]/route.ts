import { NextResponse } from "next/server";
import { proxyFetch, ProxyError } from "@/lib/proxy";
import type { SettingsData } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  try {
    const data = await proxyFetch<SettingsData>(`/api/settings/${key}`, {
      method: "DELETE",
    });
    return NextResponse.json(data);
  } catch (err) {
    const status = err instanceof ProxyError ? (err.statusCode ?? 502) : 502;
    const message = err instanceof Error ? err.message : "Failed to reach proxy";
    return NextResponse.json({ error: message }, { status });
  }
}
