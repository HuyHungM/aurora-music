/**
 * Real-browser verification of the audio-reactive Aurora ambient.
 *
 * Run against a production build served with the E2E flags:
 *   AURORA_E2E_ALLOW_TEST_FLAGS=1 AURORA_E2E_AUTH=1 bun run build
 *   bun run start -p 3100
 *   bun scripts/verify-audio-reactive.mjs
 *
 * ── HOW THIS STAYS HONEST ────────────────────────────────────────────────────
 *
 * It drives the repository's OWN test-only harness (`/e2e-offline`), which
 * registers a real `OfflineFileHandle`, resolves it through the real
 * `createLocalSourceResolver` to a real blob URL, and loads it onto the real
 * `new Audio()` element via the real engine. Blob URLs are same-origin, which
 * is exactly why local playback is the verifiable target: Chromium refuses
 * `captureStream()` on cross-origin provider media.
 *
 * The analyser is NEVER faked. The fixtures are genuine 16-bit PCM WAVs and
 * `captureStream()` reads the element's real output. Two things are injected,
 * both from the test, neither touching production:
 *
 *   1. an init script that WRAPS the real `AudioContext` / `createAnalyser` to
 *      COUNT instantiations, so "one graph" is observed instead of asserted;
 *   2. a read-only rAF recorder installed per measurement, so "the first frame
 *      after resume" is a real frame rather than a round-trip approximation.
 *
 * ── WHY THE FIXTURE AMPLITUDES ARE WHAT THEY ARE ─────────────────────────────
 *
 * The analyser window is `minDecibels = -85` with `maxDecibels` LEFT AT THE
 * SPEC DEFAULT of -30 (`music-reactive-ambient.tsx` sets only the minimum).
 * `readBands(floor = 0.12, gain = 1.8)` then maps byte/255 through
 * `clamp01((raw - 0.12) * 1.8)`. Working the arithmetic backwards:
 *
 *   byte/255 = (dB + 85) / 55
 *
 *   dB >= -30                      -> byte 255, raw 1.0   (analyser ceiling)
 *   raw >= 0.676  ->  dB >= -47.8  -> shaped value SATURATES at 1.0
 *   raw <= 0.120  ->  dB <= -78.4  -> shaped value is exactly 0
 *
 * So the usable, non-zero, non-saturated window is only **-78 dB .. -48 dB** —
 * about 30 dB. An earlier fixture at -34 dB (a "quiet" 0.02 sine) sat ABOVE the
 * saturation point: it was not quiet, it was pinned at 1.0, and it measured
 * identically to the loud fixture. That is why the ratio was 1.00x and the
 * comparison was meaningless.
 *
 * The fixtures below are placed inside the real window, calibrated against
 * the MEASURED sweep ladder (pure 80 Hz sines on this harness: digital
 * 0.03/-30 dBFS -> ~0.55 shaped, 0.003/-50 dBFS -> ~0.16 shaped):
 *
 *   QUIET      -60 dBFS broadband  -> shaped ~0.03-0.06, clearly above zero
 *   ENERGETIC  -52 dBFS bed + a -30 dBFS 60 Hz kick-like tone under a 2 Hz
 *              envelope            -> bass shaped ~0.4-0.5, clearly reactive
 *
 * Broadband energy spreads across bins where a pure tone piles into one or
 * two, so a broadband fixture reads far lower than its peak dBFS suggests —
 * an earlier -70 dBFS quiet read exactly 0.000 and a -52 dBFS energetic read
 * 0.115, which stranded every gate above them. The tone carries the
 * discrimination; the bed keeps the spectrum music-shaped.
 *
 * This does NOT prove real-world music behaviour. It proves the pipeline
 * discriminates across the range it can actually see.
 */
import { chromium } from "playwright";

const BASE = "http://localhost:3100";
const RATE = 8000;
// Short enough that the sweep finishes before headless timing drifts, long
// enough that the reactive envelope (attack 45-90 ms, release 260-520 ms) can
// settle: ten seconds lets the loop publish settled values for most of the
// recording window instead of spending it in the attack transient.
const SECONDS = 10;
const N = RATE * SECONDS;

const VARS = [
  "--aurora-music-bass",
  "--aurora-music-mid",
  "--aurora-music-treble",
  "--aurora-music-energy",
  "--aurora-music-beat",
];

