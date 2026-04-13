import type { NextConfig } from "next";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dir =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const rootPkg = require("../../package.json") as { version: string };

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(__dir, "../.."),
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: rootPkg.version,
    // NOTE: Auth mode detection moved to runtime API (/api/auth/config).
    // Build-time NEXT_PUBLIC_AUTH_ENABLED was removed to fix the mismatch
    // when building without env vars then running with them (VPS deployment).
    // See: docs/14-vps-deployment.md
  },
  allowedDevOrigins: [
    "localhost",
    "raven.dev.hexly.ai",
  ],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
    ],
  },
};

export default nextConfig;
