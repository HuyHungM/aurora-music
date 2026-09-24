/**
 * Client-bundle security gate (Phase 24).
 *
 * Scans production client chunks for server-only implementation details
 * that must never reach the browser. Run after `npm run build`:
 *
 *   node scripts/verify-client-bundle.mjs [chunksDir]
 *
 * Exit 0 = clean, 1 = violation (lists file + marker + remediation),
 * 2 = misconfiguration (e.g. chunks dir missing — build first).
 * No dependencies, no network, Windows/PowerShell-safe.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN = [
  { marker: "youtubei", reason: "YouTube library must stay server-side" },
  { marker: "Innertube", reason: "Innertube internals must stay server-side" },
  { marker: "client_secret", reason: "OAuth secrets must stay server-side" },
  { marker: "access_token", reason: "OAuth tokens must stay server-side" },
  { marker: "refresh_token", reason: "OAuth tokens must stay server-side" },
  { marker: "YOUTUBE_API_KEY", reason: "API keys must stay server-side" },
  { marker: "SPOTIFY_CLIENT", reason: "Spotify credentials must stay server-side" },
  { marker: "AUTH_SECRET", reason: "Auth secrets must stay server-side" },
];

function chunkFiles(directory, collected = []) {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      chunkFiles(fullPath, collected);
    } else if (fullPath.endsWith(".js")) {
      collected.push(fullPath);
    }
  }
  return collected;
}

export function scanChunks(directory) {
  const files = chunkFiles(directory);
  const violations = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const { marker, reason } of FORBIDDEN) {
      if (content.includes(marker)) {
        violations.push({ file, marker, reason });
      }
    }
  }
  return { files: files.length, violations };
}

function main() {
  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const chunksDir = process.argv[2] ?? join(rootDir, ".next", "static", "chunks");
  let chunks;
  try {
    chunks = statSync(chunksDir).isDirectory() ? chunksDir : null;
  } catch {
    chunks = null;
  }
  if (!chunks) {
    console.error(
      `verify-client-bundle: chunks directory not found: ${chunksDir}\nRun \`npm run build\` first.`,
    );
    process.exit(2);
  }
  const { files, violations } = scanChunks(chunks);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `verify-client-bundle: FORBIDDEN "${violation.marker}" in ${violation.file}\n  ${violation.reason}.`,
      );
    }
    process.exit(1);
  }
  console.log(`verify-client-bundle: OK (${files} client chunks scanned).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
