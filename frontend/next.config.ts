import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow images from any domain (for map tiles, etc.)
  images: {
    unoptimized: true,
  },
  // Empty turbopack config to silence the webpack→turbopack migration error
  // Next.js 16 uses Turbopack by default; the webpack fallbacks are no longer needed
  turbopack: {},
};

export default nextConfig;
