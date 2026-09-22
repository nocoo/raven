import { managementResponse } from "@/lib/management-proxy";

export const dynamic = "force-dynamic";
export function GET() { return managementResponse("/api/keys"); }
export function POST(request: Request) { return managementResponse("/api/keys", "POST", request, 201); }
