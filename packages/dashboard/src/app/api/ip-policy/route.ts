import { managementResponse } from "@/lib/management-proxy";
export async function GET() { return managementResponse("/api/ip-policy"); }
export async function PUT(request: Request) { return managementResponse("/api/ip-policy", "PUT", request); }
