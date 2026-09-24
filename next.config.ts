import type { NextConfig } from "next";

/**
 * Security response headers (Phase 26).
 *
 * Development:
 * - React/Next.js development tooling may require 'unsafe-eval'.
 *
 * Production:
 * - 'unsafe-eval' is intentionally NOT enabled.
 *
 * Image handling:
 * - Google OAuth profile images are served from lh3.googleusercontent.com.
 * - Other artwork may arrive from provider/CDN hosts, so CSP keeps img-src broad.
 */
const IS_DEVELOPMENT = process.env.NODE_ENV === "development";

const SCRIPT_SRC = [
  "'self'",
  "'unsafe-inline'",
  ...(IS_DEVELOPMENT ? ["'unsafe-eval'"] : []),
].join(" ");

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src ${SCRIPT_SRC}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: http: data: blob:",
  "media-src https:",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // No iframe embedding anywhere (OAuth uses top-level navigations).
  { key: "X-Frame-Options", value: "DENY" },
  // No camera/microphone/geolocation usage in the application.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
];

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
        pathname: "/**",
      },
    ],
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;

export { CONTENT_SECURITY_POLICY, SECURITY_HEADERS };
