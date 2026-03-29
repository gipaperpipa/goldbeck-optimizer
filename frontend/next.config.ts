import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow images from any domain (for map tiles, etc.)
  images: {
    unoptimized: true,
  },
  // Suppress build warnings for packages that use Node.js APIs
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      };
    }
    return config;
  },
};

export default nextConfig;
