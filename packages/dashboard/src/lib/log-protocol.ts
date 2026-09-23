const PROTOCOLS = {
  anthropic: "Messages",
  openai: "Chat Completions",
  responses: "Responses",
} as const;

function protocol(value: unknown): value is keyof typeof PROTOCOLS {
  return typeof value === "string" && Object.hasOwn(PROTOCOLS, value);
}

export function logProtocol(data: Record<string, unknown>, complete: boolean) {
  const client = data.format;
  const upstream = data.upstreamFormat;
  if (protocol(client) && protocol(upstream)) {
    const native = client === upstream;
    return {
      label: native ? "Native" : "Translated",
      variant: native ? "success" as const : "warning" as const,
      title: `${PROTOCOLS[client]} → ${PROTOCOLS[upstream]}${native ? " · No protocol translation" : ` · Prefer ${PROTOCOLS[upstream]} in your client`}`,
    };
  }
  return {
    label: complete ? "Unknown path" : "Pending path",
    variant: "secondary" as const,
    title: complete ? "No upstream protocol recorded; the request may have failed before routing." : "The protocol path is recorded when the request completes.",
  };
}
