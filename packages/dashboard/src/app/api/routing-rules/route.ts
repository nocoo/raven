import { managementResponse } from "@/lib/management-proxy";

export const dynamic = "force-dynamic";
export function GET() { return managementResponse("/api/routing-rules"); }
export function POST(request: Request) { return managementResponse("/api/routing-rules", "POST", request, 201); }
