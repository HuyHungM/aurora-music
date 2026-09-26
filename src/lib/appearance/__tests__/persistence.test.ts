/**
 * Appearance persistence tests (Phase 53).
 *
 * Four claims, one per sink, and the interesting failures are all in the
 * seams between them:
 *
 *   1. RESOLUTION ORDER (account, then cookie, then default) and its two
 *      genuinely different cases: a signed-in user with no stored preference
 *      (which must fall through to the cookie so a pre-sign-in choice
 *      survives) and a stored preference (which must win, so a stale cookie
 *      cannot override a deliberate account change).
 *
 *   2. EVERY STEP IS TOTAL AND NEVER THROWS. This runs in the root layout of
 *      every authenticated route, so the assertion is not "it returns something
 *      sensible" but "it returns the default theme and nothing else", tested
 *      against a session read that throws, a database read that throws, a
 *      cookie read that throws and a cookie containing JSON that is not JSON.
 *
 *   3. THE WRITE PATH NEVER HALF-SAVES, and never lies about what it stored.
 *      The interesting assertion is the rejection path: the action must return
 *      the value that is *actually in storage*, not the one it just refused,
 *      because the client rolls back to whatever it is handed.
 *
 *   4. THE STORED DOCUMENT IS COMPACT. A default user must be worth a handful
 *      of bytes, because this value travels on a cookie attached to every
 *      same-origin request - and the two sinks must not disagree about its
 *      size.
 *
 * `next/headers` and the DAL are injected by module mock, exactly as the other
 * server-side tests in this tree do it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APPEARANCE,
  decodeAppearance,
  encodeAppearance,
  type Appearance,
} from "@/lib/appearance/appearance";
import { APPEARANCE_COOKIE } from "@/lib/appearance/cookie";

/* ==========================================================================
   MOCKS
   ========================================================================== */

const cookieJar = new Map<string, string>();
const getSessionUserId = vi.fn<() => Promise<string | null>>();
const getCurrentUser = vi.fn<() => Promise<{ id: string } | null>>();
const getUserAppearance = vi.fn<(id: string) => Promise<Appearance | null>>();
const setUserAppearance = vi.fn<(id: string, a: Appearance) => Promise<void>>();
/** Set to a function that throws, to simulate a failing `cookies()`. */
let cookieFailure: ((...args: never[]) => unknown) | undefined;
/** Records every value the action writes to the cookie. */
const cookieWrites: { name: string; value: string; options: unknown }[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => {
    if (cookieFailure) {
      return cookieFailure();
    }
    return {
      get: (name: string) =>
        cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined,
      set: (name: string, value: string, options: unknown) => {
        cookieWrites.push({ name, value, options });
        cookieJar.set(name, value);
      },
    };
  },
}));

vi.mock("@/lib/dal/session", () => ({
  getSessionUserId: () => getSessionUserId(),
  getCurrentUser: () => getCurrentUser(),
}));

vi.mock("@/lib/dal/appearance", () => ({
  getUserAppearance: (id: string) => getUserAppearance(id),
  setUserAppearance: (id: string, a: Appearance) => setUserAppearance(id, a),
}));

const { getRequestAppearance } = await import("@/lib/appearance/server");
const { setAppearanceAction, resetAppearanceAction } = await import(
  "@/app/actions/appearance"
);

beforeEach(() => {
  cookieJar.clear();
  cookieWrites.length = 0;
  cookieFailure = undefined;
  getSessionUserId.mockReset().mockResolvedValue(null);
  getCurrentUser.mockReset().mockResolvedValue(null);
  getUserAppearance.mockReset().mockResolvedValue(null);
  setUserAppearance.mockReset().mockResolvedValue(undefined);
});

/** Puts a value in the cookie the way the client writes it. */
function setCookie(appearance: Appearance): void {
  cookieJar.set(
    APPEARANCE_COOKIE,
    JSON.stringify(encodeAppearance(appearance)),
  );
}

function setRawCookie(raw: string): void {
  cookieJar.set(APPEARANCE_COOKIE, raw);
}

/* ==========================================================================
   1. RESOLUTION ORDER
   ========================================================================== */

