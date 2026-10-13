import { describe, expect, it } from "vitest";
import { preserveLockfileSources } from "../release-lockfile";

describe("preserveLockfileSources", () => {
  it("keeps canonical sources while retaining synchronized workspace versions", () => {
    const before = `{
  "version": "3.0.7",
  "packages": {
    "@scope/pkg": ["@scope/pkg@1.0.0", "", {}, "sha512-original"],
    "pkg": ["pkg@2.0.0", "", {}, "sha512-other"]
  }
}`;
    const after = before
      .replace("3.0.7", "3.0.8")
      .replace('"@scope/pkg@1.0.0", ""', '"@scope/pkg@1.0.0", "https://mirror.example/@scope/pkg/-/pkg-1.0.0.tgz"')
      .replace('"pkg@2.0.0", ""', '"pkg@2.0.0", "https://mirror.example/pkg/-/pkg-2.0.0.tgz"');

    expect(preserveLockfileSources(before, after)).toBe(before.replace("3.0.7", "3.0.8"));
    expect(preserveLockfileSources(before, before)).toBe(before);
  });

  it("preserves explicit sources without replacing new package resolutions", () => {
    const before = `    "custom": ["custom@1.0.0", "https://vendor.example/custom.tgz", {}, "sha512-custom"],
    "upgraded": ["upgraded@1.0.0", "", {}, "sha512-old"]`;
    const after = `    "custom": ["custom@1.0.0", "https://mirror.example/custom.tgz", {}, "sha512-custom"],
    "upgraded": ["upgraded@2.0.0", "https://mirror.example/upgraded.tgz", {}, "sha512-new"],
    "added": ["added@1.0.0", "https://mirror.example/added.tgz", {}, "sha512-added"]`;

    expect(preserveLockfileSources(before, after)).toBe(
      after.replace("https://mirror.example/custom.tgz", "https://vendor.example/custom.tgz"),
    );
    expect(preserveLockfileSources("", after)).toBe(after);
    expect(preserveLockfileSources(before, "")).toBe("");
  });
});
