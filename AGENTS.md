<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Aurora Music — canonical sources of truth

- `PRODUCT_SPEC.md` — intended current product scope.
- `ARCHITECTURE.md` — technical architecture and invariants.
- `docs/scope-boundaries.md` — deliberate exclusions/deferred features.
- `docs/security.md` — operational security posture.
- `docs/deployment.md` — release/deployment procedure.
- Phase reports (`PHASE_*.md`, `MUSIC_PROVIDER_PLAN.md`) are historical
  evidence, not the ongoing specification.

Behavior changes must update `PRODUCT_SPEC.md` and/or `ARCHITECTURE.md`
in the same change; new exclusions/deferrals must update
`docs/scope-boundaries.md`. This is a documentation/source-of-truth rule —
Phase 32 changed no product behavior.
