import { managementResponse } from "@/lib/management-proxy";

export const dynamic = "force-dynamic";
export function GET() { return managementResponse("/api/upstreams"); }
export function POST(request: Request) { return managementResponse("/api/upstreams", "POST", request, 201); }
