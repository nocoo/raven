/**
 * Centralized app version constant.
 *
 * Injected at build time by next.config.ts via the `env` block,
 * which reads the monorepo root package.json (single source of truth).
 *
 * Works in both server and client components.
 */
export const APP_VERSION: string =
  process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
