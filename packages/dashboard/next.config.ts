import type { NextConfig } from "next";
import { resolve } from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(__dirname, "../.."),
  },
  env: {
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
