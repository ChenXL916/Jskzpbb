import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: ['@jishi/contracts'],
  async rewrites() {
    const apiOrigin = process.env.INTERNAL_API_ORIGIN ?? 'http://127.0.0.1:3002';
    return [
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/api/:path*`
      }
    ];
  }
};

export default nextConfig;
