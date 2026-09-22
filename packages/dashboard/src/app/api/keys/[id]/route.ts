import { managementResponse } from "@/lib/management-proxy";

export const dynamic = "force-dynamic";
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return managementResponse(`/api/keys/${encodeURIComponent(id)}`, "PATCH", request);
}
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return managementResponse(`/api/keys/${encodeURIComponent(id)}`, "DELETE");
}
