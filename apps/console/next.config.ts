import type { NextConfig } from 'next';

const previewOrigins =
  process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];

const nextConfig: NextConfig = {
  allowedDevOrigins: previewOrigins,
  transpilePackages: [
    '@winsendotai/ovo-contracts',
    '@winsendotai/ovo-runtime',
    '@winsendotai/ovo-ui',
  ],
};

export default nextConfig;
