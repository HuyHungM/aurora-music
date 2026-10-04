// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/app/actions/playlist", () => ({
  setPlaylistVisibilityAction: vi.fn(),
}));

import { LocaleProvider } from "@/components/i18n/locale-provider";
import { NotificationHost } from "@/components/ui/notification-host";
import {
  NOTIFICATION_MAX_TOTAL,
  NOTIFICATION_MAX_VISIBLE,
  clearNotifications,
  dismissNotification,
  notificationDurationMs,
  notifyNotification,
  removeNotification,
  useNotification,
  useNotifications,
  type NotificationKind,
} from "@/components/ui/notifications";

/**
 * The one global notification system.
 *
 * A store + host + per-item presence test. The host subscribes once; features
 * post via `notifyNotification()` (or the `useNotification()` hook) with
 * caller-resolved strings, so the store stays locale-free and posting
 * rerenders nothing but the host. Each toast owns its own `usePresence(true)`
 * + auto-dismiss timer, keyed by stable id: repeat posts replace, never stack.
 *
 * Zustand notifies subscribers synchronously, outside React's batching, so
 * every post is wrapped in `act` — without it the host's re-render lands
 * after the assertion and queries read the pre-post tree. (The suite's first
 * draft omitted this and failed 14/19 with an empty `<div />` body; the
 * third failure mode — "Again" missing after a repost — was the side-table
 * action race, fixed by parking the handler outside the store updater.)
 *
 * Timers use real time, not fake: presence settles on timers too, and fake
 * timers would couple every assertion to both. Durations are therefore short
 * and explicit (`durationMs`) wherever an auto-dismiss is awaited, and long
 * assertions (defaults per kind) stay pure arithmetic on
 * `notificationDurationMs`.
 */

function renderHost() {
  return render(
    <LocaleProvider initialLocale="en">
      <NotificationHost />
    </LocaleProvider>,
  );
}

function post(item: Parameters<typeof notifyNotification>[0]): void {
  act(() => {
    notifyNotification(item);
  });
}

function dismiss(id: string): void {
  act(() => {
    dismissNotification(id);
  });
}

function remove(id: string): void {
  act(() => {
    removeNotification(id);
  });
}

function item(
  id: string,
  overrides: Partial<Parameters<typeof notifyNotification>[0]> = {},
) {
  return {
    id,
    kind: "success" as NotificationKind,
    title: `Title ${id}`,
    durationMs: 0,
    ...overrides,
  };
}

beforeEach(() => {
  clearNotifications();
});

afterEach(() => {
  cleanup();
  clearNotifications();
  vi.useRealTimers();
});

describe("notification store", () => {
  it("starts empty", () => {
    expect(useNotifications.getState().items).toEqual([]);
  });

  it("posts an item that the host renders", () => {
    renderHost();
    post(item("a"));
    expect(screen.getByRole("group", { name: "Title a" })).toBeTruthy();
  });

  it("replaces a repeat id instead of stacking", () => {
    renderHost();
    post(item("same", { title: "First" }));
    post(item("same", { title: "Second" }));
    expect(screen.queryByRole("group", { name: "First" })).toBeNull();
    expect(screen.getByRole("group", { name: "Second" })).toBeTruthy();
    expect(useNotifications.getState().items).toHaveLength(1);
  });

  it("reopens a dismissed-then-reposted id as a live toast", async () => {
    renderHost();
    post(item("back", { durationMs: 30 }));
    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "Title back" })).toBeNull();
    });
    post(item("back", { title: "Again" }));
    expect(screen.getByRole("group", { name: "Again" })).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Again" }).hasAttribute("inert"),
    ).toBe(false);
    // A repost is a NEW confirmation: it re-arms the full duration rather
    // than inheriting the dismissed state or the old timer.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(screen.getByRole("group", { name: "Again" })).toBeTruthy();
  });

  it("re-arms the auto-dismiss timer when the same id is reposted", async () => {
    renderHost();
    post(item("again", { durationMs: 120 }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    // A second copy before the first expires extends the confirmation: the
    // toast must still be here a full duration after the REPOST, not the
    // original post.
    post(item("again", { title: "Title again", durationMs: 120 }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(screen.getByRole("group", { name: "Title again" })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "Title again" })).toBeNull();
    });
  });

  it("caps open toasts gracefully and total toasts immediately", () => {
    const total = NOTIFICATION_MAX_VISIBLE + 4;
    act(() => {
      for (let i = 0; i < total; i += 1) {
        notifyNotification(item(`n-${i}`));
      }
    });
    const state = useNotifications.getState();
    expect(state.items.length).toBeLessThanOrEqual(NOTIFICATION_MAX_TOTAL);
    // The open cap binds: at most MAX_VISIBLE are still entering/entered.
    expect(state.items.length - state.closing.length).toBeLessThanOrEqual(
      NOTIFICATION_MAX_VISIBLE,
    );
    // ...and the newest survives every cap.
    expect(state.items.some((entry) => entry.id === `n-${total - 1}`)).toBe(true);
  });

  it("defaults durations per kind, honours explicit values, clamps negatives", () => {
    expect(notificationDurationMs({ kind: "success" })).toBe(4_000);
    expect(notificationDurationMs({ kind: "warning" })).toBe(6_000);
    expect(notificationDurationMs({ kind: "info" })).toBe(5_000);
    expect(notificationDurationMs({ kind: "error" })).toBe(8_000);
    expect(
      notificationDurationMs({ kind: "success", durationMs: 120 }),
    ).toBe(120);
    expect(notificationDurationMs({ kind: "success", durationMs: 0 })).toBe(0);
    expect(notificationDurationMs({ kind: "error", durationMs: -5 })).toBe(0);
    expect(notificationDurationMs({ kind: "info", durationMs: 12.7 })).toBe(12);
  });
});

