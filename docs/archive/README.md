# Archived reports (historical)

This directory holds **historical** engineering reports. They are kept for
provenance only and are **not** part of the current specification.

Aurora Music runs as a native Next.js application on Vercel against Aiven
PostgreSQL (`docs/deployment.md`). It no longer deploys to Cloudflare Workers
and no longer uses OpenNext, vinext, Wrangler or Hyperdrive. Several reports in
this folder describe that superseded runtime; where they conflict with the
canonical documents below, the canonical documents win.

Current sources of truth (do not treat anything in this folder as authoritative):

- `PRODUCT_SPEC.md` — product scope.
- `ARCHITECTURE.md` — architecture and invariants.
- `docs/scope-boundaries.md` — deliberate exclusions/deferrals.
- `docs/security.md` — operational security posture.
- `docs/deployment.md` — release/deployment procedure.
- `AGENTS.md` — toolchain and documentation rules.

> Historical note: any command blocks naming `wrangler`, `opennextjs-cloudflare`,
> a Hyperdrive binding, or a `cloudflared` tunnel are **obsolete**. Do not run
> them. Deploy through Vercel as described in `docs/deployment.md`.
