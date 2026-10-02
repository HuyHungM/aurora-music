import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { E2E_AUTH_FLAG } from "@/../e2e/auth/constants";
import { E2ELocalPlaybackHarness } from "./e2e-local-playback-harness";

export const metadata: Metadata = { title: "E2E local playback" };

/**
 * Fixture surface for the LOCAL playback chain, which no other E2E route covers.
 *
 * The production path for a local file is
 * `localTrack` -> `createLocalSourceResolver` -> `createObjectUrlFor` ->
 * `PlayerEngine.load` -> the `Audio` element, and it is the only playback path
 * with no server component: nothing to seed, no provider, no fixture row. The
 * File System Access API it normally depends on needs a real folder picker and a
 * user gesture, so this route supplies the one thing a browser test cannot
 * produce — the file's bytes — and leaves every other link real.
 *
 * Test-only by construction: without `AURORA_E2E_AUTH=1` this renders the
 * standard not-found boundary, the same pattern as `/e2e-library`. It is
 * unreachable from production navigation, and the client harness it mounts
 * installs only short-lived `window` functions that it removes on unmount.
 */
export default async function E2EOfflinePage() {
  if (process.env[E2E_AUTH_FLAG] !== "1") {
    notFound();
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight text-text-primary">
        E2E local playback
      </h1>
      <E2ELocalPlaybackHarness />
    </div>
  );
}