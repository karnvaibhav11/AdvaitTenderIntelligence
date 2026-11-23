import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Set NEXT_PUBLIC_BASE_PATH=/tender when the host site mounts this app beneath that path.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  skipTrailingSlashRedirect: true,
  // Allows a second instance (for example automated checks) beside a running dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
