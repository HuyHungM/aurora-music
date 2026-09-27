// @vitest-environment node
/**
 * M3-04: the row menu's host must re-judge placement when the playlist picker
 * swaps into the same slot.
 *
 * `TrackActionMenu` renders the row menu and the playlist picker into ONE slot.
 * `useMenuOpenUp` measures the surface that is actually there, which is only
 * true if it is told to look again: the picker's `mounted` never changes, so
 * without a `placementKey` derived from the swap state the effect does not
 * re-run and the flip verdict computed for the ~200px row menu is applied to
 * the ~330px picker. The picker then extends past the room the verdict cleared
 * and its lower items land under the fixed player bar, where they are visible
 * but unclickable.
 *
 * Measured, not theorised: an E2E journey failed with
 * `<div role="region" aria-label="Player bar"> subtree intercepts pointer
 * events` on a playlist item, after nine playlists had accumulated and the
 * player bar was mounted. `queue-panel.tsx` already passes a `placementKey` for
 * the same swap; this host did not.
 *
 * This is a source-shape assertion rather than a rendered one because jsdom has
 * no box model: every rect is zero there, so the hook's decision cannot be
 * observed through the DOM. The rule itself is pinned behaviourally in
 * `ui/__tests__/menu-placement.test.tsx`; what is pinned HERE is that the host
 * supplies the input that rule needs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  join(process.cwd(), "src/components/tracks/track-action-menu.tsx"),
  "utf8",
);

describe("TrackActionMenu placement key", () => {
  it("re-keys the placement decision when the playlist picker swaps in", () => {
    const call = SOURCE.match(/useMenuOpenUp\(\{[\s\S]*?\}\);/);
    expect(call).not.toBeNull();
    expect(call?.[0]).toMatch(/placementKey:/);
    // The key has to be derived from the state that performs the swap;
    // a constant would compile, lint and pass every behavioural test while
    // leaving the bug exactly where it was.
    expect(call?.[0]).toMatch(/placementKey:\s*showPlaylistMenu\s*\?/);
  });

  it("keeps measuring the rendered surface rather than the trigger", () => {
    // The container is what lets the hook find whichever surface is in the
    // slot - the row menu's or the picker's - through one `[role="menu"]`.
    const call = SOURCE.match(/useMenuOpenUp\(\{[\s\S]*?\}\);/);
    expect(call?.[0]).toMatch(/surfaceRef:\s*containerRef/);
  });
});
