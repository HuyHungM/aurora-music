/**
 * Client-bundle security and size gate (Phase 24, extended in Phase 52).
 *
 * Three jobs, all after `bun run build`:
 *
 * 1. SECURITY. Scans production client chunks for server-only implementation
 *    details that must never reach the browser.
 * 2. SECURE-CONTEXT REGRESSION. Requires a `"serviceWorker" in navigator`
 *    presence test before any compiled `.register(` call, because a
 *    source-level truthiness guard on `navigator.serviceWorker` is eliminated
 *    by the production compiler (see scanServiceWorkerGuard below).
 * 3. PERFORMANCE BUDGETS. Measures what the client actually ships and fails if
 *    it has grown past a recorded ceiling.
 *
 *   bun run verify:client-bundle [chunksDir]
 *   AURORA_RECORD_BUDGETS=1 bun run verify:client-bundle   # print new ceilings
 *
 * Exit 0 = clean, 1 = violation (secret leak, missing presence test, or budget
 * exceeded), 2 = misconfiguration (e.g. chunks dir missing — build first).
 * No dependencies, no network, Windows/PowerShell-safe.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

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

function assetFiles(directory, collected = []) {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      assetFiles(fullPath, collected);
    } else if (fullPath.endsWith(".js") || fullPath.endsWith(".css")) {
      collected.push(fullPath);
    }
  }
  return collected;
}

/**
 * Size budgets, in BYTES GZIPIPPED.
 *
 * Why gzip and not raw: raw size is an artifact of minification settings and of
 * how many chunks a bundler happens to split this build into, neither of which
 * is what a user experiences. Gzip is what actually crosses the network, and it
 * is stable enough across builds to be a meaningful regression signal. Next
 * serves Brotli in production, which is uniformly smaller still - so these
 * ceilings are the pessimistic measurement by design.
 *
 * Every threshold is a MEASURED value plus roughly a quarter of headroom, not a
 * round number someone liked. Recording the baseline that produced each number
 * is what makes a failure mean "we grew" rather than "the tool changed":
 *
 *   total JS     304.9 KB gzip measured  ->  400 KB ceiling
 *   largest JS    71.6 KB gzip measured  ->  100 KB ceiling
 *   total CSS      12.2 KB gzip measured  ->   20 KB ceiling
 *
 * The largest-chunk budget is the one that earns its keep. Total size can stay
 * flat while a single chunk doubles, which is exactly the change that turns a
 * cold start into a blank screen on a mid-range phone; a total-only budget is
 * blind to it.
 *
 * Re-baselining is a deliberate, visible act:
 * `AURORA_RECORD_BUDGETS=1 bun run verify:client-bundle` prints the numbers to
 * paste in here. It never silently rewrites them - a budget that can be raised
 * by the change it is supposed to catch is not a budget.
 */
const BUDGETS = [
  {
    id: "client-js-total",
    label: "Total client JavaScript",
    measured: 304.9 * 1024,
    limit: 400 * 1024,
  },
  {
    id: "client-js-largest",
    label: "Largest single JavaScript chunk",
    measured: 71.6 * 1024,
    limit: 100 * 1024,
  },
  {
    id: "client-css-total",
    label: "Total client CSS",
    measured: 12.2 * 1024,
    limit: 20 * 1024,
  },
];

const KIB = 1024;
const kib = (bytes) => (bytes / KIB).toFixed(1);

/**
 * Measures every shipped client asset.
 *
 * Reads each file's bytes and gzips them, rather than trusting a file size
 * reported elsewhere: the number the budget has to defend is the compressed
 * payload, and a stale figure in a table is not a measurement.
 */
export function measureAssets(directory) {
  const files = assetFiles(directory);
  let jsRaw = 0;
  let jsGzip = 0;
  let cssRaw = 0;
  let cssGzip = 0;
  let largestJsGzip = 0;
  let largestJsFile = "";

  for (const file of files) {
    const bytes = readFileSync(file);
    const gzipped = gzipSync(bytes, { level: 9 }).length;
    if (file.endsWith(".js")) {
      jsRaw += bytes.length;
      jsGzip += gzipped;
      if (gzipped > largestJsGzip) {
        largestJsGzip = gzipped;
        largestJsFile = file;
      }
    } else {
      cssRaw += bytes.length;
      cssGzip += gzipped;
    }
  }

  return {
    files: files.length,
    jsRaw,
    jsGzip,
    cssRaw,
    cssGzip,
    largestJsGzip,
    largestJsFile,
  };
}

