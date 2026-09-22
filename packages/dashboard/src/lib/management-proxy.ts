import { NextResponse } from "next/server";
import { ProxyError, proxyFetch } from "./proxy";

export async function managementResponse(path: string, method = "GET", request?: Request, status = 200) {
  let body: string | undefined;
  if (request) {
    try { body = JSON.stringify(await request.json()); }
    catch { return NextResponse.json({ error: { message: "Request body must be valid JSON.", type: "invalid_request" } }, { status: 400 }); }
  }
  try {
    const data = method === "GET" ? await proxyFetch(path) : await proxyFetch(path, { method, ...(body === undefined ? {} : { body }) });
    return NextResponse.json(data, { status });
  } catch (error) {
    const code = error instanceof ProxyError ? (error.statusCode ?? 502) : 502;
    const detail = error instanceof ProxyError ? error.detail : undefined;
    return NextResponse.json({ error: detail ?? { message: error instanceof Error ? error.message : "Failed to reach proxy" } }, { status: code });
  }
}
