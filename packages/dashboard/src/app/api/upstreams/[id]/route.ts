import { managementResponse } from "@/lib/management-proxy";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return managementResponse(`/api/upstreams/${encodeURIComponent(id)}`, "GET");
}
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return managementResponse(`/api/upstreams/${encodeURIComponent(id)}`, "PUT", request);
}
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return managementResponse(`/api/upstreams/${encodeURIComponent(id)}`, "DELETE");
}
