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
          coverage: {
            provider: "istanbul",
            include: ["scripts/lib/**/*.ts"],
            exclude: ["scripts/lib/**/__tests__/**"],
            thresholds: {
              lines: 95,
              statements: 95,
              functions: 95,
              branches: 89,
            },
          },
        },
      },
    ],
  },
})
