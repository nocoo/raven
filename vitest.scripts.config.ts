import { defineConfig } from "vitest/config";

// Standalone coverage configuration: project-local coverage options are not
// the workspace runner's coverage policy. The baseline gate invokes this
// file explicitly, keeping scripts reports separate from Proxy and Dashboard.
export default defineConfig({
  test: {
    name: "scripts",
    allowOnly: false,
    passWithNoTests: false,
    include: ["scripts/**/__tests__/**/*.test.ts"],
    exclude: ["node_modules/**"],
    server: { deps: { external: [/^bun(:|$)/] } },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "lcov"],
      reportsDirectory: "coverage/scripts",
      include: ["scripts/lib/**/*.ts"],
      exclude: ["scripts/lib/**/__tests__/**"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
