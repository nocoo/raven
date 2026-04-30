import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        // ── Pure UI (no business logic worth unit-testing) ──
        "src/components/ui/**",
        "src/components/charts/**",
        "src/components/models/**",
        "src/components/stats/**",
        "src/components/layout/**",
        "src/components/auth-provider.tsx",
        "src/components/fetch-error.tsx",
        "src/components/setup-wizard.tsx",
        "src/components/copy-button.tsx",
        "src/components/requests/filters.tsx",
        // Next.js page wrappers & layouts (thin import + render)
        "src/app/**/page.tsx",
        "src/app/**/layout.tsx",
        "src/app/overview-charts.tsx",
        "src/app/analytics-charts.tsx",
        "src/app/models/model-explorer.tsx",
        // Render-heavy "use client" content pages (UI-dominant, test via E2E)
        "src/app/login/**",
        "src/app/logs/logs-content.tsx",
        "src/app/logs/logs-stats.tsx",
        "src/app/settings/**",
        "src/app/requests/requests-content.tsx",
        "src/app/clients/clients-table.tsx",
        "src/app/sessions/sessions-table.tsx",
        // Reusable analytics panels (render-heavy recharts wrappers)
        "src/components/analytics/panels/**",
        // Live indicator badge (purely visual)
        "src/components/analytics/live-indicator.tsx",
        "src/app/connect/connect-content.tsx",
        "src/app/copilot/account/account-content.tsx",
        "src/app/copilot/models/models-content.tsx",
        "src/app/models/models-content.tsx",
        // Re-export only (1 line, covered by auth.ts tests)
        "src/app/api/auth/**",
        // Chart config (color palette / axis formatters)
        "src/lib/chart-config.ts",
        // Pure type definitions (zero runtime code)
        "src/lib/types.ts",
        // Trivial browser-only hooks
        "src/hooks/use-mobile.tsx",
      ],
      thresholds: {
        statements: 90,
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
