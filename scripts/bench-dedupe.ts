/**
 * Benchmark: `dedupeCanonicalTracks` cost shape on a realistic collection.
 *
 * WHY THIS FILE EXISTS. `CanonicalDuplicateIndex.find` is two-tier: a Map lookup
 * on the canonical keys, and — only on a MISS — a LINEAR SCAN over every
 * identity added so far, running `TrackMatcher.match` against each. That second
 * tier runs for every NON-duplicate item, not only for duplicates, so a
 * collection with no duplicates at all still pays one full scan per item. The
 * function is therefore O(n²) in matcher calls on the most common input there
 * is — and `replaceQueue` calls it on the main thread on a user click.
 *
 * This reports the COST SHAPE, not a score: the ratio between n and 2n is ~2 for
 * a linear function and ~4 for a quadratic one. Those ratios are what move if
 * the algorithm changes, and they are comparable across machines in a way that
 * absolute milliseconds are not.
 *
 * Run with: bunx tsx scripts/bench-dedupe.ts
 */
import { dedupeCanonicalTracks } from "../src/lib/domain/track-dedupe";
import { createTrackMatcher } from "../src/lib/domain/track-matcher";
import type { Track } from "../src/lib/domain";

/**
 * `n` DISTINCT tracks with REALISTICALLY DIVERSE titles — the normal case.
 *
 * The title words are drawn from a rotating pool so that neighbouring tracks do
 * NOT share tokens. An earlier version of this benchmark used
 * `Track Number ${i} — a realistically long title`, where every single item
 * shares "track", "number", "a", "long" and "title". That made every item land in
 * the same posting bucket, which is a property of the synthetic data and not of
 * any real playlist — and it made a title-token prefilter look worthless. Both
 * shapes are measured below so the win is not overstated.
 */
const WORDS = [
  "Neon", "Harbour", "Velvet", "Lantern", "Copper", "Drift", "Willow", "Ember",
  "Cascade", "Marble", "Static", "Prism", "Hollow", "Cinder", "Aurora", "Tundra",
  "Mosaic", "Fable", "Onyx", "Zephyr", "Lagoon", "Quartz", "Cobalt", "Saffron",
];
function distinctTracks(n: number): Track[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `bench-${i}`,
    provider: "youtube",
    providerTrackId: `bench-${i}`,
    title: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7 + 3) % WORDS.length]} ${WORDS[(i * 11 + 5) % WORDS.length]}`,
    artistId: `artist-${i % 25}`,
    artistName: `Artist ${i % 25}`,
    duration: 120_000 + i * 1_000,
  }));
}

/** Every title shares the same tokens — the prefilter's worst case. */
function sharedWordTracks(n: number): Track[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `shared-${i}`,
    provider: "youtube",
    providerTrackId: `shared-${i}`,
    title: `Track Number ${i} — a realistically long title`,
    artistId: `artist-${i % 25}`,
    artistName: `Artist ${i % 25}`,
    duration: 120_000 + i * 1_000,
  }));
}

function timeMs(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

function row(n: number, ms: number): string {
  return `  n=${String(n).padStart(4)}  ${ms.toFixed(1).padStart(8)} ms`;
}

console.log("dedupeCanonicalTracks — all-distinct (no duplicates; the normal case)");
const sizes = [100, 200, 400, 800];
dedupeCanonicalTracks(distinctTracks(8)); // warm the JIT

const timings = sizes.map((n) => {
  const items = distinctTracks(n);
  const ms = timeMs(() => {
    const out = dedupeCanonicalTracks(items);
    if (out.kept.length !== n) throw new Error("collapse lost a distinct track");
    if (out.duplicates.length !== 0) throw new Error("invented a duplicate");
  });
  console.log(row(n, ms));
  return { n, ms };
});

for (let i = 1; i < timings.length; i += 1) {
  const prev = timings[i - 1] as { n: number; ms: number };
  const cur = timings[i] as { n: number; ms: number };
  const inputRatio = cur.n / prev.n;
  const timeRatio = cur.ms / Math.max(prev.ms, 0.01);
  // ~2 = linear, ~4 = quadratic.
  const shape = timeRatio > 3 ? "QUADRATIC" : "sub-quadratic";
  console.log(
    `  ratio ${prev.n}->${cur.n}: input x${inputRatio.toFixed(0)}, time x${timeRatio.toFixed(2)}  [${shape}]`,
  );
}

console.log("");
console.log("dedupeCanonicalTracks — every item's keys already claimed in-run (tier-1 fast path)");
// Each run starts with an EMPTY index, so re-running the same list reproduces
// the all-distinct case rather than the fast path. The fast path needs the
// canonical keys to already be claimed WITHIN one run: two copies of the same
// set, where the second half resolves on the Map and never reaches the matcher.
const twice = [...distinctTracks(400), ...distinctTracks(400)];
dedupeCanonicalTracks(twice.slice(0, 8));
const fastMs = timeMs(() => {
  const out = dedupeCanonicalTracks(twice);
  if (out.kept.length !== 400) throw new Error("fast path kept the wrong count");
  if (out.duplicates.length !== 400) throw new Error("expected every repeat to match");
});
console.log(row(800, fastMs));

console.log("");
console.log("dedupeCanonicalTracks — 800 distinct items whose TITLES ALL SHARE TOKENS");
console.log("  (the title-token prefilter's worst case: every item is in every bucket)");
const sharedWords = sharedWordTracks(800);
dedupeCanonicalTracks(sharedWords.slice(0, 8));
const sharedMs = timeMs(() => {
  const out = dedupeCanonicalTracks(sharedWords);
  if (out.kept.length !== 800) throw new Error("collapse lost a distinct track");
});
console.log(row(800, sharedMs));

console.log("");
console.log("MATCHER CALLS — the machine-independent measure of what the prefilter changed.");
console.log("  Before the prefilter, tier 2 scanned every survivor, so the count was");
console.log("  exactly n(n-1)/2. This counts it as the code actually runs now.");

function countMatcherCalls(items: Track[]): { calls: number; kept: number } {
  const real = createTrackMatcher();
  let calls = 0;
  const counting = {
    match: (left: never, right: never) => {
      calls += 1;
      return real.match(left, right);
    },
  };
  const out = dedupeCanonicalTracks(items, { matcher: counting as never });
  return { calls, kept: out.kept.length };
}

for (const n of [200, 400, 800]) {
  const { calls, kept } = countMatcherCalls(distinctTracks(n));
  if (kept !== n) throw new Error("collapse lost a distinct track");
  const quadratic = (n * (n - 1)) / 2;
  console.log(
    `  n=${String(n).padStart(4)}  ${String(calls).padStart(7)} calls  (was ${quadratic}  -> ${(quadratic / calls).toFixed(1)}x fewer)`,
  );
}

const sharedCount = countMatcherCalls(sharedWordTracks(800));
console.log(
  `  shared-word titles, n=800: ${sharedCount.calls} calls (was 319600 -> ${(319600 / sharedCount.calls).toFixed(2)}x fewer)`,
);

console.log("");
console.log("matcher-tier isolation — 800 distinct items sharing ONE artist");
const oneArtist = Array.from({ length: 800 }, (_, i) => ({
  id: `single-${i}`,
  provider: "youtube",
  providerTrackId: `single-${i}`,
  title: `Track ${i}`,
  artistId: "only-artist",
  artistName: "Only Artist",
}));
dedupeCanonicalTracks(oneArtist.slice(0, 8));
const singleMs = timeMs(() => {
  dedupeCanonicalTracks(oneArtist);
});
console.log(row(800, singleMs));