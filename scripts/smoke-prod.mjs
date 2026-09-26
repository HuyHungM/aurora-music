/**
 * Deterministic production smoke checks (Phase 26) with optional owned
 * server lifecycle (Phase 27).
 *
 * Usage:
 *   bun run smoke:prod [baseUrl] [--spawn] [--port N] [--timeout-ms N]
 *
 * - Default: probe an already-running server at baseUrl (no lifecycle).
 * - --spawn: fail closed if the port is occupied, start an owned
 *   `next start`, wait for /api/health readiness, run the checks, then
 *   terminate the child and verify it exited (no orphans, no stale-server
 *   false positives). Requires a production build (`.next/BUILD_ID`).
 *
 * No credentials, no YouTube, no database writes, no browser needed.
 * Every check prints PASS/FAIL; exit 0 only when all pass.
 * Exit codes: 0 pass, 1 check failure, 2 misconfiguration.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const NEXT_BIN = join(ROOT_DIR, "node_modules", "next", "dist", "bin", "next");

let failures = 0;

/**
 * Removes line and block comments so a check can assert on executable code.
 * Used where the same file documents a deliberate absence in prose — a plain
 * text search would then match the explanation of what is *not* done.
 * Not a parser: string literals containing `//` are a theoretical edge case
 * this codebase does not have, and a real parser would be a dependency.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function check(name, ok, detail = "") {
  const status = ok ? "PASS" : "FAIL";
  console.log(`${status} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failures += 1;
  }
}

async function get(baseUrl, path, timeoutMs = 10000, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      signal: controller.signal,
      redirect: "manual",
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

function header(response, name) {
  return response.headers.get(name) ?? "";
}

/**
 * True only when nothing answers at baseUrl (connection refused). Any HTTP
 * response — even an error — means the port is occupied by *something*.
 */
export async function isPortFree(baseUrl, fetchImpl = fetch) {
  try {
    await fetchImpl(`${baseUrl}/api/health`, { redirect: "manual" });
    return false;
  } catch (error) {
    // Phase 50 (Bun migration). Two runtimes report a refused connection
    // differently, and both are equally definitive:
    //   Node - `TypeError: fetch failed`, socket code on `error.cause.code`
    //          as "ECONNREFUSED" / "ENOTFOUND".
    //   Bun  - `TypeError: Unable to connect`, code directly on the error as
    //          "ConnectionRefused", with no `cause` at all.
    // Reading only `cause.code` made Bun's refusal look ambiguous, so the
    // port guard below failed closed and `--spawn` refused to start on a port
    // that was demonstrably free. Both shapes are recognised; the
    // fail-closed default is untouched for genuinely uncertain failures
    // (timeout, abort, TLS), so the guard can never be talked into testing a
    // foreign server.
    const codes = [
      error && typeof error === "object" && "cause" in error
        ? error.cause?.code
        : undefined,
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined,
    ];
    const isRefusal = codes.some(
      (code) =>
        code === "ECONNREFUSED" ||
        code === "ENOTFOUND" ||
        code === "ConnectionRefused",
    );
    if (isRefusal) {
      return true;
    }
    // Uncertain (timeout, abort, TLS error): fail closed, do not assume free.
    return false;
  }
}

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Polls /api/health until it reports ok or the timeout expires.
 * Returns true only on `{"status":"ok"}` — degraded/error keep waiting.
 */
export async function waitForHealthy(
  baseUrl,
  options = {},
) {
  const {
    timeoutMs = 90000,
    pollMs = 1000,
    fetchImpl = fetch,
    sleep = defaultSleep,
    now = () => Date.now(),
  } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetchImpl(`${baseUrl}/api/health`);
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (body && body.status === "ok") {
          return true;
        }
      }
    } catch {
      // Not up yet; keep polling until the deadline.
    }
    if (now() >= deadline) {
      return false;
    }
    await sleep(pollMs);
  }
}

