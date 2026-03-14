import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy";
import type { PaginatedRequests } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const queryString = url.searchParams.toString();
  const fullPath = `/api/requests${queryString ? `?${queryString}` : ""}`;

  const data = await proxyFetch<PaginatedRequests>(fullPath);
  return NextResponse.json(data);
}
