import type { NextConfig } from 'next';

const previewOrigins =
  process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: '/providers', destination: '/settings/providers', permanent: true },
      { source: '/tools', destination: '/settings/tools', permanent: true },
      { source: '/suppressions', destination: '/operations/suppressions', permanent: true },
      { source: '/handoffs', destination: '/operations/handoffs', permanent: true },
    ];
  },
  allowedDevOrigins: ['localhost', '127.0.0.1', ...previewOrigins],
  transpilePackages: [
    '@winsendotai/ovo-contracts',
    '@winsendotai/ovo-runtime',
    '@winsendotai/ovo-ui',
  ],
};

export default nextConfig;
