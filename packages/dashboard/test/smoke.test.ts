import { afterEach, describe, expect, it, vi } from "vitest";

const ORIG_APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION;

afterEach(() => {
  if (ORIG_APP_VERSION === undefined) {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
  } else {
    process.env.NEXT_PUBLIC_APP_VERSION = ORIG_APP_VERSION;
  }
  vi.resetModules();
});

describe("smoke", () => {
  it("vitest runs", () => {
    expect(1 + 1).toBe(2);
  });

  it("exports APP_VERSION with default fallback and env override", async () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    vi.resetModules();
    const fallbackMod = await import("@/lib/version");
    expect(fallbackMod.APP_VERSION).toBe("0.0.0");

    process.env.NEXT_PUBLIC_APP_VERSION = "9.9.9";
    vi.resetModules();
    const overrideMod = await import("@/lib/version");
    expect(overrideMod.APP_VERSION).toBe("9.9.9");
  });
});
