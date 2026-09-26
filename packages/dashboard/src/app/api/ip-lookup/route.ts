import { managementResponse } from "@/lib/management-proxy";
export async function GET(request: Request) {
  return managementResponse(`/api/ip-lookup?${new URL(request.url).searchParams}`);
}
