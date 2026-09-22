import { managementResponse } from "@/lib/management-proxy";

export const dynamic = "force-dynamic";
export function GET() { return managementResponse("/api/upstreams/migration"); }
