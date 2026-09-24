import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = resolve(process.cwd(), "src");

// Phase 15 migration: every player-facing component reads playback state
// and issues commands through the MusicEngine facade. PlayerHost alone
// owns the engine, controller, persistence, and facade lifecycle.
const migratedUi = [
  "components/player/player-bar.tsx",
  "components/player/mini-player.tsx",
  "components/player/full-player.tsx",
  "components/player/queue-panel.tsx",
  "components/tracks/track-row.tsx",
  "components/tracks/track-action-menu.tsx",
  "components/home/hero-section.tsx",
  "app/(app)/track/[id]/track-player.tsx",
  "components/album/album-play-button.tsx",
  "components/artist/artist-play-button.tsx",
  "components/playlist/playlist-play-button.tsx",
  "components/library/library-play-button.tsx",
];

const forbiddenPatterns = [
  /from ["']@\/lib\/player\/engine["']/,
  /from ["']@\/lib\/player\/engine-factory["']/,
  /from ["']@\/lib\/playback\//,
  /from ["']@\/lib\/providers\//,
  /from ["']@\/lib\/music\/unified-search["']/,
  /youtubei/,
  /extractor-manager/,
  /\bPlayerEngine\b/,
  /\bcreatePlayerEngine\b/,
  /\bgetDefaultEngine\b/,
];

// Imperative store access is infra-only (PlayerHost); UI selectors below.
const forbiddenStoreAccess = [/usePlayerStore\.(getState|setState|subscribe)/];

// Hook selectors on the store are limited to local panel chrome state
// (visibility + openers). All playback/queue state flows via the facade.
const chromeStateFields = new Set([
  "openQueue",
  "closeQueue",
  "openFullPlayer",
  "closeFullPlayer",
  "isQueueOpen",
  "isFullPlayerOpen",
]);

function selectorFields(line: string): string[] {
  const fields: string[] = [];
  const re = /\b[a-zA-Z_$][\w$]*\.(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    fields.push(match[1]);
  }
  return fields;
}

describe("migrated UI engine boundary", () => {
  for (const relative of migratedUi) {
    it(`${relative} talks to playback only through MusicEngine`, () => {
      const content = readFileSync(resolve(srcDir, relative), "utf8");
      const lines = content.split("\n");

      expect(
        /from ["']@\/lib\/music\/(use-music-engine|instance)["']/.test(content),
        "must consume the MusicEngine facade",
      ).toBe(true);

      const forbidden = lines.filter((line) =>
        forbiddenPatterns.some((pattern) => pattern.test(line)),
      );
      expect(forbidden).toEqual([]);

      const imperative = lines.filter((line) =>
        forbiddenStoreAccess.some((pattern) => pattern.test(line)),
      );
      expect(imperative).toEqual([]);

      const illegalSelectors = lines
        .filter((line) => line.includes("usePlayerStore("))
        .flatMap(selectorFields)
        .filter((field) => !chromeStateFields.has(field));
      expect(illegalSelectors).toEqual([]);
    });
  }
});