describe("notification host: types and semantics", () => {
  it("announces through two regions that exist before they have content", () => {
    // The regression. Each toast used to BE its own live region
    // (`role="status"`/`role="alert"` with `aria-live`), and because the host
    // rendered nothing while empty, every one of those regions was inserted into
    // the DOM together with its text. A live region that appears already
    // populated is commonly not announced at all, so most toasts were silent.
    //
    // The fix is the standard shape: two persistent regions, empty on first
    // paint, written into afterwards. Asserted here by checking the regions are
    // present and EMPTY before anything is posted — which is the property that
    // makes the later write an announcement rather than a silent mutation.
    renderHost();

    const polite = screen.getByRole("status");
    expect(polite.getAttribute("aria-live")).toBe("polite");
    expect(polite.textContent).toBe("");

    const assertive = screen.getByRole("alert");
    expect(assertive.getAttribute("aria-live")).toBe("assertive");
    expect(assertive.textContent).toBe("");

    post(item("ok", { kind: "success", title: "Saved" }));
    post(item("bad", { kind: "error", title: "Failed" }));
    post(item("warn", { kind: "warning", title: "Careful" }));
    post(item("note", { kind: "info", title: "Heads up" }));

    // Every kind renders as a labelled group now — visible, focusable children
    // intact, but not itself a live region.
    expect(screen.getByRole("group", { name: "Saved" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Careful" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Heads up" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Failed" })).toBeTruthy();

    // Errors are announced assertively; everything else politely, and the two
    // never compete for the same region.
    expect(assertive.textContent).toContain("Failed");
    expect(polite.textContent).not.toContain("Failed");
    expect(polite.textContent).toContain("Saved");
  });

  it("carries the message alongside the title, so neither line is lost", () => {
    // The toast carried `aria-label={item.title}`, which made the title the
    // region's accessible name and left the message line at risk of never being
    // spoken. Both now reach the region.
    renderHost();
    post(
      item("m", {
        kind: "error",
        title: "Copy failed",
        message: "Clipboard unavailable",
      }),
    );

    const announced = screen.getByRole("alert").textContent ?? "";
    expect(announced).toContain("Copy failed");
    expect(announced).toContain("Clipboard unavailable");
  });

  it("renders the optional message and wraps without horizontal overflow", () => {
    renderHost();
    post(
      item("long", {
        message:
          "A very long second line that must wrap inside the toast rather than widening the viewport.",
      }),
    );
    const toast = screen.getByRole("group", { name: "Title long" });
    expect(toast.textContent).toContain("must wrap inside the toast");
    // The wrap class lives on the message line, not the toast root.
    const message = toast.querySelector("span > span:nth-child(2)");
    expect(message?.className).toContain("break-words");
    // The stack, not the toast, owns the viewport bound.
    const stack = toast.parentElement as HTMLElement;
    expect(stack.className).toContain("w-[min(22rem,calc(100vw-2rem))]");
  });

  it("stacks newest last with a consistent gap", () => {
    renderHost();
    post(item("a"));
    post(item("b"));
    const stack = screen.getByRole("group", { name: "Title a" })
      .parentElement as HTMLElement;
    expect(stack.className).toContain("flex-col");
    expect(stack.className).toContain("gap-2");
    const titles = [...stack.querySelectorAll('[role="group"]')].map((node) =>
      node.getAttribute("aria-label"),
    );
    expect(titles).toEqual(["Title a", "Title b"]);
  });

  it("is viewport-fixed at the top-right inside the safe area, above dialogs", () => {
    renderHost();
    post(item("pos"));
    const stack = screen.getByRole("group", { name: "Title pos" })
      .parentElement as HTMLElement;
    expect(stack.className).toContain("fixed");
    expect(stack.className).toContain(
      "right-[max(1rem,env(safe-area-inset-right))]",
    );
    expect(stack.className).toContain(
      "top-[max(4.5rem,calc(env(safe-area-inset-top)+4rem))]",
    );
    expect(stack.className).toContain("z-toast");
    // Pointer-transparent except on the toasts: the host must never block
    // the page behind it.
    expect(stack.className).toContain("pointer-events-none");
    expect(
      screen.getByRole("group", { name: "Title pos" }).className,
    ).toContain("pointer-events-auto");
  });

  it("announces each toast as its own live region, with no wrapper announcement", () => {
    renderHost();
    post(item("a"));
    const stack = screen.getByRole("group", { name: "Title a" })
      .parentElement as HTMLElement;
    expect(stack.hasAttribute("aria-live")).toBe(false);
    expect(stack.getAttribute("role")).toBeNull();
  });
});

describe("notification host: dismiss and auto-dismiss", () => {
  it("dismisses manually with an exit, not a snap", async () => {
    const user = userEvent.setup();
    renderHost();
    post(item("bye"));
    await user.click(screen.getByRole("button", { name: "Close" }));
    // Still in the document, mid-exit, and out of the accessibility tree.
    const exiting = document.querySelector<HTMLElement>(
      '[data-presence="exiting"][role="group"]',
    );
    expect(exiting).toBeTruthy();
    expect(exiting?.hasAttribute("inert")).toBe(true);
    // ...then genuinely gone, store entry included.
    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "Title bye" })).toBeNull();
    });
    expect(useNotifications.getState().items).toEqual([]);
  });

  it("auto-dismisses after the duration", async () => {
    renderHost();
    post(item("soon", { durationMs: 30 }));
    expect(screen.getByRole("group", { name: "Title soon" })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "Title soon" })).toBeNull();
    });
  });

  it("stays persistent with durationMs 0 until manually dismissed", async () => {
    const user = userEvent.setup();
    renderHost();
    post(item("stay", { durationMs: 0 }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(screen.getByRole("group", { name: "Title stay" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "Title stay" })).toBeNull();
    });
  });

  it("dismiss() animates via the store; remove() drops immediately", async () => {
    const user = userEvent.setup();
    renderHost();
    post(item("graceful"));
    dismiss("graceful");
    // Graceful: still mounted, exiting.
    expect(
      document.querySelector('[data-presence="exiting"][role="group"]'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.queryByRole("group", { name: "Title graceful" }),
      ).toBeNull();
    });

    post(item("now"));
    remove("now");
    // Immediate: gone on the same tick, no exit.
    expect(screen.queryByRole("group", { name: "Title now" })).toBeNull();
    expect(document.querySelector('[data-presence="exiting"]')).toBeNull();
    // And the timer of a removed toast cannot fire into a dead component.
    await user.click(document.body);
  });

  it("clears its timer on unmount so no callback fires late", async () => {
    renderHost();
    post(item("ghost", { durationMs: 30 }));
    cleanup();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    // The timer belonged to the unmounted toast: it was cleared, so the
    // store entry is untouched and no phantom re-render can follow.
    expect(
      useNotifications.getState().items.map((entry) => entry.id),
    ).toContain("ghost");
  });

  it("keeps sibling toasts when one is dismissed", async () => {
    const user = userEvent.setup();
    renderHost();
    post(item("keep-a"));
    post(item("keep-b"));
    await user.click(
      screen.getByRole("group", { name: "Title keep-a" }).querySelector("button") as HTMLElement,
    );
    // The dismissed toast exits; the sibling stays entered and interactive.
    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "Title keep-a" })).toBeNull();
    });
    expect(screen.getByRole("group", { name: "Title keep-b" })).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Title keep-b" }).hasAttribute("inert"),
    ).toBe(false);
    expect(useNotifications.getState().items.map((entry) => entry.id)).toEqual([
      "keep-b",
    ]);
  });

  it("auto-dismisses only the toast whose timer fired", async () => {
    renderHost();
    post(item("short", { durationMs: 30 }));
    post(item("long", { durationMs: 0 }));
    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "Title short" })).toBeNull();
    });
    // The persistent sibling is untouched by the other's timer.
    expect(screen.getByRole("group", { name: "Title long" })).toBeTruthy();
    expect(useNotifications.getState().items.map((entry) => entry.id)).toEqual([
      "long",
    ]);
  });
});

