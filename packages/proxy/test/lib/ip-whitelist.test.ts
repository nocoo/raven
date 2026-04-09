import { describe, it, expect } from "bun:test";
import {
  parseIPv4,
  intToIPv4,
  isValidIPv4,
  parseIPRange,
  isIPInRange,
  isIPInRanges,
  validateIPRangeString,
  parseIPRanges,
  serializeIPRanges,
  extractIPv4,
} from "../../src/lib/ip-whitelist";

describe("ip-whitelist", () => {
  describe("parseIPv4", () => {
    it("parses valid IPv4 addresses", () => {
      expect(parseIPv4("0.0.0.0")).toBe(0);
      expect(parseIPv4("255.255.255.255")).toBe(0xffffffff);
      // Use >>> 0 to convert to unsigned 32-bit
      expect(parseIPv4("192.168.1.1")).toBe(((192 << 24) | (168 << 16) | (1 << 8) | 1) >>> 0);
      expect(parseIPv4("127.0.0.1")).toBe(((127 << 24) | 1) >>> 0);
      expect(parseIPv4("10.0.0.1")).toBe(((10 << 24) | 1) >>> 0);
    });

    it("returns null for invalid addresses", () => {
      expect(parseIPv4("")).toBeNull();
      expect(parseIPv4("invalid")).toBeNull();
      expect(parseIPv4("192.168.1")).toBeNull();
      expect(parseIPv4("192.168.1.1.1")).toBeNull();
      expect(parseIPv4("256.1.1.1")).toBeNull();
      expect(parseIPv4("-1.1.1.1")).toBeNull();
      expect(parseIPv4("1.1.1.01")).toBeNull(); // Leading zeros
      expect(parseIPv4("1.1.1.1a")).toBeNull();
    });
  });

  describe("intToIPv4", () => {
    it("converts integers back to IP strings", () => {
      expect(intToIPv4(0)).toBe("0.0.0.0");
      expect(intToIPv4(0xffffffff)).toBe("255.255.255.255");
      expect(intToIPv4((192 << 24) | (168 << 16) | (1 << 8) | 1)).toBe("192.168.1.1");
    });
  });

  describe("isValidIPv4", () => {
    it("returns true for valid IPs", () => {
      expect(isValidIPv4("192.168.1.1")).toBe(true);
      expect(isValidIPv4("0.0.0.0")).toBe(true);
    });

    it("returns false for invalid IPs", () => {
      expect(isValidIPv4("invalid")).toBe(false);
      expect(isValidIPv4("")).toBe(false);
    });
  });

  describe("parseIPRange", () => {
    describe("single IP", () => {
      it("parses single IPs", () => {
        const range = parseIPRange("192.168.1.1");
        expect(range).not.toBeNull();
        expect(range!.start).toBe(range!.end);
        expect(range!.original).toBe("192.168.1.1");
      });

      it("returns null for invalid single IP", () => {
        expect(parseIPRange("invalid")).toBeNull();
        expect(parseIPRange("")).toBeNull();
      });
    });

    describe("CIDR notation", () => {
      it("parses /32 (single host)", () => {
        const range = parseIPRange("192.168.1.1/32");
        expect(range).not.toBeNull();
        expect(range!.start).toBe(range!.end);
      });

      it("parses /24 (256 hosts)", () => {
        const range = parseIPRange("192.168.1.0/24");
        expect(range).not.toBeNull();
        expect(intToIPv4(range!.start)).toBe("192.168.1.0");
        expect(intToIPv4(range!.end)).toBe("192.168.1.255");
      });

      it("parses /16 (class B)", () => {
        const range = parseIPRange("10.20.0.0/16");
        expect(range).not.toBeNull();
        expect(intToIPv4(range!.start)).toBe("10.20.0.0");
        expect(intToIPv4(range!.end)).toBe("10.20.255.255");
      });

      it("parses /8 (class A)", () => {
        const range = parseIPRange("10.0.0.0/8");
        expect(range).not.toBeNull();
        expect(intToIPv4(range!.start)).toBe("10.0.0.0");
        expect(intToIPv4(range!.end)).toBe("10.255.255.255");
      });

      it("parses /0 (all IPs)", () => {
        const range = parseIPRange("0.0.0.0/0");
        expect(range).not.toBeNull();
        expect(range!.start).toBe(0);
        expect(range!.end).toBe(0xffffffff);
      });

      it("returns null for invalid CIDR", () => {
        expect(parseIPRange("192.168.1.0/33")).toBeNull();
        expect(parseIPRange("192.168.1.0/-1")).toBeNull();
        expect(parseIPRange("invalid/24")).toBeNull();
        expect(parseIPRange("/24")).toBeNull();
        expect(parseIPRange("192.168.1.0/")).toBeNull();
      });
    });

    describe("range notation", () => {
      it("parses valid ranges", () => {
        const range = parseIPRange("192.168.1.1-192.168.1.100");
        expect(range).not.toBeNull();
        expect(intToIPv4(range!.start)).toBe("192.168.1.1");
        expect(intToIPv4(range!.end)).toBe("192.168.1.100");
      });

      it("handles whitespace", () => {
        const range = parseIPRange("  192.168.1.1 - 192.168.1.100  ");
        expect(range).not.toBeNull();
      });

      it("returns null when start > end", () => {
        expect(parseIPRange("192.168.1.100-192.168.1.1")).toBeNull();
      });

      it("returns null for invalid range IPs", () => {
        expect(parseIPRange("invalid-192.168.1.100")).toBeNull();
        expect(parseIPRange("192.168.1.1-invalid")).toBeNull();
        expect(parseIPRange("-192.168.1.1")).toBeNull();
        expect(parseIPRange("192.168.1.1-")).toBeNull();
      });
    });
  });

  describe("isIPInRange", () => {
    it("checks single IP range", () => {
      const range = parseIPRange("192.168.1.1")!;
      expect(isIPInRange(parseIPv4("192.168.1.1")!, range)).toBe(true);
      expect(isIPInRange(parseIPv4("192.168.1.2")!, range)).toBe(false);
    });

    it("checks CIDR range", () => {
      const range = parseIPRange("192.168.1.0/24")!;
      expect(isIPInRange(parseIPv4("192.168.1.0")!, range)).toBe(true);
      expect(isIPInRange(parseIPv4("192.168.1.128")!, range)).toBe(true);
      expect(isIPInRange(parseIPv4("192.168.1.255")!, range)).toBe(true);
      expect(isIPInRange(parseIPv4("192.168.2.1")!, range)).toBe(false);
    });

    it("checks dash range", () => {
      const range = parseIPRange("192.168.1.10-192.168.1.20")!;
      expect(isIPInRange(parseIPv4("192.168.1.10")!, range)).toBe(true);
      expect(isIPInRange(parseIPv4("192.168.1.15")!, range)).toBe(true);
      expect(isIPInRange(parseIPv4("192.168.1.20")!, range)).toBe(true);
      expect(isIPInRange(parseIPv4("192.168.1.9")!, range)).toBe(false);
      expect(isIPInRange(parseIPv4("192.168.1.21")!, range)).toBe(false);
    });
  });

  describe("isIPInRanges", () => {
    it("checks against multiple ranges", () => {
      const ranges = [
        parseIPRange("192.168.1.0/24")!,
        parseIPRange("10.0.0.1")!,
        parseIPRange("172.16.0.1-172.16.0.10")!,
      ];

      expect(isIPInRanges(parseIPv4("192.168.1.50")!, ranges)).toBe(true);
      expect(isIPInRanges(parseIPv4("10.0.0.1")!, ranges)).toBe(true);
      expect(isIPInRanges(parseIPv4("172.16.0.5")!, ranges)).toBe(true);
      expect(isIPInRanges(parseIPv4("8.8.8.8")!, ranges)).toBe(false);
    });

    it("returns false for empty ranges", () => {
      expect(isIPInRanges(parseIPv4("192.168.1.1")!, [])).toBe(false);
    });
  });

  describe("validateIPRangeString", () => {
    it("returns null for valid inputs", () => {
      expect(validateIPRangeString("192.168.1.1")).toBeNull();
      expect(validateIPRangeString("192.168.1.0/24")).toBeNull();
      expect(validateIPRangeString("192.168.1.1-192.168.1.100")).toBeNull();
    });

    it("returns error for empty input", () => {
      expect(validateIPRangeString("")).toBe("IP range cannot be empty");
      expect(validateIPRangeString("   ")).toBe("IP range cannot be empty");
    });

    it("returns contextual error for invalid CIDR", () => {
      expect(validateIPRangeString("invalid/24")).toContain("CIDR");
    });

    it("returns contextual error for invalid range", () => {
      expect(validateIPRangeString("invalid-192.168.1.1")).toContain("range");
    });

    it("returns contextual error for invalid IP", () => {
      expect(validateIPRangeString("invalid")).toContain("IP address");
    });
  });

  describe("parseIPRanges", () => {
    it("parses valid JSON array", () => {
      const { ranges, errors } = parseIPRanges('["192.168.1.1", "10.0.0.0/8"]');
      expect(errors).toHaveLength(0);
      expect(ranges).toHaveLength(2);
    });

    it("returns errors for invalid JSON", () => {
      const { ranges, errors } = parseIPRanges("not json");
      expect(errors).toContain("Invalid JSON format");
      expect(ranges).toHaveLength(0);
    });

    it("returns errors for non-array JSON", () => {
      const { ranges, errors } = parseIPRanges('{"ip": "192.168.1.1"}');
      expect(errors).toContain("Expected JSON array");
      expect(ranges).toHaveLength(0);
    });

    it("returns errors for non-string items", () => {
      const { ranges, errors } = parseIPRanges('[123, "192.168.1.1"]');
      expect(errors.some((e) => e.includes("expected string"))).toBe(true);
      expect(ranges).toHaveLength(1);
    });

    it("returns errors for invalid IP ranges", () => {
      const { ranges, errors } = parseIPRanges('["invalid", "192.168.1.1"]');
      expect(errors.some((e) => e.includes("invalid IP range"))).toBe(true);
      expect(ranges).toHaveLength(1);
    });
  });

  describe("serializeIPRanges", () => {
    it("serializes ranges to JSON", () => {
      const ranges = [
        parseIPRange("192.168.1.1")!,
        parseIPRange("10.0.0.0/8")!,
      ];
      const json = serializeIPRanges(ranges);
      expect(json).toBe('["192.168.1.1","10.0.0.0/8"]');
    });
  });

  describe("extractIPv4", () => {
    it("returns plain IPv4 as-is", () => {
      expect(extractIPv4("192.168.1.1")).toBe("192.168.1.1");
    });

    it("handles IPv6 loopback", () => {
      expect(extractIPv4("::1")).toBe("127.0.0.1");
    });

    it("handles IPv4-mapped IPv6 (dotted)", () => {
      expect(extractIPv4("::ffff:192.168.1.1")).toBe("192.168.1.1");
      expect(extractIPv4("::FFFF:10.0.0.1")).toBe("10.0.0.1");
    });

    it("handles IPv4-mapped IPv6 (hex)", () => {
      // c0a8:0101 = 192.168.1.1
      expect(extractIPv4("::ffff:c0a8:0101")).toBe("192.168.1.1");
    });

    it("returns null for pure IPv6", () => {
      expect(extractIPv4("2001:db8::1")).toBeNull();
      expect(extractIPv4("fe80::1")).toBeNull();
    });

    it("returns null for empty/null", () => {
      expect(extractIPv4("")).toBeNull();
    });

    it("returns null for invalid input", () => {
      expect(extractIPv4("invalid")).toBeNull();
    });
  });
});
