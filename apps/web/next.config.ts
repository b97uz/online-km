import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@km/db", "@km/shared"],
  serverExternalPackages: ["xlsx"],
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;