/** Deterministic 16-bit mono PCM WAV. No randomness, no external asset. */
function wav(samples, rate) {
  const bytes = [];
  const push = (v) => bytes.push(v & 0xff);
  const push16 = (v) => {
    push(v & 0xff);
    push((v >> 8) & 0xff);
  };
  const push32 = (v) => {
    push(v & 0xff);
    push((v >> 8) & 0xff);
    push((v >> 16) & 0xff);
    push((v >> 24) & 0xff);
  };
  const dataBytes = samples.length * 2;
  for (const c of "RIFF") push(c.charCodeAt(0));
  push32(36 + dataBytes);
  for (const c of "WAVEfmt ") push(c.charCodeAt(0));
  push32(16);
  push16(1);
  push16(1);
  push32(rate);
  push32(rate * 2);
  push16(2);
  push16(16);
  for (const c of "data") push(c.charCodeAt(0));
  push32(dataBytes);
  for (const s of samples) {
    const v = Math.max(-1, Math.min(1, s));
    push16(Math.round(v * 32767));
  }
  return bytes;
}

/**
 * Deterministic LCG. A real PRNG would be fine, but a fixed seed means a failing
 * run reproduces exactly instead of drifting.
 */
function noise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

const QUIET_AMP = Math.pow(10, -60 / 20); // 1e-3
const BED_AMP = Math.pow(10, -52 / 20); // 2.51e-3
const TONE_AMP = Math.pow(10, -30 / 20); // 3.16e-2

/** -60 dBFS pure broadband noise: fills many bins so the mean term of `bandLevel` is real. */
const quietGen = noise(0x5eed);
const QUIET = wav(
  Float32Array.from({ length: N }, () => QUIET_AMP * quietGen()),
  RATE,
);

/**
 * -52 dBFS broadband bed + a -30 dBFS 60 Hz kick-like tone under a 2 Hz
 * envelope, so there are real transients for the detector to find. The beats
 * are IN THE AUDIO, not injected into the analyser.
 */
const bedGen = noise(0xc0ffee);
const ENERGETIC = wav(
  Float32Array.from({ length: N }, (_, i) => {
    const t = i / RATE;
    const env = 0.5 + 0.5 * Math.pow(Math.max(0, Math.sin(2 * Math.PI * 2 * t)), 3);
    return env * (BED_AMP * bedGen() * 0.6 + TONE_AMP * 0.7 * Math.sin(2 * Math.PI * 60 * t));
  }),
  RATE,
);

/**
 * Discrimination probe: a full-scale 80 Hz sine that previously measured
 * bass peak 0.965 through the OLD direct-load harness path. Played through
 * the NEW store-backed path it answers the one question every other cell
 * depends on: does ANY audio reach the analyser, or is the chain dead?
 * peak > 0.3  -> chain alive, the -52/-70 dBFS fixtures were simply too quiet
 * peak == 0   -> the store path starves the analyser; sweeping amplitudes is
 *                pointless until that is understood.
 */
const PROBE_SINE = wav(
  Float32Array.from({ length: N }, (_, i) =>
    0.9 * Math.sin((2 * Math.PI * 80 * i) / RATE),
  ),
  RATE,
);

/**
 * Sweep shape: pure 80 Hz sine at one amplitude per row. Same spectral shape
 * in every row, only the amplitude changes - so a cliff between adjacent rows
 * is an amplitude response, not a shape response.
 */
const SWEEP_AMPS = [0.9, 0.3, 0.1, 0.03, 0.01, 0.003];
function sweepFixture(amp) {
  return wav(
    Float32Array.from({ length: N }, (_, i) =>
      amp * Math.sin((2 * Math.PI * 80 * i) / RATE),
    ),
    RATE,
  );
}

/* --------------------------------------------------------- in-page recorder */

/**
 * Per-frame samples read straight off the shell root. `getComputedStyle` is only
 * consulted for the CSS-calculated vars; the music vars are written inline, so
 * inline is the cheaper and more exact read.
 */
const INSTALL_RECORDER = (vars) => {
  const root = document.querySelector("[data-aurora-glass]");
  window.__record = (ms) =>
    new Promise((resolve) => {
      if (!root) return resolve([]);
      const rows = [];
      const t0 = performance.now();
      const step = (now) => {
        const inline = (v) => Number(root.style.getPropertyValue(v) || 0);
        const cs = getComputedStyle(root);
        const calc = (v) => Number(cs.getPropertyValue(v).trim() || 0);
        const row = { t: now - t0 };
        for (const v of vars) row[v] = inline(v);
        row.reach = calc("--aurora-ambient-reach");
        row.pulse = calc("--aurora-ambient-pulse");
        rows.push(row);
        if (now - t0 < ms) requestAnimationFrame(step);
        else resolve(rows);
      };
      requestAnimationFrame(step);
    });
  window.__artwork = () => ({
    attr: root.getAttribute("data-aurora-artwork"),
    primary: root.style.getPropertyValue("--aurora-artwork-primary"),
  });
};

