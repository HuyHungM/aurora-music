This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

[Bun](https://bun.sh) is the package manager for this repository; `bun.lock` is
the only lockfile.

```bash
bun install
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `src/app/page.tsx`. The page auto-updates as you edit the file.

## Common commands

Run every script through `bun run`; use `bunx` for one-off CLIs.

```bash
bun run build                    # production build (also generates .next/types)
bun run typecheck                # tsc --noEmit; run after build on a clean clone
bun run lint
bun run test                     # vitest unit suite
bun run test:db                  # migrate deploy + database suite
bun run start                    # serve the production build
bun run smoke:prod -- --spawn    # production smoke checks
bunx playwright test             # E2E
bunx prisma studio               # database browser
```

`bun install` runs a `postinstall` hook that generates the Prisma client, so a
fresh install produces a working tree. See `docs/deployment.md` for the release
order and `AGENTS.md` for the toolchain contract.

## Deployment

Aurora runs as a **native Next.js application on Vercel**. Vercel detects the
framework, runs `next build` and serves the app through Node.js Functions;
there is no `vercel.json`, no OpenNext adapter and no Workers bundle. Cloudflare
provides **DNS only** (the apex `auroramuzik.dpdns.org` 301-redirects to the
canonical `https://app.auroramuzik.dpdns.org`).

Production runs on **Neon**: connect the Neon Vercel integration to the project
and it writes `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct) for
you. Add `AURORA_PUBLIC_URL` and `AUTH_SECRET` by hand, then run
`bunx prisma migrate deploy` against the **direct** URL before promoting a
deployment. No CA variable is needed — Neon presents a publicly-trusted
certificate. The full procedure — environment variables, migration order,
readiness, smoke checks, TLS, backup and rollback — is in
[`docs/deployment.md`](docs/deployment.md).

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!
