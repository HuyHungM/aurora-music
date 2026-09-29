import type { NextConfig } from "next";

import { getAllowedDevOrigins } from "./src/lib/config/dev-origins";

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

/**
 * Dev-server host allowlist (see src/lib/config/dev-origins.ts). Empty unless
 * `next dev` is running, so builds and tests see the exact config they saw
 * before this option existed.
 */
const allowedDevOrigins = getAllowedDevOrigins();

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
  // Development only: allow this machine's real hostnames (loopback + the
  // routable LAN/VPN interface addresses) to request dev-only resources.
  // Without them Next 403s the HMR websocket and `/__nextjs_*` endpoints for
  // every host other than `localhost`, which leaves the page as inert
  // server HTML - nothing hydrates, so the app looks broken from a phone on
  // the LAN (and even from `127.0.0.1`). See src/lib/config/dev-origins.ts.
  // Empty outside `next dev`, so production config is unchanged; entries are
  // exact hostnames, never "*".
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),

  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
        pathname: "/**",
      },
    ],
  },

  // Node runtime externals. `next build` / `next start` (local `next dev`, the
  // E2E harness, Vercel Functions and the typecheck type graph) run the
  // application on Node, where `pg` must stay external rather than be bundled
  // by the server compiler. The driver is reached through Prisma's
  // `@prisma/adapter-pg`, so only `pg` needs the exemption.
  serverExternalPackages: ["pg"],

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
