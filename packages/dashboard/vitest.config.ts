import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    allowOnly: false,
    passWithNoTests: false,
    environment: "node",
    globals: true,
    testTimeout: 15_000,
    maxWorkers: 2,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        // Pure View presentation layer (React components & Next.js pages/layouts)
        "src/components/**",
        "src/app/**/*.tsx",
        // Re-export only (1 line, covered by auth.ts tests)
        "src/app/api/auth/**",
        // Chart config (color palette / axis formatters)
        "src/lib/chart-config.ts",
        // Pure type definitions (zero runtime code)
        "src/lib/types.ts",
        "src/lib/routing-types.ts",
        // Trivial browser-only hooks
        "src/hooks/use-mobile.tsx",
      ],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
