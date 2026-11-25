import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Import files (CSV exports from another POS) can be several megabytes.
  experimental: { serverActions: { bodySizeLimit: '12mb' } },
  // In the single-container deployment the API listens privately; devices and
  // webhooks reach it through the web app's public address at /api.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.INTERNAL_API_URL ?? 'http://127.0.0.1:4000'}/:path*` }];
  },
};

export default nextConfig;