describe("notification host: actions and hook API", () => {
  it("runs the action without dismissing the toast", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <LocaleProvider initialLocale="en">
        <NotificationHost />
      </LocaleProvider>,
    );
    post(item("act", { action: { label: "Retry", onSelect } }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    // The action decides; the host does not presume.
    expect(screen.getByRole("group", { name: "Title act" })).toBeTruthy();
  });

  it("exposes notify/dismiss/clear through useNotification without rerendering readers", () => {
    let renders = 0;
    function Probe() {
      const { notify } = useNotification();
      renders += 1;
      return (
        <button type="button" onClick={() => notify(item("via-hook"))}>
          post
        </button>
      );
    }
    render(
      <LocaleProvider initialLocale="en">
        <Probe />
        <NotificationHost />
      </LocaleProvider>,
    );
    const before = renders;
    act(() => {
      screen.getByRole("button", { name: "post" }).click();
    });
    expect(screen.getByRole("group", { name: "Title via-hook" })).toBeTruthy();
    // Posting rerenders the host, not the hook reader.
    expect(renders).toBe(before);
  });

  it("posts action callbacks through the hook, not just the module function", async () => {
    // The hook used to return `state.notify`, which bypassed the action side
    // table and silently dropped every action callback. Posted through the
    // hook, the action must still arrive at the toast.
    const user = userEvent.setup();
    const onSelect = vi.fn();
    function ActionProbe() {
      const { notify } = useNotification();
      return (
        <button
          type="button"
          onClick={() =>
            notify(item("hooked", { action: { label: "Retry", onSelect } }))
          }
        >
          post action
        </button>
      );
    }
    render(
      <LocaleProvider initialLocale="en">
        <ActionProbe />
        <NotificationHost />
      </LocaleProvider>,
    );
    await user.click(screen.getByRole("button", { name: "post action" }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("notification host: share-copy integration", () => {
  it("carries the playlist copy confirmation past the dialog", async () => {
    const { PlaylistShareControl } = await import(
      "@/components/playlist/playlist-share-control"
    );
    const { setPlaylistVisibilityAction } = await import(
      "@/app/actions/playlist"
    );
    vi.mocked(setPlaylistVisibilityAction).mockResolvedValue({
      ok: true,
      visibility: "shared",
      shareToken: "kZ8xR2mQ7vT4pL9nW6yB3cF8jH1dG5kA0",
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const user = userEvent.setup();
    // `userEvent.setup()` installs its own clipboard stub, masking the one
    // under test — re-apply the wanted clipboard after setup (the share
    // control suite's own pattern).
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    render(
      <LocaleProvider initialLocale="en">
        <PlaylistShareControl
          playlist={{
            id: "pl1",
            ownerId: "user-1",
            title: "My Playlist",
            visibility: "shared",
            shareToken: "kZ8xR2mQ7vT4pL9nW6yB3cF8jH1dG5kA0",
            items: [],
          }}
        />
        <NotificationHost />
      </LocaleProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Share" }));
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => {
      expect(screen.getByRole("group", { name: "Link copied" })).toBeTruthy();
    });
    // The global API received caller-resolved strings (not keys) under a
    // stable per-playlist id — this is the contract the store documents.
    const entry = useNotifications
      .getState()
      .items.find((candidate) => candidate.id === "playlist-share-copied:pl1");
    expect(entry?.title).toBe("Link copied");
    expect(entry?.message).toBe("Share link copied to clipboard.");
    expect(
      screen.getByRole("group", { name: "Link copied" }).textContent,
    ).toContain("Share link copied to clipboard.");
  });

  it("emits no success toast when the clipboard write fails", async () => {
    const { PlaylistShareControl } = await import(
      "@/components/playlist/playlist-share-control"
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const user = userEvent.setup();
    // Re-apply after setup: `userEvent.setup()` installs its own clipboard
    // stub, masking the rejection under test.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(
      <LocaleProvider initialLocale="en">
        <PlaylistShareControl
          playlist={{
            id: "pl1",
            ownerId: "user-1",
            title: "My Playlist",
            visibility: "shared",
            shareToken: "kZ8xR2mQ7vT4pL9nW6yB3cF8jH1dG5kA0",
            items: [],
          }}
        />
        <NotificationHost />
      </LocaleProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Share" }));
    await user.click(screen.getByRole("button", { name: "Copy link" }));

    // The host is mounted, so its two always-present regions exist — and both
    // are EMPTY, because a clipboard failure is reported inline, at the point
    // of action, rather than pushed to the global host. That distinction is the
    // point of this test, so it is asserted directly rather than inferred.
    const hostRegions = document.querySelectorAll(
      'div[role="status"].sr-only, div[role="alert"].sr-only',
    );
    expect(hostRegions).toHaveLength(2);
    for (const region of Array.from(hostRegions)) {
      expect(region.textContent).toBe("");
    }

    // The error itself IS surfaced: at least one alert carries text, and it is
    // the control's own, not the host's empty region.
    const alerts = await screen.findAllByRole("alert");
    expect(
      alerts.some((node) => (node.textContent ?? "").trim() !== ""),
    ).toBe(true);

    expect(screen.queryByRole("group", { name: "Link copied" })).toBeNull();
    expect(useNotifications.getState().items).toEqual([]);
  });
});
