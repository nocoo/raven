import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: [
      "test/**/*.test.ts",
    ],
    exclude: [
      "test/e2e/**",
      "test/perf/**",
      "node_modules/**",
    ],
    server: {
      deps: {
        // Bun built-in modules — let bun's resolver handle these at runtime.
        external: [/^bun(:|$)/],
        inline: ["zod"],
      },
    },
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/index.ts",
      ],
      thresholds: {
        lines: 95,
        statements: 95,
        functions: 95,
        branches: 89,
      },
    },
  },
})

