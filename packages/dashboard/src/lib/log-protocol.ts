const PROTOCOLS = {
  anthropic: "Messages",
  openai: "Chat Completions",
  responses: "Responses",
  systemone: "Systemone",
  decisions: "Decisions",
  images: "Image Generations",
} as const;

function protocol(value: unknown): value is keyof typeof PROTOCOLS {
  return typeof value === "string" && Object.hasOwn(PROTOCOLS, value);
}

export function logProtocol(data: Record<string, unknown>, complete: boolean) {
  const client = data.format;
  const upstream = data.upstreamFormat;
  if (protocol(client) && protocol(upstream)) {
    const native = client === upstream;
    const imageName = data.path === "/v1/images/edits" ? "Image Edits" : null;
    const clientName = client === "images" && imageName ? imageName : PROTOCOLS[client];
    const upstreamName = upstream === "images" && imageName ? imageName : PROTOCOLS[upstream];
    return {
      label: native ? "Native" : "Translated",
      variant: native ? "success" as const : "warning" as const,
      title: `${clientName} → ${upstreamName}${native ? " · No protocol translation" : ` · Prefer ${upstreamName} in your client`}`,
    };
  }
  return {
    label: complete ? "Unknown path" : "Pending path",
    variant: "secondary" as const,
    title: complete ? "No upstream protocol recorded; the request may have failed before routing." : "The protocol path is recorded when the request completes.",
  };
}
