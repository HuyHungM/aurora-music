import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PENDING_SAFETY_MS,
  releaseSearchPending,
  useSearchPending,
} from "@/lib/search/search-pending";

/**
 * The search lock's own contract, tested without React.
 *
 * The component tests prove the handshake — the field opens, the page closes.
 * What they cannot prove is the safety timer's behaviour, and that is the part
 * that decides whether a failed navigation can strand the search field, so it is
 * asserted directly with a mocked clock rather than through a component.
 */
describe("search pending lock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSearchPending.getState().release();
  });

  afterEach(() => {
    useSearchPending.getState().release();
    vi.useRealTimers();
  });

  it("starts unlocked", () => {
    expect(useSearchPending.getState().query).toBeNull();
  });

  it("holds the query it was opened with", () => {
    useSearchPending.getState().begin("son tung");
    expect(useSearchPending.getState().query).toBe("son tung");
  });

  it("treats the empty query as a real pending value", () => {
    // Clearing the field submits the bare `/search`. Collapsing "" into "nothing
    // pending" would make the idle route unreleasable and, worse, would let a
    // later release for "" close an unrelated lock.
    useSearchPending.getState().begin("");
    expect(useSearchPending.getState().query).toBe("");
  });

  it("stays locked well past any plausible search", () => {
    useSearchPending.getState().begin("son tung");
    vi.advanceTimersByTime(PENDING_SAFETY_MS - 1);
    expect(useSearchPending.getState().query).toBe("son tung");
  });

  it("releases itself if the results page never arrives", () => {
    // The guarantee the timer exists for: the user navigated away, so no page
    // will ever call `release`, and the field must not stay dead forever.
    useSearchPending.getState().begin("son tung");
    vi.advanceTimersByTime(PENDING_SAFETY_MS);
    expect(useSearchPending.getState().query).toBeNull();
  });

  it("cancels the timer when the results arrive", () => {
    // Without this, a search that completed in two seconds would still leave a
    // timer armed that fires thirty seconds later against unrelated state.
    useSearchPending.getState().begin("son tung");
    vi.advanceTimersByTime(2_000);
    useSearchPending.getState().release();

    expect(useSearchPending.getState().query).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the timer rather than stacking one per submit", () => {
    const S = PENDING_SAFETY_MS;
    useSearchPending.getState().begin("first");
    vi.advanceTimersByTime(S - 1_000);
    // Second submit at t = S - 1000, so its window ends at t = 2S - 1000.
    useSearchPending.getState().begin("second");

    // One timer, not two.
    expect(vi.getTimerCount()).toBe(1);

    // A stacked first timer would have expired a second into the second
    // search's window, cutting a live search short.
    vi.advanceTimersByTime(2_000);
    expect(useSearchPending.getState().query).toBe("second");

    // Still locked one tick before the second search's own window closes.
    vi.advanceTimersByTime(S - 2_001);
    expect(useSearchPending.getState().query).toBe("second");

    vi.advanceTimersByTime(1);
    expect(useSearchPending.getState().query).toBeNull();
  });

  it("releases unconditionally, including for a superseded request", () => {
    // Navigating to a different search while one is pending renders a page that
    // is not the pending request's page. Refusing to release there left the
    // field locked for the full safety window on a page visibly showing results,
    // which is worse than the race the check was written to prevent.
    useSearchPending.getState().begin("pending one");

    releaseSearchPending();

    expect(useSearchPending.getState().query).toBeNull();
  });

  it("is a no-op when nothing is pending", () => {
    // The page calls this on every visit, including a first load where the user
    // never submitted anything.
    expect(() => releaseSearchPending()).not.toThrow();
    expect(useSearchPending.getState().query).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});