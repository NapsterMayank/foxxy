import type { NextConfig } from 'next';

/**
 * The third deployable — 06-FRONTEND-SEPARATION-PLAN.md, D-402.
 *
 * `website/` is marketing, `frontend/` is the product, this is operations. All
 * three share no runtime code; `npm run check:isolation` proves it by walking
 * the source tree rather than by trusting a lint config.
 *
 * NOT DEPLOYED PUBLICLY TO BEGIN WITH. It runs locally against the development
 * database while the panel is looked at for the first time; exposure is a
 * separate decision, and the headers below are the posture it would need.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // An operations panel shows masked learner data. Nothing here should
          // ever be indexed, cached by an intermediary, or previewed.
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};

export default nextConfig;
