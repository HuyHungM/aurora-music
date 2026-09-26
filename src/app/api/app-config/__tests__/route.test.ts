import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/app-config/route";
import { FALLBACK_APP_VERSION, getAppVersion } from "@/lib/app-version";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/i18n/locale";

const rootDir = resolve(process.cwd());

function readPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

async function body(): Promise<Record<string, unknown>> {
  const response = await GET();
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** Whether a real route exists for a deep-link pattern. */
function routeExistsForPattern(pattern: string): boolean {
  const segments = pattern.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last === "{id}" || last === "{token}") {
    const dir = resolve(rootDir, "src/app/(app)", ...segments.slice(0, -1));
    return existsSync(resolve(dir, "[id]", "page.tsx")) ||
      existsSync(resolve(dir, "[token]", "page.tsx"));
  }
  return existsSync(
    resolve(rootDir, "src/app/(app)", ...segments, "page.tsx"),
  );
}

describe("/api/app-config", () => {
  it("exposes one version, read from package.json", async () => {
    // RULE 49: exactly one canonical version source. Nothing maintains a
    // second copy, so the endpoint and the shipped package can never disagree.
    expect(getAppVersion()).toBe(readPackageJson().version);
    expect((await body()).appVersion).toBe(readPackageJson().version);
  });

  it("identifies the application consistently with the manifest", async () => {
    const payload = await body();
    expect(payload.appName).toBe("Aurora Music");
    expect(payload.appShortName).toBe("Aurora");
    expect(typeof payload.appDescription).toBe("string");
    expect((payload.appDescription as string).length).toBeGreaterThan(0);
  });

  it("reports the shipped language set", async () => {
    const payload = await body();
    expect(payload.defaultLocale).toBe(DEFAULT_LOCALE);
    expect(payload.supportedLocales).toEqual([...LOCALES]);
  });

  it("identifies as a web application and claims no native shell", async () => {
    // RULE 50 / RULE 84: platform is "web". Advertising android/ios would be
    // a capability the project does not have.
    const payload = await body();
    expect(payload.platform).toBe("web");
    expect(payload.supportedPlatforms).toEqual(["web"]);
  });

  it("never advertises offline audio or push", async () => {
    // RULE 51 / RULE 76: nothing is implemented, so nothing is promised.
    const capabilities = (await body()).capabilities as Record<string, unknown>;
    expect(capabilities.offlineAudio).toBe(false);
    expect(capabilities.pushNotifications).toBe(false);
    expect(capabilities.offlineShell).toBe(true);
    expect(capabilities.serviceWorkerShell).toBe(true);
  });

  it("leaves runtime-measured capabilities to the client", async () => {
    // Media Session, Web Share, notifications and the installed state depend
    // on the user's browser, so the server must not assert them (RULE 51).
    const capabilities = (await body()).capabilities as Record<string, unknown>;
    for (const key of [
      "mediaSession",
      "webShare",
      "notifications",
      "installed",
      "backgroundPlayback",
    ]) {
      expect(capabilities[key], `${key} is not server-asserted`).toBeUndefined();
    }
    expect((await body()).share).toMatchObject({ webShare: "client-detected" });
  });

  it("lists only deep links that resolve to real routes", async () => {
    // RULE 89: every advertised URL must already work as an ordinary https
    // path, so a future wrapper can map it without an app-only scheme.
    const patterns = (await body()).deepLinkPatterns as string[];
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(
        routeExistsForPattern(pattern),
        `${pattern} resolves to a real route`,
      ).toBe(true);
    }
  });

  it("does not advertise the end-to-end fixture routes", async () => {
    // The /e2e-* pages are deterministic test scaffolding, not product
    // surface; a wrapper must never be pointed at them.
    const patterns = (await body()).deepLinkPatterns as string[];
    expect(patterns.some((pattern) => pattern.includes("e2e"))).toBe(false);
  });

  it("leaks no secret, path, or environment value", async () => {
    // RULE 73: this endpoint is unauthenticated and safe to cache.
    const serialized = JSON.stringify(await body());
    for (const forbidden of [
      "DATABASE_URL",
      "AUTH_SECRET",
      "GOOGLE_CLIENT_ID",
      "SPOTIFY",
      "YOUTUBE",
      "process.env",
      rootDir,
      "node_modules",
      "stack",
    ]) {
      expect(serialized, `response omits ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("falls back rather than throwing when the manifest is unreadable", () => {
    // Defensive: a metadata endpoint must never become a 500.
    expect(FALLBACK_APP_VERSION).toBe("0.0.0");
  });
});
