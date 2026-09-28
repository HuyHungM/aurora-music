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

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load Plus Jakarta Sans (the display/body voice) and Geist Mono (technical metadata).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
