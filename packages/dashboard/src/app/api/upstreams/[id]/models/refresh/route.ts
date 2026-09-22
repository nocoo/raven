import { managementResponse } from "@/lib/management-proxy";

export const dynamic = "force-dynamic";
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return managementResponse(`/api/upstreams/${encodeURIComponent(id)}/models/refresh`, "POST");
}