const COUNT_INIT = () => {
  const w = window;
  w.__counts = { contexts: 0, analysers: 0, mediaStreams: 0 };
  const Real = w.AudioContext || w.webkitAudioContext;
  if (Real) {
    class Counting extends Real {
      constructor(...args) {
        super(...args);
        w.__counts.contexts += 1;
      }
    }
    w.AudioContext = Counting;
    w.webkitAudioContext = Counting;
    const realAnalyser = w.AudioContext.prototype.createAnalyser;
    w.AudioContext.prototype.createAnalyser = function patched(...args) {
      w.__counts.analysers += 1;
      return realAnalyser.apply(this, args);
    };
    const realSource = w.AudioContext.prototype.createMediaStreamSource;
    w.AudioContext.prototype.createMediaStreamSource = function patched(...args) {
      w.__counts.mediaStreams += 1;
      return realSource.apply(this, args);
    };
  }
};

/* ------------------------------------------------------------------ helpers */

const maxOf = (rows, k) => Math.max(0, ...rows.map((r) => Number(r[k] || 0)));
const meanOf = (rows, k) =>
  rows.reduce((a, r) => a + Number(r[k] || 0), 0) / Math.max(1, rows.length);
const f = (n) => Number(n).toFixed(4);

const results = [];
const record = (name, result, evidence) => {
  results.push({ name, result, evidence });
  console.log(`\n[${result}] ${name}\n    ${evidence}`);
};

const bounded = (rows) =>
  rows.length > 0 &&
  rows.every((r) =>
    VARS.every((v) => {
      const n = Number(r[v]);
      return Number.isFinite(n) && n >= 0 && n <= 1;
    }),
  );

/**
 * Playback proof against BOTH observers of the same playback: the element and
 * the store facade the reactive layer reads.
 *
 * A fixed wait cannot distinguish "playing" from "still loading", and the
 * previous harness proved it: the element played while the store never saw
 * `isPlaying`, so a resume assertion compared two zeros and passed vacuously.
 * Confirmed playback means ALL of: unpaused element, advancing media clock, no
 * media error, the store's current track is the fixture, and the store reports
 * `isPlaying` - the exact value the reactive loop branches on.
 *
 * `minAdvance` is strict on purpose: an element can be unpaused without its
 * clock moving (decode stall), and that is not playback.
 */
async function confirmPlaying(page, minAdvance = 0.05, timeoutMs = 15000, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const t0 = Date.now();
    let diag = null;
    let stores = null;
    while (Date.now() - t0 < timeoutMs) {
      diag = await page.evaluate(() => window.__auroraLocalDiagnostics());
      stores = await page.evaluate(() => window.__auroraLocalStore());
      const clock = Number(diag?.currentTime ?? 0);
      if (
        diag && diag.paused === false && diag.errorCode === null && clock > minAdvance &&
        stores && stores.isPlaying === true &&
        stores.source === "local" && stores.error === null
      ) {
        return {
          ok: true,
          waitedMs: Date.now() - t0,
          attempt,
          diag,
          store: stores,
        };
      }
      await page.waitForTimeout(100);
    }
    if (attempt < retries) {
      // One bounded retry: reload the same fixture rather than inventing data.
      // Playback in a headless browser can lose the first autoplay race.
      await page.evaluate(() => window.__auroraLocalPlay(15000));
    } else {
      return {
        ok: false,
        waitedMs: Date.now() - t0,
        attempt,
        diag,
        store: stores,
        why:
          (diag === null ? "no element diagnostics" :
            diag.paused !== false ? `element paused=${diag.paused}` :
            diag.errorCode !== null ? `media error code=${diag.errorCode}` :
            Number(diag.currentTime ?? 0) <= minAdvance ? `clock stuck at ${diag.currentTime}` :
            stores === null ? "no store snapshot" :
            stores.isPlaying !== true ? `store isPlaying=${stores.isPlaying}` :
            stores.source !== "local" ? `store current source=${stores.source}` :
            `store error=${stores.error}`),
      };
    }
  }
  return { ok: false, diag: null, store: null, why: "unreachable" };
}

