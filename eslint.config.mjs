import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
    // OpenNext for Cloudflare build output. `.gitignore` already ignores
    // these (see docs/deployment.md); ESLint does not read `.gitignore`, so
    // without this a successful `bunx opennextjs-cloudflare build` would make
    // `bun run lint` fail on the generated server bundle.
    ".open-next/**",
    ".wrangler/**",
    // Local QA scaffolding (see .gitignore); scratch probes, not product code.
    ".qa/**",
    ".qa-*.mts",
    // Local tool worktrees (ignored via .git/info/exclude, which ESLint does
    // not read). Without this, lint scans a second copy of the tree and
    // reports every warning twice.
    ".kilo/**",
  ]),
]);

export default eslintConfig;