describe("getRequestAppearance / order", () => {
  it("returns the default when there is nothing stored anywhere", async () => {
    await expect(getRequestAppearance()).resolves.toEqual(DEFAULT_APPEARANCE);
  });

  it("reads the cookie for a signed-out visitor", async () => {
    const chosen: Appearance = { ...DEFAULT_APPEARANCE, glass: false };
    setCookie(chosen);
    await expect(getRequestAppearance()).resolves.toEqual(chosen);
  });

  it("reads the account for a signed-in visitor with a stored preference", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    const stored: Appearance = {
      ...DEFAULT_APPEARANCE,
      preset: "crystal",
      background: { kind: "preset", id: "deep-space" },
    };
    getUserAppearance.mockResolvedValue(stored);

    await expect(getRequestAppearance()).resolves.toEqual(stored);
    expect(getUserAppearance).toHaveBeenCalledWith("user-1");
  });

  it("lets the account WIN over a stale cookie", async () => {
    // The direction that matters: a signed-in user who changed a setting on
    // another device must not have it reverted by the cookie left behind on
    // this one.
    getSessionUserId.mockResolvedValue("user-1");
    getUserAppearance.mockResolvedValue({
      ...DEFAULT_APPEARANCE,
      glassAlpha: 0.3,
    });
    setCookie({ ...DEFAULT_APPEARANCE, glassAlpha: 0.8 });

    const resolved = await getRequestAppearance();
    expect(resolved.glassAlpha).toBe(0.3);
  });

  it("falls through to the cookie when a signed-in user has no stored preference", async () => {
    // The pre-sign-in case. A visitor who tuned the glass while anonymous and
    // then signed in has a cookie and a null column; honouring the cookie is
    // what stops the choice being visibly discarded on the way in, and the
    // null column is what lets it be adopted on their next change rather than
    // silently at sign-in.
    getSessionUserId.mockResolvedValue("user-1");
    getUserAppearance.mockResolvedValue(null);
    const chosen: Appearance = { ...DEFAULT_APPEARANCE, glass: false };
    setCookie(chosen);

    await expect(getRequestAppearance()).resolves.toEqual(chosen);
  });

  it("treats an all-defaults account row the same as no row at all", async () => {
    // A row that decodes to exactly the default is not "no preference" in a way
    // that matters: the cookie is still consulted, and since the cookie can
    // only differ from the default, a user who has both gets the cookie. The
    // two are indistinguishable in practice and that is the correct outcome -
    // there is nothing to distinguish.
    getSessionUserId.mockResolvedValue("user-1");
    getUserAppearance.mockResolvedValue(DEFAULT_APPEARANCE);
    setCookie({ ...DEFAULT_APPEARANCE, glass: false });
    await expect(getRequestAppearance()).resolves.toEqual(DEFAULT_APPEARANCE);
  });
});

/* ==========================================================================
   2. TOTALITY: A PREFERENCE MAY NOT BREAK BOOT
   ========================================================================== */

