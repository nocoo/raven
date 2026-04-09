/**
 * IP whitelist utilities for access control.
 *
 * Supports:
 * - Single IPs: "192.168.1.1"
 * - CIDR notation: "192.168.1.0/24"
 * - IP ranges: "192.168.1.1-192.168.1.100"
 */

// ---------------------------------------------------------------------------
// IP parsing and validation
// ---------------------------------------------------------------------------

/**
 * Parse an IPv4 address string to a 32-bit integer.
 * Returns null if invalid.
 */
export function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255 || part !== String(num)) {
      return null;
    }
    result = (result << 8) | num;
  }
  // Convert to unsigned 32-bit
  return result >>> 0;
}

/**
 * Convert a 32-bit integer back to IPv4 string.
 */
export function intToIPv4(num: number): string {
  return [
    (num >>> 24) & 255,
    (num >>> 16) & 255,
    (num >>> 8) & 255,
    num & 255,
  ].join(".");
}

/**
 * Validate that a string is a valid IPv4 address.
 */
export function isValidIPv4(ip: string): boolean {
  return parseIPv4(ip) !== null;
}

// ---------------------------------------------------------------------------
// Range types and parsing
// ---------------------------------------------------------------------------

export interface IPRange {
  start: number; // inclusive
  end: number; // inclusive
  original: string; // original input for display
}

/**
 * Parse a single IP range entry.
 * Supports:
 * - Single IP: "192.168.1.1"
 * - CIDR: "192.168.1.0/24"
 * - Range: "192.168.1.1-192.168.1.100"
 *
 * Returns null if invalid.
 */
export function parseIPRange(input: string): IPRange | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // CIDR notation: "192.168.1.0/24"
  if (trimmed.includes("/")) {
    const [ipPart, prefixPart] = trimmed.split("/");
    if (!ipPart || !prefixPart) return null;

    const ip = parseIPv4(ipPart);
    if (ip === null) return null;

    const prefix = parseInt(prefixPart, 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return null;

    // Calculate mask and range
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const start = (ip & mask) >>> 0;
    const end = (start | (~mask >>> 0)) >>> 0;

    return { start, end, original: trimmed };
  }

  // Range notation: "192.168.1.1-192.168.1.100"
  if (trimmed.includes("-")) {
    const [startPart, endPart] = trimmed.split("-");
    if (!startPart || !endPart) return null;

    const start = parseIPv4(startPart.trim());
    const end = parseIPv4(endPart.trim());
    if (start === null || end === null) return null;
    if (start > end) return null;

    return { start, end, original: trimmed };
  }

  // Single IP: "192.168.1.1"
  const ip = parseIPv4(trimmed);
  if (ip === null) return null;

  return { start: ip, end: ip, original: trimmed };
}

/**
 * Check if an IP address is within a range.
 */
export function isIPInRange(ip: number, range: IPRange): boolean {
  return ip >= range.start && ip <= range.end;
}

/**
 * Check if an IP address is within any of the given ranges.
 */
export function isIPInRanges(ip: number, ranges: IPRange[]): boolean {
  return ranges.some((range) => isIPInRange(ip, range));
}

/**
 * Validate an IP range string. Returns error message or null if valid.
 */
export function validateIPRangeString(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return "IP range cannot be empty";

  const range = parseIPRange(trimmed);
  if (!range) {
    if (trimmed.includes("/")) {
      return "Invalid CIDR notation. Expected format: 192.168.1.0/24";
    }
    if (trimmed.includes("-")) {
      return "Invalid IP range. Expected format: 192.168.1.1-192.168.1.100";
    }
    return "Invalid IP address. Expected format: 192.168.1.1";
  }

  return null;
}

/**
 * Parse multiple IP ranges from a JSON array string.
 * Returns the parsed ranges and any errors.
 */
export function parseIPRanges(
  jsonStr: string
): { ranges: IPRange[]; errors: string[] } {
  const ranges: IPRange[] = [];
  const errors: string[] = [];

  let arr: unknown;
  try {
    arr = JSON.parse(jsonStr);
  } catch {
    return { ranges: [], errors: ["Invalid JSON format"] };
  }

  if (!Array.isArray(arr)) {
    return { ranges: [], errors: ["Expected JSON array"] };
  }

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (typeof item !== "string") {
      errors.push(`Item ${i + 1}: expected string, got ${typeof item}`);
      continue;
    }

    const range = parseIPRange(item);
    if (!range) {
      errors.push(`Item ${i + 1}: invalid IP range "${item}"`);
      continue;
    }

    ranges.push(range);
  }

  return { ranges, errors };
}

/**
 * Serialize IP ranges to JSON array string.
 */
export function serializeIPRanges(ranges: IPRange[]): string {
  return JSON.stringify(ranges.map((r) => r.original));
}

// ---------------------------------------------------------------------------
// IPv4-mapped IPv6 handling
// ---------------------------------------------------------------------------

/**
 * Extract IPv4 address from various formats.
 * Handles:
 * - Plain IPv4: "192.168.1.1"
 * - IPv4-mapped IPv6: "::ffff:192.168.1.1"
 * - Loopback variations: "::1" -> "127.0.0.1"
 *
 * Returns null if cannot extract IPv4.
 */
export function extractIPv4(ip: string): string | null {
  if (!ip) return null;

  // Plain IPv4
  if (isValidIPv4(ip)) return ip;

  // IPv6 loopback -> IPv4 loopback
  if (ip === "::1") return "127.0.0.1";

  // IPv4-mapped IPv6: "::ffff:192.168.1.1" or "::ffff:c0a8:0101"
  const v4MappedPrefix = "::ffff:";
  if (ip.toLowerCase().startsWith(v4MappedPrefix)) {
    const v4Part = ip.slice(v4MappedPrefix.length);

    // Dotted decimal format
    if (isValidIPv4(v4Part)) return v4Part;

    // Hex format (c0a8:0101 for 192.168.1.1)
    const hexParts = v4Part.split(":");
    if (hexParts.length === 2) {
      const high = parseInt(hexParts[0]!, 16);
      const low = parseInt(hexParts[1]!, 16);
      if (!isNaN(high) && !isNaN(low)) {
        return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
      }
    }
  }

  return null;
}