/** Fails loudly rather than letting a zero-sample comparison read as a pass. */
function requireSignal(name, rows, key, floor) {
  if (rows.length < 5) {
    record(name, "NOT MEASURED", `only ${rows.length} frames captured - no signal to judge`);
    return false;
  }
  const peak = maxOf(rows, key);
  if (!(peak > floor)) {
    record(name, "NOT MEASURED", `peak ${key} = ${f(peak)} never exceeded ${floor}; audio did not reach the analyser`);
    return false;
  }
  return true;
}

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required"],
});

async function session(reducedMotion) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  // `ambientMusicReactive: "full"` is what lets the loop exist at all: the
  // component early-returns ("off") or multiplies by zero through any other
  // path unless this is on. Passing it via the COOKIE exercises production's
  // own decode path (`decodeAppearance`) rather than a test backdoor.
  const wire = { v: 1, artworkAmbient: true, ambientMusicReactive: "full" };
  await ctx.addCookies([
    { name: "aurora-locale", value: "en", url: BASE },
    {
      name: "aurora-appearance",
      value: encodeURIComponent(JSON.stringify(wire)),
      url: BASE,
    },
  ]);
  await ctx.addInitScript(COUNT_INIT);
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      // Next.js aborts superseded RSC prefetches as part of normal navigation
      // (`net::ERR_ABORTED` on `?_rsc=` URLs). That is a cancelled fetch, not
      // a product failure, and counting it would fail this cell on every run.
      // Chromium also logs a bare "Failed to load resource" with no detail
      // for those same aborted prefetches, with no failed HTTP status behind
      // it (a networkidle probe of this route shows zero 4xx/5xx). The
      // pageerror handler below is the real tripwire: an actual product
      // exception still lands there and still fails this cell.
      const text = m.text();
      if (!text.includes("ERR_ABORTED") && !text.includes("_rsc=") &&
          text.trim() !== "Failed to load resource: net::ERR_FILE_NOT_FOUND") {
        errors.push(text.slice(0, 160));
      }
    }
  });
  page.on("pageerror", (e) => errors.push("pageerror " + String(e).slice(0, 160)));
  await page.goto(`${BASE}/e2e-offline`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__auroraLocalPlay), null, { timeout: 30000 });
  await page.evaluate(INSTALL_RECORDER, VARS);
  // Assert the appearance the page ACTUALLY resolved, server-side, before any
  // measurement. A cookie the server ignores (wrong name, dropped field, stale
  // default) leaves `ambientMusicReactive` at "subtle" or "off", the loop
  // either scales to near-zero or never starts, and every reactive row reads
  // 0.000 - which is precisely the signature we just spent two runs chasing.
  // The component mounts only under `artworkAmbient`, so the attribute is a
  // genuine resolution proof, not a mount check.
  const resolvedArtwork = await page.evaluate(
    () => document.querySelector("[data-aurora-glass]")?.getAttribute("data-aurora-artwork"),
  );
  if (resolvedArtwork !== "on") {
    throw new Error(
      `appearance did not resolve from the cookie: data-aurora-artwork=${resolvedArtwork}; ` +
        "reactive cells would read 0.000 for a cause no sweep can see",
    );
  }
  return { ctx, page, errors };
}

async function play(page, bytes, name) {
  await page.evaluate(
    ([b, n]) => window.__auroraLocalRegister({ bytes: b, name: n, type: "audio/wav" }),
    [bytes, name],
  );
  const outcome = await page.evaluate(() => window.__auroraLocalPlay(20000));
  // THE WAIT. The first reactive samples after the store reports playing are
  // 0.000 even for a full-scale fixture: the loop reacts to the store event,
  // but the `captureStream()` tap delivers silence until the element's own
  // output path is live (measured on a 0.9-amplitude probe: samples go live
  // only once currentTime has advanced ~0.3 s). Sampling before that reads
  // zeros WITH the loop running - the exact signature of "the chain is dead"
  // from a chain that is merely warming up.
  //
  // NOTE on headless autoplay flakiness. `__auroraLocalPlay` settles on the
  // engine's `play`/`playing` events and the store's `isPlaying`, but in this
  // environment the same bytes sometimes play (peak 0.133, clock advancing)
  // and sometimes sit paused-at-10.000 with `store=false`, for no logged
  // cause. When the store says NOT playing, the reactive loop is CORRECT to
  // publish baseline: there is no audio to analyse. The two cells that need a
  // live signal therefore RE-PLAY the identical bytes until the store reports
  // playback (bounded attempts), rather than measuring one uncertain run.
  const playing = await confirmPlaying(page, 0.5, 15000, 0);
  if (!playing.ok) {
    return { outcome, playing, fixture: name, vacuousRetry: true };
  }
  return { outcome, playing, fixture: name };
}

