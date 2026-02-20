import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@km/db", "@km/shared"],
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;
