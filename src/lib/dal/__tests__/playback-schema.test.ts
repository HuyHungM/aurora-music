import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Playback persistence schema gates (Phase 24). Temporary playback data
 * must never gain a database home: the PlaybackState model stays limited
 * to stable identity + position, and migrations stay an explicit,
 * reviewable set (a new migration fails this gate on purpose — update the
 * allowlist only while reviewing what it stores).
 */

const prismaDir = resolve(process.cwd(), "prisma");
const KNOWN_MIGRATIONS = [
  "20260920094042_postgresql_baseline",
  "20260921155846_add_playback_state",
];

function modelBlock(schema: string, model: string): string {
  const match = schema.match(new RegExp(`model ${model} \\{([^}]*)\\}`, "s"));
  return match?.[1] ?? "";
}

describe("playback persistence schema", () => {
  it("keeps temporary playback data out of PlaybackState", () => {
    const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");
    const block = modelBlock(schema, "PlaybackState");
    expect(block.length).toBeGreaterThan(0);
    for (const forbidden of [
      "streamUrl",
      "previewUrl",
      "AudioSource",
      "googlevideo",
    ]) {
      expect(block, forbidden).not.toContain(forbidden);
    }
    expect(block).toContain("providerTrackId");
  });

  it("keeps migrations an explicitly reviewed set", () => {
    const entries = readdirSync(join(prismaDir, "migrations"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(entries).toEqual([...KNOWN_MIGRATIONS].sort());
  });
});