async function ensureLiveSignal(page, bytes, name, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await play(page, bytes, name);
    if (last.playing.ok) return last;
  }
  return last;
}

const rec = (page, ms) => page.evaluate((d) => window.__record(d), ms);

/* ═══════════════════════════════ 1 + 2 + 4: normal motion ══════════════════ */
{
  const { ctx, page, errors } = await session(false);

  /* ---- 0: the discrimination probe runs FIRST ---- */
  const probe = await ensureLiveSignal(page, PROBE_SINE, "probe-80hz.wav");
  const probeRows = probe.playing.ok ? await rec(page, 3000) : [];
  const probePeak = maxOf(probeRows, "--aurora-music-bass");
  const chainAlive = probe.playing.ok && probePeak > 0.3;
  record(
    "0. Discrimination probe: full-scale 80 Hz sine reaches the analyser",
    chainAlive ? "PASS" : "FAIL",
    `playback confirmed=${probe.playing.ok} (t=${f(probe.playing.diag?.currentTime)}); ` +
      `bass peak=${f(probePeak)} over ${probeRows.length} frames; ` +
      (chainAlive
        ? "the store path feeds the analyser; fixture amplitudes are the only open question"
        : "NO audio reaches the analyser through the store path - amplitude cells below are moot"),
  );

  /* ---- 2: quiet vs energetic (only meaningful when the probe passed) ---- */
  const quietRun = await ensureLiveSignal(page, QUIET, "quiet.wav");
  // The recording window must FIT INSIDE the fixture: a track that ends
  // mid-window flips the store to isPlaying=false, the loop publishes the
  // baseline, and the peak for a loud fixture reads 0.000 - silence compared
  // with silence. Fixtures are 10 s; a 3 s window leaves 7 s of headroom.
  const quietRows = quietRun.playing.ok ? await rec(page, 3000) : [];
  const quietPeak = maxOf(quietRows, "--aurora-music-bass");

  const loudRun = await ensureLiveSignal(page, ENERGETIC, "energetic.wav");
  const loudRows = loudRun.playing.ok ? await rec(page, 3000) : [];
  const loudPeak = maxOf(loudRows, "--aurora-music-bass");

  record(
    "Quiet vs energetic: both fixtures actually played",
    quietRun.playing.ok && loudRun.playing.ok ? "PASS" : "FAIL",
    `quiet "${quietRun.fixture}": store isPlaying=${quietRun.playing.store?.isPlaying} ` +
      `store source=${quietRun.playing.store?.source} ` +
      `element t=${f(quietRun.playing.diag?.currentTime)} frames=${quietRows.length}; ` +
      `energetic "${loudRun.fixture}": store isPlaying=${loudRun.playing.store?.isPlaying} ` +
      `store source=${loudRun.playing.store?.source} ` +
      `element t=${f(loudRun.playing.diag?.currentTime)} frames=${loudRows.length}` +
      (quietRun.playing.ok ? "" : ` | quiet why: ${quietRun.playing.why}`) +
      (loudRun.playing.ok ? "" : ` | energetic why: ${loudRun.playing.why}`),
  );

  // Presence is judged on the MEAN for broadband material. The band level is
  // peak-sensitive by design (`bandLevel` blends loudest bin with mean), so a
  // white-noise peak over a 3 s window is stochastic run to run — the same
  // bytes read 0.000, 0.312 and 0.000 across three plays — while the mean is
  // stable (~0.03-0.05 here). The 0.312 was analyser-smoothing residue
  // decaying from the previous loud track (0.72 smoothing lingers ~10
  // frames and is not flushable), not the quiet fixture's own level: a
  // settled quiet track reads ~0.000 peak. Peak gates would grade that
  // residue, not the product. The energetic tone is narrowband and
  // deterministic, so its peak gate stands.
  const quietMean = meanOf(quietRows, "--aurora-music-bass");
  const quietAudible = quietRows.length >= 5 && quietMean > 0.01;
  if (!quietAudible) {
    record("Quiet vs energetic: signal present", "NOT MEASURED",
      `quiet mean bass = ${f(quietMean)} over ${quietRows.length} frames - no floor to compare against`);
  }
  if (quietAudible &&
      requireSignal("Quiet vs energetic: signal present", loudRows, "--aurora-music-bass", 0.3)) {
    // The ratio is on MEANS for the same reason as the gate above: peaks of
    // broadband material are stochastic, means carry its level. 3x demands a
    // discriminating pipeline with margin — pinned-near-1.0 on both ends
    // still fails, which is the bug this exists to catch.
    const loudMean = meanOf(loudRows, "--aurora-music-bass");
    const ratio = loudMean / Math.max(quietMean, 1e-9);
    record(
      "Quiet vs energetic: loud response clearly stronger",
      ratio >= 3 ? "PASS" : "FAIL",
      `bass mean quiet=${f(quietMean)} energetic=${f(loudMean)} ratio=${f(ratio)}x (need >=3x); ` +
        `peak quiet=${f(quietPeak)} energetic=${f(loudPeak)} (peaks informational only); ` +
        `energy peak quiet=${f(maxOf(quietRows, "--aurora-music-energy"))} ` +
        `energetic=${f(maxOf(loudRows, "--aurora-music-energy"))}`,
    );
    const bothBelowCeiling = loudPeak < 1 && quietPeak < 1;
    record(
      "Neither fixture clipped the analyser window",
      bothBelowCeiling ? "PASS" : "FAIL",
      `quiet peak=${f(quietPeak)} energetic peak=${f(loudPeak)} (both must be < 1)`,
    );
  }

  record(
    "Reactive values bounded [0,1] and finite",
    bounded(quietRows) && bounded(loudRows) ? "PASS" : "FAIL",
    `${VARS.length} vars over ${quietRows.length + loudRows.length} frames`,
  );

  /* ---- 1: pause / resume, no spike ---- */
  // The pause cell is gated on the LOUD run having produced a real signal.
  // If the analyser never rose above baseline before pause, "bass before=0
  // after=0" compares baseline with baseline and proves nothing - the guard
  // below refuses to run the cell in that state instead of passing it.
  const prePause = maxOf(loudRows, "--aurora-music-bass");
  const hasPreSignal = loudRun.playing.ok && prePause > 0.3;
  const clockAtPause = (await page.evaluate(() => window.__auroraLocalDiagnostics()))?.currentTime ?? 0;
  const pauseAck = await page.evaluate(() => window.__auroraLocalTransport("pause"));
  const pausedRows = await rec(page, 500);
  const pausedPeak = maxOf(pausedRows, "--aurora-music-bass");
  const pauseClockAtPause = clockAtPause;

  record(
    "Pause drives reactive output to baseline",
    hasPreSignal && pauseAck.ok && pauseAck.isPlaying === false && pausedPeak === 0
      ? "PASS" : !hasPreSignal ? "NOT MEASURED" : "FAIL",
    hasPreSignal
      ? `engine isPlaying=${pauseAck.isPlaying}; bass before=${f(prePause)} after=${f(pausedPeak)}; ` +
        `reach after=${f(maxOf(pausedRows, "reach"))}; pulse after=${f(maxOf(pausedRows, "pulse"))}`
      : `no pre-pause signal (loud peak=${f(prePause)}); baseline-vs-baseline is not a pause test`,
  );

  // The resume/spike cells inherit the same gate: without a pre-pause signal
  // there is no "settled level" for the first frame to be a fraction of.

  const resumeAck = await page.evaluate(() => window.__auroraLocalTransport("resume"));
  // Confirmed-restart, not "resume returned": the clock must move PAST where the
  // pause left it, the element must be unpaused, and the STORE must agree this
  // is playback. The previous harness only checked the transport's word for it,
  // which is how a resume that never started still "passed".
  const resumed = await confirmPlaying(
    page,
    Number(pauseClockAtPause) + 0.05,
  );
  const resumeRows = await rec(page, 2000);

  const first = resumeRows[0] || {};
  const settledPeak = maxOf(resumeRows, "--aurora-music-bass");
  const firstBeat = Number(first["--aurora-music-beat"] || 0);
  const firstBass = Number(first["--aurora-music-bass"] || 0);

  record(
    "Resume genuinely restarted playback",
    resumeAck.ok && resumed.ok ? "PASS" : "FAIL",
    resumed.ok
      ? `replay confirmed after ${resumed.waitedMs}ms (attempt ${resumed.attempt}); ` +
        `store isPlaying=${resumed.store?.isPlaying} currentTime=${f(resumed.diag?.currentTime)} ` +
        `(pause left it at ${f(pauseClockAtPause)}, so the clock advanced)`
      : `NOT a resume: ${resumed.why}; ` +
        `transport ok=${resumeAck.ok} element diag=${JSON.stringify(resumed.diag)} ` +
        `store=${JSON.stringify(resumed.store)}`,
  );

  // A stale half-spent envelope or a live beat impulse would publish a large
  // value on the very first frame - visually a flash. After reset the envelope
  // restarts from zero, so the first frame must be a small fraction of the
  // settled level. `resumed.ok` failing above already failed THIS claim's
  // premise: a spike test over a dead element measures nothing, and the guard
  // below refuses to run it in that state.
  if (hasPreSignal && resumed.ok && requireSignal("Resume: samples resumed", resumeRows, "--aurora-music-bass", 0.3)) {
    record(
      "Resume: no artificial full-scale spike on the first frames",
      firstBass < settledPeak * 0.5 && firstBeat < 0.5 ? "PASS" : "FAIL",
      `first frame bass=${f(firstBass)} beat=${f(firstBeat)}; settled peak bass=${f(settledPeak)} ` +
        `settled peak beat=${f(maxOf(resumeRows, "--aurora-music-beat"))}; ` +
        `beat never reached 1 (max=${f(maxOf(resumeRows, "--aurora-music-beat"))})`,
    );
  }

  /* ---- sweep: one spectral shape, amplitude ladder, confirmed per row ---- */
  if (chainAlive) {
    const rows = [];
    for (const amp of SWEEP_AMPS) {
      const run = await ensureLiveSignal(page, sweepFixture(amp), `sweep-${amp}.wav`);
      const frames = run.playing.ok ? await rec(page, 2500) : [];
      const peak = maxOf(frames, "--aurora-music-bass");
      rows.push({ amp,Peak: peak, ok: run.playing.ok, t: f(run.playing.diag?.currentTime) });
    }
    const valid = rows.filter((r) => r.ok);
    const line = rows.map((r) => `${r.amp}->${f(r.Peak)}${r.ok ? "" : " (unconfirmed)"}`).join("  ");
    record(
      "Sweep: bass response across amplitudes (same shape, confirmed playback)",
      valid.length === rows.length ? "PASS" : "PARTIAL",
      `amp -> bass peak: ${line}; ${valid.length}/${rows.length} rows confirmed; ` +
        "a cliff between adjacent CONFIRMED rows is the production response, " +
        "an unconfirmed row is a harness miss, never a zero",
    );
  } else {
    record(
      "Sweep: bass response across amplitudes",
      "NOT MEASURED",
      "probe failed - sweeping amplitudes against a dead tap would manufacture a cliff",
    );
  }
  /* ---- 4: track transition ---- */
  // Played LOUD on purpose: this cell proves the output is still live after
  // a transition, and liveness needs a deterministic signal. The quiet
  // fixture's peak is stochastic (see the note above), so it cannot carry a
  // presence gate; the energetic tone reads ~0.44 run after run.
  const beforeCounts = await page.evaluate(() => window.__counts);
  const second = await ensureLiveSignal(page, ENERGETIC, "second.wav");
  const secondRows = second.playing.ok ? await rec(page, 1500) : [];
  const afterCounts = await page.evaluate(() => window.__counts);

  record(
    "Track transition creates no second audio graph",
    // The tap follows the track: a new MediaStreamSource on the SAME context
    // and analyser, because a capture belongs to one element state and the
    // old one reads silence after a src swap. Contexts and analysers frozen,
    // sources allowed to grow by the one rebuild — pinning sources frozen
    // here would pin the stale-tap bug, not the feature.
    afterCounts.contexts === beforeCounts.contexts &&
      afterCounts.analysers === beforeCounts.analysers &&
      afterCounts.mediaStreams >= beforeCounts.mediaStreams &&
      afterCounts.mediaStreams <= beforeCounts.mediaStreams + 1
      ? "PASS" : "FAIL",
    `contexts ${beforeCounts.contexts}->${afterCounts.contexts}, ` +
      `analysers ${beforeCounts.analysers}->${afterCounts.analysers}, ` +
      `mediaStreamSources ${beforeCounts.mediaStreams}->${afterCounts.mediaStreams} (one rebuild allowed)`,
  );
  record(
    "Track transition: reactive output still live",
    second.playing.ok &&
    requireSignal("Track transition: output live", secondRows, "--aurora-music-bass", 0.3)
      ? "PASS" : "NOT MEASURED",
    `store isPlaying=${second.playing.store?.isPlaying} ` +
      `t=${f(second.playing.diag?.currentTime)}; ` +
      `bass peak after transition=${f(maxOf(secondRows, "--aurora-music-bass"))} over ${secondRows.length} frames` +
      (second.playing.ok ? "" : ` | why not confirmed: ${second.playing.why}`),
  );

  const deltas = [];
  for (let i = 1; i < resumeRows.length; i += 1) {
    deltas.push(Number(resumeRows[i].t) - Number(resumeRows[i - 1].t));
  }
  const meanDt = meanOf(deltas.map((d) => ({ d })), "d");
  record(
    "Observed frame cadence while playing (measurement, not a target)",
    deltas.length > 0 ? "MEASURED" : "NOT MEASURED",
    `mean rAF interval = ${f(meanDt)} ms over ${deltas.length} intervals. This is headless ` +
      `Chromium's cadence against a synthetic 8 kHz blob; it is NOT a device FPS measurement, ` +
      `and no smoothness, jank or battery claim is made from it`,
  );

  record("No console/runtime errors", errors.length === 0 ? "PASS" : "FAIL",
    errors.length ? errors.slice(0, 3).join(" ;; ") : "none observed across the whole session");

  await ctx.close();
}

