import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Rewrite /api/* → gateway so browser requests stay same-origin and auth
  // cookies are scoped to the Web app origin. In production set GATEWAY_URL.
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
