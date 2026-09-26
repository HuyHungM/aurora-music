/**
 * Service-worker registration boundary (client-safe, no Node APIs).
 *
 * The application-shell worker (`public/sw.js`) cache-firsts same-origin
 * `/_next/static/*`. Those URLs are hashed and immutable in production,
 * but under `next dev` (Turbopack) they serve the live development module
 * graph — so a worker controlling a dev page serves stale chunks and the
 * runtime fails with module-factory errors. Registration is therefore a
 * production-only behavior; development sessions must never install the
 * worker, and a worker left over from an earlier session must be released
 * before it can poison the dev page.
 */

export const SERVICE_WORKER_URL = "/sw.js";

/**
 * Message that releases a waiting worker so a new build can take over.
 *
 * Duplicated as a literal in `public/sw.js` — the worker is a plain static
 * file with no bundler, so it cannot import from here. This constant is the
 * page-side copy, and `service-worker.test.ts` asserts the two agree, so a
 * rename on one side fails the suite instead of silently leaving every update
 * parked forever.
 */
export const ACTIVATE_MESSAGE = "aurora:activate";

/**
 * Page -> worker: "this is the language the document is rendering in".
 *
 * The worker cannot work this out for itself. MEASURED on Chromium: a
 * navigation `Request` handed to a service worker carries `accept`,
 * `sec-ch-ua*`, `upgrade-insecure-requests` and `user-agent` — and neither
 * `cookie` nor `accept-language`, even when the page making the request has
 * `document.cookie` populated. Cookies are attached below the layer where the
 * worker's `Request` is constructed.
 *
 * So the page, which can read its own locale, tells the worker, and the worker
 * persists it for the offline page. `service-worker.test.ts` asserts this
 * constant and the one in `public/sw.js` agree, for the same reason as above.
 */
export const LOCALE_MESSAGE = "aurora:locale";

export function shouldRegisterServiceWorker(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  return nodeEnv === "production";
}

interface WorkerRegistration {
  unregister(): Promise<boolean>;
  readonly active: { scriptURL: string } | null;
  readonly waiting: { scriptURL: string } | null;
  readonly installing: { scriptURL: string } | null;
}

interface WorkerContainer {
  getRegistrations?(): Promise<WorkerRegistration[]>;
}

/** True when the registration belongs to this application's worker. */
export function isOwnRegistration(registration: WorkerRegistration): boolean {
  const urls = [
    registration.active?.scriptURL,
    registration.waiting?.scriptURL,
    registration.installing?.scriptURL,
  ];
  return urls.some(
    (url) => typeof url === "string" && url.endsWith(SERVICE_WORKER_URL),
  );
}

/**
 * Development-only recovery: unregister this application's workers so a
 * stale production worker can never silently control a dev page. Scoped
 * strictly to own `/sw.js` registrations — foreign workers and caches are
 * never touched, and every failure resolves silently.
 */
export async function releaseStaleDevelopmentWorkers(
  container: WorkerContainer | undefined | null,
): Promise<void> {
  try {
    if (!container || typeof container.getRegistrations !== "function") {
      return;
    }
    const registrations = await container.getRegistrations();
    await Promise.all(
      registrations
        .filter(isOwnRegistration)
        .map((registration) =>
          registration.unregister().catch(() => false),
        ),
    );
  } catch {
    // Failure-tolerant by design: never affects the application.
  }
}
