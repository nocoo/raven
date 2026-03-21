import { describe, it, expect } from "vitest";
import { cn, getAvatarColor } from "@/lib/utils";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("px-2", "py-1")).toBe("px-2 py-1");
  });

  it("handles conditional classes", () => {
    expect(cn("base", false && "hidden", "visible")).toBe("base visible");
  });

  it("deduplicates tailwind conflicts", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});

describe("getAvatarColor", () => {
  it("returns a bg-* class string", () => {
    const color = getAvatarColor("alice");
    expect(color).toMatch(/^bg-/);
  });

  it("is deterministic (same input → same output)", () => {
    expect(getAvatarColor("bob")).toBe(getAvatarColor("bob"));
  });

  it("different names can produce different colors", () => {
    const colors = new Set(
      ["alice", "bob", "charlie", "dave", "eve", "frank", "grace", "heidi"]
        .map(getAvatarColor),
    );
    expect(colors.size).toBeGreaterThan(1);
  });

  it("empty string → returns a valid color", () => {
    expect(getAvatarColor("")).toMatch(/^bg-/);
  });
});
