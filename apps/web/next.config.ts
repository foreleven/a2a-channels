import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Rewrite /api/* → gateway during local dev so the browser never makes
  // cross-origin requests (avoids CORS issues when running `next dev`).
  // In production set NEXT_PUBLIC_GATEWAY_URL and point it at the gateway.
  async rewrites() {
    const gatewayUrl =
      process.env["GATEWAY_URL"] ?? "http://localhost:7890";
    return [
      {
        source: "/api/:path*",
        destination: `${gatewayUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