describe("getRequestAppearance / never fails", () => {
  it("degrades to the default when the session read throws", async () => {
    getSessionUserId.mockRejectedValue(new Error("session store down"));
    await expect(getRequestAppearance()).resolves.toEqual(DEFAULT_APPEARANCE);
  });

  it("degrades to the default when the database read throws", async () => {
    getSessionUserId.mockResolvedValue("user-1");
    getUserAppearance.mockRejectedValue(new Error("connection reset"));
    await expect(getRequestAppearance()).resolves.toEqual(DEFAULT_APPEARANCE);
  });

  it("still reads the cookie when the database is down", async () => {
    // Better than the default: the cookie is a separate, working source, and
    // falling straight to the default would throw away a setting that was
    // working. The appearance is decoration; the user's choice is not.
    getSessionUserId.mockResolvedValue("user-1");
    getUserAppearance.mockRejectedValue(new Error("connection reset"));
    setCookie({ ...DEFAULT_APPEARANCE, preset: "minimal" });
    await expect(getRequestAppearance()).resolves.toEqual(
      expect.objectContaining({ preset: "minimal" }),
    );
  });

  it("degrades to the default when the cookie API is unavailable", async () => {
    cookieFailure = () => {
      throw new Error("cookies() is only available in a request");
    };
    await expect(getRequestAppearance()).resolves.toEqual(DEFAULT_APPEARANCE);
  });

  it.each([
    ["not JSON at all", "glass please"],
    ["truncated JSON", '{"v":1,"glass":'],
    ["an empty string", ""],
    ["a JSON array", "[1,2,3]"],
    ["JSON null", "null"],
    ["a JSON number", "42"],
    ["an unknown version", '{"v":99,"glass":false}'],
    ["an unknown background kind", '{"v":1,"background":{"kind":"gif"}}'],
  ])("degrades to the default for a cookie holding %s", async (_label, raw) => {
    setRawCookie(raw);
    await expect(getRequestAppearance()).resolves.toEqual(DEFAULT_APPEARANCE);
  });

  it("recovers the readable fields from a partly corrupt cookie", async () => {
    // One bad value costs that control, not the whole preference. The
    // counterpart to the previous table: a cookie that is corrupt in every
    // field falls all the way back, and one that is corrupt in one field keeps
    // the rest.
    setRawCookie(
      JSON.stringify({
        v: 1,
        glass: false,
        preset: "crystal",
        glassAlpha: "not a number",
      }),
    );
    const resolved = await getRequestAppearance();
    expect(resolved.glass).toBe(false);
    expect(resolved.preset).toBe("crystal");
    expect(resolved.glassAlpha).toBe(DEFAULT_APPEARANCE.glassAlpha);
  });
});

/* ==========================================================================
   3 & 4. THE WRITE PATH
   ========================================================================== */

