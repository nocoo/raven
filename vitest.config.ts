import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    allowOnly: false,
    passWithNoTests: false,
    projects: ["packages/proxy", "packages/dashboard", "./vitest.scripts.config.ts"],
  },
});