export function checkBudgets(measurement) {
  const actual = {
    "client-js-total": measurement.jsGzip,
    "client-js-largest": measurement.largestJsGzip,
    "client-css-total": measurement.cssGzip,
  };
  const rows = BUDGETS.map((budget) => {
    const value = actual[budget.id] ?? 0;
    return {
      ...budget,
      value,
      over: value > budget.limit,
      growth:
        budget.measured > 0 ? (value - budget.measured) / budget.measured : 0,
    };
  });
  return { rows, exceeded: rows.filter((row) => row.over) };
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

/**
 * Secure-context service-worker registration gate.
 *
 * `navigator.serviceWorker` is a [SecureContext] interface: on a plain-HTTP
 * origin (a LAN/IP host, and the production deployment served over http://)
 * the property is not exposed at all, so the container is `undefined` and
 * `container.register` throws.
 *
 * This gate exists because a SOURCE-LEVEL GUARD IS NOT SUFFICIENT. The
 * registration effect guarded with `if (!container) return undefined`, which
 * is correct and which unit tests pass, and the production compiler still
 * eliminated that branch as dead code — the shipped bundle evaluated
 * `typeof container.register` on `undefined` and crashed the root layout in a
 * PlayerHost init/shutdown loop
 * (`TypeError: Cannot read properties of undefined (reading 'register')`).
 * A test that runs the TypeScript source can never see that; only a check on
 * the built chunks can.
 *
 * So: in every client chunk that both references `serviceWorker` and calls
 * `.register(`, a `"serviceWorker" in navigator` presence test must occur
 * BEFORE the call. The `in` form is what survives minification (a truthiness
 * guard on the property does not), and it is the same feature detect the
 * other two effects in this component use.
 */
export function scanServiceWorkerGuard(directory) {
  const files = chunkFiles(directory);
  const violations = [];
  let guarded = 0;
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    if (!content.includes("serviceWorker")) continue;
    const call = content.indexOf(".register(");
    if (call === -1) continue;
    guarded += 1;
    const presenceTest = content.indexOf('serviceWorker"in navigator');
    if (presenceTest === -1 || presenceTest > call) {
      violations.push({ file, presenceTest, call });
    }
  }
  return { files: files.length, guarded, violations };
}

function main() {
  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const staticDir = process.argv[2]
    ? dirname(process.argv[2])
    : join(rootDir, ".next", "static");
  const chunksDir = process.argv[2]
    ? process.argv[2]
    : join(staticDir, "chunks");
  let chunks;
  try {
    chunks = statSync(chunksDir).isDirectory() ? chunksDir : null;
  } catch {
    chunks = null;
  }
  if (!chunks) {
    console.error(
      `verify-client-bundle: chunks directory not found: ${chunksDir}\nRun \`bun run build\` first.`,
    );
    process.exit(2);
  }
  const { files, violations } = scanChunks(chunks);
  const swGuard = scanServiceWorkerGuard(chunks);

  // Size budgets are measured across the whole static tree, not just `chunks`:
  // CSS and any media-sized assets live beside the chunks, and a budget that
  // ignored them would not describe what the browser downloads.
  let measurement = null;
  let budgetFailure = null;
  try {
    measurement = measureAssets(staticDir);
  } catch (error) {
    budgetFailure = `could not measure client assets in ${staticDir}: ${error.message}`;
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `verify-client-bundle: FORBIDDEN "${violation.marker}" in ${violation.file}\n  ${violation.reason}.`,
      );
    }
    process.exit(1);
  }

  if (swGuard.violations.length > 0) {
    for (const violation of swGuard.violations) {
      console.error(
        `verify-client-bundle: service-worker registration in ${violation.file} is not preceded by a ` +
          `"serviceWorker" in navigator presence test (test at ${violation.presenceTest}, ` +
          `.register( at ${violation.call}).\n` +
          `  On a plain-HTTP origin navigator.serviceWorker is undefined, so an unguarded ` +
          `container.register throws and unmounts the app.`,
      );
    }
    process.exit(1);
  }

  if (budgetFailure) {
    console.error(`verify-client-bundle: ${budgetFailure}`);
    process.exit(1);
  }

  if (process.env.AURORA_RECORD_BUDGETS === "1") {
    const actual = {
      "client-js-total": measurement.jsGzip,
      "client-js-largest": measurement.largestJsGzip,
      "client-css-total": measurement.cssGzip,
    };
    console.log("verify-client-bundle: current measurements, gzip bytes");
    console.log(
      `  total JS ${kib(measurement.jsRaw)} KiB raw / ${kib(measurement.jsGzip)} KiB gzip across ${measurement.files} assets`,
    );
    console.log(`  largest JS chunk: ${measurement.largestJsFile}`);
    for (const budget of BUDGETS) {
      const value = actual[budget.id];
      console.log(
        `  ${budget.id}: ${Math.round(value)}  (${kib(value)} KiB; current limit ${Math.round(budget.limit)})`,
      );
    }
    console.log("Paste the values into BUDGETS only after confirming the growth is intended.");
  }

  const { rows, exceeded } = checkBudgets(measurement);
  console.log(`verify-client-bundle: client asset budgets (gzip)`);
  for (const row of rows) {
    const sign = row.growth >= 0 ? "+" : "";
    const growth =
      row.growth === 0
        ? "at baseline"
        : `${sign}${(row.growth * 100).toFixed(1)}% vs baseline`;
    console.log(
      `  ${row.over ? "OVER" : "ok  "}  ${row.label}: ${kib(row.value)} KiB / ${kib(row.limit)} KiB limit (${growth})`,
    );
  }

  if (exceeded.length > 0) {
    for (const row of exceeded) {
      console.error(
        `verify-client-bundle: BUDGET EXCEEDED - ${row.label} is ${kib(row.value)} KiB, limit ${kib(row.limit)} KiB.\n` +
          `  Either the growth is not intended, in which case find it and remove it, or it is intended, in which case\n` +
          `  re-baseline deliberately: AURORA_RECORD_BUDGETS=1 bun run verify:client-bundle`,
      );
    }
    process.exit(1);
  }

  console.log(
    `verify-client-bundle: OK (${files} client chunks scanned, ${measurement.files} assets measured, ` +
      `${swGuard.guarded} service-worker registration chunk(s) presence-tested).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
