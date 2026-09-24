import { describe, expect, it } from "vitest";
import nextConfig, {
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
} from "../next.config";

/**
 * Response-header regression gates (Phase 26). Assert structural security
 * properties of the served policy — strict enough to catch gutting, loose
 * enough to allow documented tuning of individual directives.
 */
describe("security headers", () => {
  it("applies the policy to every path", async () => {
    expect(typeof nextConfig.headers).toBe("function");
    const rules = await nextConfig.headers?.();
    expect(rules).toHaveLength(1);
    expect(rules?.[0]?.source).toBe("/:path*");
    const keys = (rules?.[0]?.headers ?? []).map((header) => header.key);
    expect(keys).toEqual([
      "X-Content-Type-Options",
      "Referrer-Policy",
      "X-Frame-Options",
      "Permissions-Policy",
      "Content-Security-Policy",
    ]);
  });

  it("sends baseline hardening headers", () => {
    const values = new Map(
      SECURITY_HEADERS.map((header) => [header.key, header.value]),
    );
    expect(values.get("X-Content-Type-Options")).toBe("nosniff");
    expect(values.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(values.get("X-Frame-Options")).toBe("DENY");
    expect(values.get("Permissions-Policy")).toContain("camera=()");
    expect(values.get("Permissions-Policy")).toContain("microphone=()");
    expect(values.get("Permissions-Policy")).toContain("geolocation=()");
  });

  it("keeps embedding, objects, and eval locked down", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/(^|;)\s*\*/);
  });

  it("keeps playback, workers, and actions working", () => {
    // googlevideo streams are https: media; the service worker, server
    // actions, and dev HMR sockets stay permitted.
    expect(CONTENT_SECURITY_POLICY).toMatch(/media-src[^;]*https:/);
    expect(CONTENT_SECURITY_POLICY).toMatch(/worker-src[^;]*'self'/);
    expect(CONTENT_SECURITY_POLICY).toMatch(/connect-src[^;]*'self'/);
    expect(CONTENT_SECURITY_POLICY).toMatch(/form-action[^;]*'self'/);
  });
});
