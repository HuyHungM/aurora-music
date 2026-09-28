import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * OpenNext Cloudflare adapter configuration.
 *
 * This file is committed on purpose: Cloudflare's build must start from
 * repository configuration instead of `wrangler deploy` auto-running an
 * interactive `@opennextjs/cloudflare migrate` (which rewrites next.config.ts,
 * package.json, .dev.vars and public/_headers on the build machine). See
 * docs/deployment.md.
 *
 * No incremental-cache override is configured. Aurora is a dynamic,
 * auth/DB-backed application (API routes, Auth.js, Prisma); it does not rely
 * on ISR/`revalidate` caching, so R2 and the self-reference service binding
 * are intentionally not required. If ISR caching is ever introduced, add the
 * documented R2 incremental cache here and the matching bindings in
 * wrangler.jsonc (https://opennext.js.org/cloudflare/caching).
 */
export default defineCloudflareConfig();