async function runChecks(baseUrl) {
  // 1. Application serves the shell.
  const home = await get(baseUrl, "/");
  check("home responds 200 html", home.status === 200 && (header(home, "content-type") ?? "").includes("text/html"));

  // 2. Readiness is genuinely ok (not just listening).
  const health = await get(baseUrl, "/api/health");
  let healthOk = false;
  try {
    const body = JSON.parse(health.text);
    healthOk =
      health.status === 200 &&
      body.status === "ok" &&
      body.checks?.environment === "valid" &&
      body.checks?.database === "up";
  } catch {
    healthOk = false;
  }
  check("health reports ready (env valid, database up)", healthOk);

  // 3. Security headers present with the documented policy.
  const csp = header(home, "content-security-policy");
  check("content-security-policy present", csp.length > 0);
  check("CSP locks framing/objects", csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"));
  check("x-content-type-options nosniff", header(home, "x-content-type-options") === "nosniff");
  check("x-frame-options DENY", header(home, "x-frame-options") === "DENY");
  check(
    "referrer-policy strict-origin",
    (header(home, "referrer-policy") || "").includes("strict-origin-when-cross-origin"),
  );

  // 4. PWA assets served. Phase 51: the manifest is framework-native, so this
  // also proves the generated route works in a real production server, not
  // just that a static file happens to be in `public/`.
  const manifest = await get(baseUrl, "/manifest.webmanifest");
  let manifestOk = manifest.status === 200;
  let manifestBody = null;
  try {
    manifestBody = JSON.parse(manifest.text);
    manifestOk = manifestOk && manifestBody.name === "Aurora Music";
  } catch {
    manifestOk = false;
  }
  check("manifest served and valid", manifestOk);
  // Installability-critical fields, verified against the running server: a
  // browser refuses to install without a reachable icon set, and treats a
  // manifest without these as a different application on every deploy.
  check(
    "manifest is installable (id, scope, start_url, display, icons)",
    manifestOk &&
      manifestBody.id === "/" &&
      manifestBody.scope === "/" &&
      manifestBody.start_url === "/" &&
      manifestBody.display === "standalone" &&
      Array.isArray(manifestBody.display_override) &&
      manifestBody.display_override.includes("browser") &&
      Array.isArray(manifestBody.icons) &&
      manifestBody.icons.some((entry) => entry.purpose === "maskable"),
  );
  // Every declared icon and shortcut must actually resolve, or the launcher
  // shows a broken entry.
  for (const entry of manifestBody?.icons ?? []) {
    const asset = await get(baseUrl, entry.src);
    check(
      `icon served as png: ${entry.src}`,
      asset.status === 200 &&
        (header(asset, "content-type") ?? "").includes("image/png"),
    );
  }
  const icon = await get(baseUrl, "/icons/icon-192.png");
  check(
    "icon served as png",
    icon.status === 200 && (header(icon, "content-type") ?? "").includes("image/png"),
  );
  const sw = await get(baseUrl, "/sw.js");
  check(
    "service worker excludes playback traffic",
    sw.status === 200 &&
      sw.text.includes("googlevideo.com") &&
      sw.text.includes("passthrough"),
  );
  // The worker must not seize control of a running session (Phase 51): a new
  // build parks and the page releases it at pagehide. Comments are stripped
  // first, because the install handler's own comment names `skipWaiting()` in
  // order to explain that the call is deliberately absent — a text search
  // that counted the comment would report the opposite of the truth.
  const swCode = stripComments(sw.text);
  const installBlock = swCode.slice(swCode.indexOf('addEventListener("install"'));
  const messageBlockAt = installBlock.indexOf('addEventListener("message"');
  check(
    "service worker defers activation instead of forcing it",
    swCode.includes("aurora:activate") &&
      messageBlockAt > 0 &&
      !/skipWaiting\s*\(\s*\)/.test(installBlock.slice(0, messageBlockAt)),
  );
  // Safe-area insets are inert without viewport-fit=cover, which would leave
  // the installed layout underneath the notch and home indicator.
  check(
    "viewport allows safe-area insets to resolve",
    (home.text ?? "").includes("viewport-fit=cover"),
  );
  // Client configuration must stay inert: safe metadata only.
  const appConfig = await get(baseUrl, "/api/app-config");
  let appConfigOk = appConfig.status === 200;
  try {
    const config = JSON.parse(appConfig.text);
    appConfigOk =
      appConfigOk &&
      config.appName === "Aurora Music" &&
      config.platform === "web" &&
      config.capabilities?.offlineAudio === false &&
      config.capabilities?.pushNotifications === false &&
      !/DATABASE_URL|AUTH_SECRET|process\.env/.test(appConfig.text);
  } catch {
    appConfigOk = false;
  }
  check("app-config served with safe metadata only", appConfigOk);

  // 5. No open proxy for arbitrary URLs.
  const proxy = await get(baseUrl, "/api/proxy?url=https://example.com/x.mp3");
  check("no arbitrary-URL proxy (404)", proxy.status === 404);

  // 6. E2E fixture route stays gated without the live flag. Note: this
  // stack serves programmatic notFound() content with HTTP 200 (verified
  // across routes; filesystem misses still 404), so the gate asserts
  // behavior — no fixture content served — rather than the status code.
  if (process.env.AURORA_E2E_LIVE_PLAYBACK !== "1") {
    const fixture = await get(baseUrl, "/e2e-playback/dQw4w9WgXcQ");
    check(
      "fixture route gated (no playable content without flag)",
      fixture.text.includes("Page not found") &&
        !fixture.text.includes("E2E: play collection") &&
        !fixture.text.includes("Never Gonna Give You Up"),
    );
  } else {
    check("fixture route gated (skipped, flag set)", true);
  }

  // 6b. Deterministic fixture library stays gated without the auth
  // test flag (same notFound() semantics as the playback fixture).
  // Note: the route metadata title is present in <head> either way, so
  // the gate asserts body content, not the title string.
  if (process.env.AURORA_E2E_AUTH !== "1") {
    const library = await get(baseUrl, "/e2e-library");
    check(
      "fixture library gated (not-found without flag)",
      library.text.includes("Page not found") &&
        !library.text.includes("Deterministic catalog") &&
        !library.text.includes("Aurora E2E Track"),
    );
  } else {
    check("fixture library gated (skipped, flag set)", true);
  }

  // 7. Auth surface responds without crashing.
  const session = await get(baseUrl, "/api/auth/session");
  check("auth session endpoint responds", session.status === 200 || session.status === 401);
  check("auth response leaks no secrets", !/secret|token|cookie|password/i.test(session.text));
}

function parseArgs(argv) {
  const args = { spawn: false, port: 3100, timeoutMs: 90000, baseUrl: "http://127.0.0.1:3100" };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--spawn") {
      args.spawn = true;
    } else if (arg === "--port") {
      args.port = Number(argv[(index += 1)]);
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[(index += 1)]);
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  if (positional.length > 0) {
    args.baseUrl = positional[0];
  }
  return args;
}