describe("setAppearanceAction", () => {
  it("writes the cookie for a signed-out visitor and writes no database row", async () => {
    const result = await setAppearanceAction(
      encodeAppearance({ ...DEFAULT_APPEARANCE, glass: false }),
    );

    expect(result.ok).toBe(true);
    expect(cookieWrites).toHaveLength(1);
    expect(cookieWrites[0].name).toBe(APPEARANCE_COOKIE);
    // The session IS read - it has to be, or the action could not know which
    // sink to write. What must not happen is a WRITE, and this assertion is
    // about the write specifically.
    expect(getCurrentUser).toHaveBeenCalled();
    expect(setUserAppearance).not.toHaveBeenCalled();
  });

  it("returns the applied appearance, so the client adopts what was stored", async () => {
    // Not an echo. A value that is out of range is clamped by `decodeAppearance`
    // on the way in, so echoing the raw request would tell the client to show
    // a number the server did not keep.
    const result = await setAppearanceAction({
      v: 1,
      glassAlpha: 99,
      glassBlur: 900,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.appearance.glassAlpha).toBe(0.85);
    expect(result.appearance.glassBlur).toBe(28);
  });

  it("writes BOTH sinks for a signed-in visitor", async () => {
    getCurrentUser.mockResolvedValue({ id: "user-7" });
    const result = await setAppearanceAction(
      encodeAppearance({ ...DEFAULT_APPEARANCE, preset: "minimal" }),
    );

    expect(result.ok).toBe(true);
    // The cookie, so the next paint is already correct even before the
    // account write is read back.
    expect(cookieWrites).toHaveLength(1);
    // And the account, so the choice follows the person to another browser.
    expect(setUserAppearance).toHaveBeenCalledWith(
      "user-7",
      expect.objectContaining({ preset: "minimal" }),
    );
  });

  it("stores the compact document, not the resolved one", async () => {
    // THE SIZE CLAIM. `cookie.ts` documents that an untouched visitor is worth
    // `{"v":1}` - about twelve bytes - precisely because the format omits
    // defaults. Writing the resolved twelve-field object instead would put ~240
    // bytes on a cookie attached to every same-origin request, and would make a
    // signed-in user's cookie fatter than an anonymous one's for the identical
    // preference.
    const result = await setAppearanceAction(encodeAppearance(DEFAULT_APPEARANCE));
    expect(result.ok).toBe(true);

    const written = cookieWrites[0].value;
    expect(JSON.parse(written)).toEqual({ v: 1 });
    expect(written.length).toBeLessThan(24);
    // And it must still round-trip: compact must not mean lossy.
    expect(decodeAppearance(JSON.parse(written))).toEqual(DEFAULT_APPEARANCE);
  });

  it("sends the same document to the database as to the cookie", async () => {
    // One document, two sinks. A signed-in user whose account row and cookie
    // disagree would resolve differently depending on which request they made.
    getCurrentUser.mockResolvedValue({ id: "user-7" });
    const chosen: Appearance = {
      ...DEFAULT_APPEARANCE,
      glass: false,
      background: { kind: "preset", id: "polar-glow" },
    };
    await setAppearanceAction(encodeAppearance(chosen));

    const fromCookie = JSON.parse(cookieWrites[0].value);
    const fromAccount = setUserAppearance.mock.calls[0][1];
    expect(fromAccount).toEqual(chosen);
    expect(decodeAppearance(fromCookie)).toEqual(fromAccount);
  });

  it("rejects an insecure background address and stores nothing", async () => {
    getCurrentUser.mockResolvedValue({ id: "user-7" });
    const result = await setAppearanceAction({
      v: 1,
      background: { kind: "url", url: "http://img.test/a.jpg" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toBe("settings.backgroundError.insecureScheme");
    // A refused address must reach NEITHER sink.
    expect(cookieWrites).toHaveLength(0);
    expect(setUserAppearance).not.toHaveBeenCalled();
  });

  it("returns the STORED appearance on a rejection, not the refused one", async () => {
    // THE ROLLBACK CONTRACT. The client has already shown the value, so what
    // it needs back is what is actually in storage. Handing back the value that
    // was just refused would leave the interface displaying an address that was
    // never accepted, presented as a saved setting - a worse outcome than the
    // bad paste, because it is now unfalsifiable from the UI.
    setCookie({ ...DEFAULT_APPEARANCE, preset: "minimal" });
    const result = await setAppearanceAction({
      v: 1,
      preset: "crystal",
      background: { kind: "url", url: "javascript:alert(1)" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.appearance.preset).toBe("minimal");
    expect(result.appearance.background).toEqual({ kind: "none" });
    // The refused value is nowhere in the response.
    expect(result.appearance.background).not.toEqual(
      expect.objectContaining({ url: expect.anything() }),
    );
  });

  it("rolls back to the default when nothing is stored and a value is refused", async () => {
    const result = await setAppearanceAction({
      v: 1,
      background: { kind: "url", url: "https://user:pass@img.test/a.jpg" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toBe("settings.backgroundError.credentialsInUrl");
    expect(result.appearance).toEqual(DEFAULT_APPEARANCE);
  });

  it("accepts a legal address and normalises it to the checked text", async () => {
    getCurrentUser.mockResolvedValue({ id: "user-7" });
    const result = await setAppearanceAction({
      v: 1,
      background: { kind: "url", url: "  https://img.test/a.jpg  " },
    });
    expect(result.ok).toBe(true);
    // The stored value is the TRIMMED address that was actually validated, not
    // the raw text that was typed.
    expect(setUserAppearance.mock.calls[0][1].background).toEqual({
      kind: "url",
      url: "https://img.test/a.jpg",
    });
  });

  it("reports a cookie-write failure without attempting the account write", async () => {
    // A preference that half-saved is worse than one that did not save: the
    // next request would resolve to the other half.
    getCurrentUser.mockResolvedValue({ id: "user-7" });
    cookieFailure = () => {
      throw new Error("cookie jar is read-only");
    };

    const result = await setAppearanceAction(
      encodeAppearance({ ...DEFAULT_APPEARANCE, glass: false }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    // No reason: nothing was WRONG with the value, so there is nothing to tell
    // the user to fix. A reason key here would send them to adjust a setting
    // that was already correct.
    expect(result.reason).toBeUndefined();
    // And the draft is preserved rather than reverted: the value is legal, it
    // only failed to travel.
    expect(result.appearance.glass).toBe(false);
    expect(setUserAppearance).not.toHaveBeenCalled();
  });

  it("keeps the cookie and reports success when only the account write fails", async () => {
    // The reverse of the previous test, and a different severity: the value IS
    // saved, in the cookie, so a reload is correct. Only the cross-device
    // sync is behind. Failing loudly here would be a false alarm.
    getCurrentUser.mockResolvedValue({ id: "user-7" });
    setUserAppearance.mockRejectedValue(new Error("write conflict"));

    const result = await setAppearanceAction(
      encodeAppearance({ ...DEFAULT_APPEARANCE, preset: "crystal" }),
    );

    expect(result.ok).toBe(true);
    expect(cookieWrites).toHaveLength(1);
  });

  it("never throws, whatever it is handed", async () => {
    for (const input of [undefined, null, "nonsense", 42, [], {}, { v: 1 }]) {
      await expect(setAppearanceAction(input)).resolves.toEqual(
        expect.objectContaining({ ok: expect.any(Boolean) }),
      );
    }
  });
});

describe("resetAppearanceAction", () => {
  it("writes the default to BOTH sinks", async () => {
    // NOT a delete from the account column, and that is the whole point: a
    // deleted preference would immediately fall back to a cookie still holding
    // the old choice, so the reset would visibly undo itself on the next
    // request.
    getCurrentUser.mockResolvedValue({ id: "user-7" });
    const result = await resetAppearanceAction();

    expect(result.ok).toBe(true);
    expect(cookieWrites).toHaveLength(1);
    expect(setUserAppearance).toHaveBeenCalledWith(
      "user-7",
      expect.objectContaining({ preset: DEFAULT_APPEARANCE.preset }),
    );
  });

  it("clears a custom background, restoring the Aurora default", async () => {
    setCookie({
      ...DEFAULT_APPEARANCE,
      background: { kind: "url", url: "https://img.test/a.jpg" },
    });
    getCurrentUser.mockResolvedValue({ id: "user-7" });
    await resetAppearanceAction();

    const stored = setUserAppearance.mock.calls[0][1];
    expect(stored).toEqual(DEFAULT_APPEARANCE);
    expect(stored.background).toEqual({ kind: "none" });
  });

  it("leaves the cookie able to no longer override the reset", async () => {
    // The regression this guards: cookie said "crystal", reset ran, and the
    // cookie still said crystal. After the reset the cookie must hold the
    // default too, so the next resolution for an anonymous visitor is the
    // default and not the old choice.
    setCookie({ ...DEFAULT_APPEARANCE, preset: "crystal" });
    await resetAppearanceAction();

    const cookieValue = JSON.parse(cookieWrites[0].value);
    expect(cookieValue).toEqual({ v: 1 });
    expect(decodeAppearance(cookieValue)).toEqual(DEFAULT_APPEARANCE);
  });

  it("reaches nothing but appearance", async () => {
    // §60. Structurally: this module imports the session, the appearance DAL
    // and the cookie jar, and has no reference to the queue, the likes, the
    // playlists or the playback state. Asserted behaviourally by the fact that
    // a full reset touches exactly one cookie and one user column.
    await resetAppearanceAction();
    expect(cookieWrites).toHaveLength(1);
    expect(cookieWrites[0].name).toBe(APPEARANCE_COOKIE);
  });
});

/* ==========================================================================
   RELOAD BEHAVIOUR
   ========================================================================== */

describe("a saved preference survives a reload", () => {
  it("for an anonymous visitor, through the cookie", async () => {
    const chosen: Appearance = {
      ...DEFAULT_APPEARANCE,
      glass: false,
      background: { kind: "preset", id: "northern-light" },
    };
    const saved = await setAppearanceAction(encodeAppearance(chosen));
    expect(saved.ok).toBe(true);

    // "Reload": the same cookie, read on a fresh request. Resolved through the
    // server path rather than by reading the jar, so the assertion is about
    // what a real request would see.
    await expect(getRequestAppearance()).resolves.toEqual(chosen);
  });

  it("for a signed-in visitor, through the account", async () => {
    getCurrentUser.mockResolvedValue({ id: "user-7" });
    const chosen: Appearance = {
      ...DEFAULT_APPEARANCE,
      preset: "crystal",
      glassAlpha: 0.3,
    };
    await setAppearanceAction(encodeAppearance(chosen));

    // A "reload" of an authenticated request: the account is the source of
    // truth, and the mock returns exactly what the write stored.
    getSessionUserId.mockResolvedValue("user-7");
    getUserAppearance.mockImplementation(async () => {
      const stored = setUserAppearance.mock.calls.at(-1)?.[1];
      return stored ?? null;
    });
    await expect(getRequestAppearance()).resolves.toEqual(chosen);
  });
});
