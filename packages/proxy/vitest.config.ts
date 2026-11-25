import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    allowOnly: false,
    passWithNoTests: false,
    maxWorkers: 4,
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**", "test/perf/**", "node_modules/**"],
    server: {
      deps: {
        // Bun built-in modules — let bun's resolver handle these at runtime.
        external: [/^bun(:|$)/],
        inline: ["zod"],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        // Intentionally-uncovered legacy entry points / shims. Mirrors
        // baseline.enforcement.allowUntestedFiles so the coverage
        // aggregate doesn't double-count them as regressions.
        "src/index.ts",
        "src/lib/migration.ts",
        "src/lib/paths.ts",
        "src/upstream/interface.ts",
      ],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