async function spawnServer(port, timeoutMs) {
  if (!existsSync(join(ROOT_DIR, ".next", "BUILD_ID"))) {
    console.error("smoke-prod: no production build found. Run `bun run build` first.");
    process.exit(2);
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  if (!(await isPortFree(baseUrl))) {
    console.error(
      `smoke-prod: port ${port} is occupied — refusing to test a foreign server. ` +
        `Free the port or pass --port.`,
    );
    process.exit(2);
  }
  const child = spawn(
    process.execPath,
    [NEXT_BIN, "start", "-p", String(port)],
    { cwd: ROOT_DIR, stdio: "ignore", env: process.env },
  );
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    const ready = await waitForHealthy(baseUrl, { timeoutMs });
    if (!ready) {
      console.error("smoke-prod: server did not become ready in time.");
      process.exitCode = 1;
      return { baseUrl, child, exited, ok: false };
    }
    return { baseUrl, child, exited, ok: true };
  } catch (error) {
    console.error(`smoke-prod: startup failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return { baseUrl, child, exited, ok: false };
  }
}

async function stopServer(child, exited) {
  child.kill();
  const outcome = await Promise.race([
    exited,
    defaultSleep(10000).then(() => null),
  ]);
  if (outcome === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone; nothing to do.
    }
    const forced = await Promise.race([
      exited,
      defaultSleep(10000).then(() => null),
    ]);
    if (forced === null) {
      console.error("smoke-prod: server process did not exit (orphan risk).");
      failures += 1;
      return;
    }
  }
  console.log("PASS server terminated cleanly");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
    console.error("smoke-prod: --port must be an integer 1-65535.");
    process.exit(2);
  }
  if (args.spawn) {
    const session = await spawnServer(args.port, args.timeoutMs);
    try {
      if (session.ok) {
        await runChecks(session.baseUrl);
      }
    } finally {
      await stopServer(session.child, session.exited);
    }
  } else {
    await runChecks(args.baseUrl);
  }
  if (failures > 0) {
    console.error(`smoke-prod: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("smoke-prod: OK.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
