import { BlockList, isIP } from "node:net";

export function normalizeIP(value: string | null): string | null {
  if (!value || value.includes("%")) return null;
  const family = isIP(value);
  if (!family) return null;
  if (family === 4) return value;
  const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
  if (!canonical.startsWith("::ffff:")) return canonical;
  const parts = canonical.slice(7).split(":").map(part => Number.parseInt(part, 16));
  const high = parts[0]!;
  const low = parts[1]!;
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export interface IPRule {
  original: string;
  family: 4 | 6;
  block: BlockList;
}

export function parseRules(input: unknown): IPRule[] {
  if (!Array.isArray(input) || input.length > 256 || input.some(value => typeof value !== "string")) throw new Error("Expected at most 256 IP rules");
  return [...new Set((input as string[]).map(value => value.trim()))].map(original => {
    const block = new BlockList();
    const parts = original.split(original.includes("/") ? "/" : "-");
    const address = normalizeIP(parts[0]!.trim());
    if (!address || parts.length > 2) throw new Error(`Invalid IP rule: ${original}`);
    const family = isIP(address) as 4 | 6;
    const type = family === 4 ? "ipv4" : "ipv6";
    if (original.includes("/")) {
      if (!/^\d+$/.test(parts[1]!)) throw new Error(`Invalid prefix: ${original}`);
      let prefix = Number(parts[1]);
      if (isIP(parts[0]!.trim()) === 6 && family === 4) prefix -= 96;
      block.addSubnet(address, prefix, type);
    } else if (parts.length === 2) {
      const end = normalizeIP(parts[1]!.trim());
      if (!end || isIP(end) !== family) throw new Error(`Invalid IP range: ${original}`);
      block.addRange(address, end, type);
    } else {
      block.addAddress(address, type);
    }
    return { original, family, block };
  });
}

export function allowsIP(enabled: boolean, rules: IPRule[], value: string | null): boolean {
  if (!enabled) return true;
  const ip = normalizeIP(value);
  if (!ip) return false;
  const family = isIP(ip);
  return rules.some(rule => rule.family === family && rule.block.check(ip, family === 4 ? "ipv4" : "ipv6"));
}

export function resolveClientIP(headers: Headers, peer: string | null, trusted: IPRule[]): { ip: string | null; source: "socket" | "forwarded" | "unknown" } {
  const ip = normalizeIP(peer);
  if (!ip) return { ip: null, source: "unknown" };
  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded || !allowsIP(true, trusted, ip)) return { ip, source: "socket" };
  const chain = forwarded.split(",").map(value => normalizeIP(value.trim()));
  if (chain.length > 32 || chain.some(value => !value)) return { ip: null, source: "unknown" };
  let candidate = ip;
  for (let index = chain.length - 1; index >= 0 && allowsIP(true, trusted, candidate); index--) candidate = chain[index]!;
  return { ip: candidate, source: "forwarded" };
}

const LOOPBACK = parseRules(["127.0.0.0/8", "::1"]);
const NONPUBLIC = parseRules([
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3",
  "::/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001:db8::/32", "fc00::/7", "fe80::/10", "ff00::/8",
]);

export function isLoopback(ip: string | null): boolean {
  return allowsIP(true, LOOPBACK, ip);
}

export function isPublicIP(ip: string | null): boolean {
  return normalizeIP(ip) !== null && !allowsIP(true, NONPUBLIC, ip);
}
