import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  auditBuildContext,
  checkRequiredAppEntries,
  formatContextAudit,
} from "../lib/docker-context.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("repository docker build context", () => {
  test("keeps every tracked Dockerfile input, including app test routes", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter((file) => file !== "");
    const audit = auditBuildContext({
      files,
      dockerignore: read(".dockerignore"),
      dockerfile: read("Dockerfile"),
    });
    expect(formatContextAudit(audit)).toEqual([]);
    expect(checkRequiredAppEntries(files)).toEqual([]);
    expect(read(".dockerignore")).not.toMatch(/^\*\*\/(test|tests|e2e)\/?$/m);
  });

  test("P1 checks context and image routes while pipeline pushes GHCR via deploy-docker", () => {
    const slots = read(".github/workflows/quality-slots.yml");
    const contextCheck = slots.indexOf("bun run gate:docker-context");
    const verifyBuild = slots.indexOf("load: true");
    const routeCheck = slots.indexOf("docker-publish-verify-image-routes.ts");
    expect(contextCheck).toBeGreaterThan(-1);
    expect(verifyBuild).toBeGreaterThan(contextCheck);
    expect(routeCheck).toBeGreaterThan(verifyBuild);

    const pipeline = read(".github/workflows/pipeline.yml");
    expect(pipeline).toContain("nocoo/base-ci/.github/workflows/deploy-docker.yml@");
    expect(pipeline).toContain("deploy-over-ssh: false");
    expect(pipeline).toContain("needs: [quality]");
  });
});