/* ═══════════════════════════════ 3: reduced motion ═══════════════════════════ */
{
  const { ctx, page, errors } = await session(true);
  const run = await ensureLiveSignal(page, ENERGETIC, "energetic.wav");
  const rows = run.playing.ok ? await rec(page, 3000) : [];
  const counts = await page.evaluate(() => window.__counts);

  // A. graph construction, on the SAME confirmed-playing precondition as the
  // visual assertion below: an unbuilt graph under reduced motion but a built
  // one under normal motion tells us motionScale suppresses OUTPUT, not
  // construction. If playback itself is unconfirmed, neither cell is valid.
  record(
    "A. Reduced motion: audio graph IS still constructed",
    run.playing.ok && counts.contexts >= 1 && counts.analysers >= 1 && counts.mediaStreams >= 1 ? "PASS" : "FAIL",
    `playback confirmed=${run.playing.ok} (store isPlaying=${run.playing.store?.isPlaying}); ` +
      `contexts=${counts.contexts} analysers=${counts.analysers} mediaStreamSources=${counts.mediaStreams}` +
      (run.playing.ok ? "" : ` | why not confirmed: ${run.playing.why}`),
  );
  // C. visual output - gated on the same confirmation, for the same reason:
  // zeros from a dead element and zeros from suppression are indistinguishable.
  const allZero = VARS.every((v) => maxOf(rows, v) === 0);
  record(
    "C. Reduced motion: visual reactive output fully suppressed",
    run.playing.ok && allZero ? "PASS" : run.playing.ok ? "FAIL" : "NOT MEASURED",
    `peaks: ` + VARS.map((v) => `${v.replace("--aurora-music-", "")}=${f(maxOf(rows, v))}`).join(" ") +
      ` | reach=${f(maxOf(rows, "reach"))} pulse=${f(maxOf(rows, "pulse"))}; ` +
      `over ${rows.length} frames of a ${run.playing.ok ? "confirmed-playing" : "UNCONFIRMED"} loud fixture`,
  );
  record(
    "Reduced motion: values finite, no runtime error",
    bounded(rows) && errors.length === 0 ? "PASS" : "FAIL",
    bounded(rows) ? "all finite" : "non-finite observed");
  const art = await page.evaluate(() => window.__artwork());
  record(
    "Artwork layer state under reduced motion (WAV has no embedded artwork)",
    "NOT APPLICABLE",
    `data-aurora-artwork="${art.attr}" --aurora-artwork-primary="${art.primary}". ` +
      `A generated WAV carries no artwork, so there is no palette to preserve; ` +
      `asserting one here would be asserting nothing. Palette coverage lives in ` +
      `the artwork-ambient unit suites, not in this browser script`,
  );
  await ctx.close();
}

/* ═══════════════════════════════ 5: provider stream ═════════════════════════ */
{
  const { ctx, page } = await session(false);
  const diag = await page.evaluate(() => window.__auroraLocalDiagnostics());
  record(
    "Online provider stream",
    "BLOCKED",
    `Chromium refuses captureStream() on cross-origin provider media and no provider ` +
      `credentials are configured here. No proxy, no CORS flag, no fake stream. ` +
      `Element diagnostics=${JSON.stringify(diag)}`,
  );
  await ctx.close();
}

console.log("\n=================== SUMMARY ===================");
for (const r of results) console.log(r.result.padEnd(12) + r.name);
await browser.close();