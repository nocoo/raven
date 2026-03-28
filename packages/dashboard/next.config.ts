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
    NEXT_PUBLIC_AUTH_ENABLED:
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.NEXTAUTH_SECRET
        ? "1"
        : "",
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
