import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      "packages/proxy",
      "packages/dashboard",
      {
        test: {
          name: "scripts",
          include: ["scripts/**/__tests__/**/*.test.ts"],
          exclude: ["node_modules/**"],
          server: {
            deps: {
              external: [/^bun(:|$)/],
            },
          },
        },
      },
    ],
  },
})
