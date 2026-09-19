import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      "packages/proxy",
      "packages/dashboard",
      "./vitest.scripts.config.ts",
    ],
  },
})
