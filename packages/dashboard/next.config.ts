import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "localhost",
    "*.hexly.ai",
    "*.dev.hexly.ai",
  ],
};

export default nextConfig;
