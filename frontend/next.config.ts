import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Set STATIC_EXPORT=1 to emit a fully static site in `out/` (every page is static).
  ...(process.env.STATIC_EXPORT === "1" ? { output: "export" as const } : {}),
};

export default nextConfig;
