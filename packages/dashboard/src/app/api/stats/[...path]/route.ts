import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy";

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
  const fullPath = `/api/stats/${subPath}${queryString ? `?${queryString}` : ""}`;

  const data = await proxyFetch(fullPath);
  return NextResponse.json(data);
}
