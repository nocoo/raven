import { managementConfig } from "@/lib/management-config";
// ---------------------------------------------------------------------------
// BFF SSE proxy for log streaming.
//
// Browser connects here via EventSource (SSE). This route handler opens a
// WebSocket to the proxy's /ws/logs endpoint server-side, then bridges
// WS messages to SSE events. Credentials (RAVEN_INTERNAL_KEY) never leave the
// server — browser auth is via NextAuth session cookie (enforced by proxy.ts).
//
// Query params:
//   ?level=debug|info|warn|error  (default: info)
//   ?requestId=<id>               (optional: filter to single request)
// ---------------------------------------------------------------------------

import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";


export async function GET(req: NextRequest) {
  let config: ReturnType<typeof managementConfig>;
  try { config = managementConfig(); } catch { return Response.json({ error: "Local management connection is not configured" }, { status: 503 }); }
  const { url: PROXY_URL, key: API_KEY } = config;
  const level = req.nextUrl.searchParams.get("level") ?? "info";
  const requestId = req.nextUrl.searchParams.get("requestId");

  // Build upstream WS URL
  const wsBase = PROXY_URL.replace(/^http/, "ws");
  const wsParams = new URLSearchParams({ token: API_KEY, level });
  if (requestId) wsParams.set("requestId", requestId);
  const wsUrl = `${wsBase}/ws/logs?${wsParams}`;

  // Create SSE stream
  const encoder = new TextEncoder();
  let upstreamWs: WebSocket | null = null;

  const stream = new ReadableStream({
    start(controller) {
      try {
        upstreamWs = new WebSocket(wsUrl);
      } catch {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: "Failed to connect to proxy" })}\n\n`,
          ),
        );
        controller.close();
        return;
      }

      upstreamWs.onopen = () => {
        controller.enqueue(
          encoder.encode(
            `event: connected\ndata: ${JSON.stringify({ status: "connected" })}\n\n`,
          ),
        );
      };

      upstreamWs.onmessage = (event) => {
        // Forward WS message as SSE "log" event
        const data = typeof event.data === "string" ? event.data : "";
        controller.enqueue(encoder.encode(`event: log\ndata: ${data}\n\n`));
      };

      upstreamWs.onerror = () => {
        try {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ error: "Upstream connection error" })}\n\n`,
            ),
          );
        } catch {
          // Controller may be closed
        }
      };

      upstreamWs.onclose = () => {
        try {
          controller.enqueue(
            encoder.encode(
              `event: disconnected\ndata: ${JSON.stringify({ status: "disconnected" })}\n\n`,
            ),
          );
          controller.close();
        } catch {
          // Controller may already be closed
        }
      };
    },

    cancel() {
      // Browser closed SSE connection — clean up upstream WS
      if (upstreamWs && upstreamWs.readyState !== WebSocket.CLOSED) {
        upstreamWs.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    },
  });
}

// POST handler for sending commands (level/filter changes) to upstream WS.
// Since SSE is unidirectional, the browser POSTs here to relay commands.
// NOTE: This is a stateless fire-and-forget — the browser should reconnect
// with new query params if it needs to change filters.
