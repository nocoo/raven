import { managementResponse } from "@/lib/management-proxy";

export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return managementResponse(`/api/upstreams/${encodeURIComponent(id)}/test`, "POST", request);
}
