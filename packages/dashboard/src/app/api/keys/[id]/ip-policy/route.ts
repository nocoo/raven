import { managementResponse } from "@/lib/management-proxy";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return managementResponse(`/api/keys/${encodeURIComponent((await params).id)}/ip-policy`);
}
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return managementResponse(`/api/keys/${encodeURIComponent((await params).id)}/ip-policy`, "PUT", request);
}
