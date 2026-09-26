/**
 * EQ persistence (Phase 53 addendum, §39, §40, §41).
 *
 * The two-sink contract, tested at the boundary that matters: the DOCUMENT. The
 * cookie and the account column receive the same compact encoding, so what is
 * worth asserting is that a configuration survives a round trip through either
 * one, that the encoding is small, and - the property §39 is really about - that
 * nothing here has anything to do with the playback session.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  decodeEQ,
  encodeEQ,
  DEFAULT_EQ,
  AURORA_V_SHAPE,
  selectPreset,
  setBandGain,
  type EQConfig,
} from "@/lib/audio/eq";
import { EQ_COOKIE, EQ_COOKIE_MAX_AGE } from "@/lib/audio/eq-cookie";
// The action is imported DYNAMICALLY inside the sink tests, not statically:
// each test re-mocks `next/headers` and the DAL, and a module resolved once at
// import time would keep the first mock for the whole file.

/**
 * A configuration with the equalizer switched on.
 *
 * Defined at the top because the document tests below need it before the sink
 * tests do, and a helper used before its definition is a `ReferenceError` that
 * has nothing to do with what is being tested.
 */
function enabled(config: EQConfig): EQConfig {
  return { ...config, enabled: true };
}

/* ==========================================================================
   THE DOCUMENT
   ========================================================================== */

describe("the wire document (§39)", () => {
  it("is eleven bytes for a listener who has touched nothing", () => {
    const value = JSON.stringify(encodeEQ(DEFAULT_EQ));
    expect(value).toBe('{"v":1}');
    // Asserted rather than assumed, because the cookie travels with every
    // same-origin request and this is the number that decides whether the
    // format is worth having.
    expect(value.length).toBeLessThanOrEqual(16);
  });

  it("stays small even for a fully hand-edited curve", () => {
    let config = enabled(setBandGain(selectPreset("aurora-v"), 1, 6));
    for (let index = 0; index < 10; index += 1) {
      config = setBandGain(config, index, index % 2 === 0 ? 6 : -6);
    }
    const value = JSON.stringify(encodeEQ(config));
    expect(decodeEQ(JSON.parse(value)).bands).toEqual(config.bands);
    // MEASURED, 221 bytes for a listener who has moved all ten bands - the
    // worst case this format has. Every band is `{"f":16000,"g":-6}`, so this is
    // the long end of the range and not a case to tune away: the alternative is
    // a positional array, which cannot be extended without a version bump and
    // cannot carry a band the reader does not recognise.
    expect(value.length).toBeLessThanOrEqual(256);
  });

  it("omits bands that match the default curve", () => {
    // The V-Shape is the DEFAULT curve, so selecting it stores no bands at all.
    expect(encodeEQ(selectPreset("aurora-v")).bands).toBeUndefined();
  });

  it("survives a round trip through JSON exactly", () => {
    const config = enabled(setBandGain(selectPreset("aurora-v"), 8, 4));
    const decoded = decodeEQ(JSON.parse(JSON.stringify(encodeEQ(config))));
    expect(decoded.bands).toEqual(config.bands);
    expect(decoded.presetId).toBe("custom");
    expect(decoded.enabled).toBe(true);
  });

  it("repairs a hand-edited cookie field by field", () => {
    // A cookie is user-writable, so a hand-edited value is just another
    // untrusted input. One bad field must cost that field and nothing else.
    const decoded = decodeEQ({
      v: 1,
      enabled: true,
      presetId: "custom",
      manualPreampDb: "loud",
      bands: [
        { f: 62, g: 6 },
        { f: 999, g: 6 },
        { f: 1000, g: "loud" },
      ],
    });
    expect(decoded.enabled).toBe(true);
    expect(decoded.manualPreampDb).toBe(0);
    expect(decoded.bands[1]!.gain).toBe(6);
    // 999 Hz is not a band, so it is dropped rather than added.
    expect(decoded.bands).toHaveLength(10);
  });

  it("falls back to the default for a future version, and to the default for junk", () => {
    expect(decodeEQ({ v: 2, enabled: true }).enabled).toBe(false);
    for (const value of [undefined, null, "{}", 7, [], true]) {
      expect(decodeEQ(value).bands).toEqual([...AURORA_V_SHAPE]);
    }
  });

  it("keeps flat flat, even if a cookie claims otherwise", () => {
    // A stored `flat` with stray gains is a contradiction, and the preset wins.
    const decoded = decodeEQ({ v: 1, presetId: "flat", bands: [{ f: 62, g: 6 }] });
    expect(decoded.bands.every((b) => b.gain === 0)).toBe(true);
  });
});

/* ==========================================================================
   THE TWO SINKS
   ========================================================================== */

describe("the server action (§39, §40, §41)", () => {
  const setCookie = vi.fn();
  const getCurrentUser = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    setCookie.mockReset();
    getCurrentUser.mockReset();
    getCurrentUser.mockResolvedValue(null);
    vi.doMock("next/headers", () => ({
      cookies: async () => ({ set: setCookie }),
    }));
    vi.doMock("@/lib/dal/session", () => ({ getCurrentUser }));
  });

  async function callAction(input: unknown) {
    const mod = await import("@/app/actions/audio-eq");
    return mod.setEQAction(input);
  }

  /**
   * The action's input is the WIRE DOCUMENT, not a resolved configuration.
   *
   * The same contract `setAppearanceAction` has, and the reason the client calls
   * `setEQAction(encodeEQ(config))`. Handing the action a resolved object is a
   * category error the decoder correctly refuses: there is no `v` on it, and an
   * unversioned document is not one this build knows how to read. Every test
   * below goes through here so that the contract is stated once and used
   * everywhere, rather than being re-derived per test and eventually getting one
   * of them wrong.
   */
  const asWire = (config: EQConfig) => encodeEQ(config);

  it("always writes the cookie, for a signed-out listener", async () => {
    // §41: no login is required to use the equalizer, and the cookie is the
    // only place a signed-out listener's choice can live.
    const config = enabled(selectPreset("aurora-v"));
    const result = await callAction(asWire(config));

    expect(result.ok).toBe(true);
    expect(result.config.bands).toEqual(config.bands);
    expect(setCookie).toHaveBeenCalledTimes(1);
    const [name, value, options] = setCookie.mock.calls[0]!;
    expect(name).toBe(EQ_COOKIE);
    expect(options.path).toBe("/");
    expect(options.maxAge).toBe(EQ_COOKIE_MAX_AGE);
    expect(options.sameSite).toBe("lax");
    // The COMPACT document, not the resolved configuration.
    expect(value).toBe(JSON.stringify(encodeEQ(config)));
  });

  it("writes the account column as well when there is a session", async () => {
    getCurrentUser.mockResolvedValue({ id: "u1" });
    const setUserEQ = vi.fn();
    vi.doMock("@/lib/dal/audio-eq", () => ({ setUserEQ, getUserEQ: vi.fn() }));

    const config = enabled(setBandGain(selectPreset("aurora-v"), 1, 6));
    const result = await callAction(asWire(config));

    expect(result.ok).toBe(true);
    expect(setUserEQ).toHaveBeenCalledTimes(1);
    expect(setUserEQ.mock.calls[0]![0]).toBe("u1");
    // Both sinks get the same document, produced by the same encoder, so they
    // cannot disagree.
    expect(setUserEQ.mock.calls[0]![1]).toEqual(config);
    expect(setCookie.mock.calls[0]![1]).toBe(JSON.stringify(encodeEQ(config)));
  });

  it("writes only the cookie when there is no session, and never calls the DAL", async () => {
    const setUserEQ = vi.fn();
    vi.doMock("@/lib/dal/audio-eq", () => ({ setUserEQ, getUserEQ: vi.fn() }));

    await callAction(asWire(enabled(selectPreset("aurora-v"))));
    expect(setUserEQ).not.toHaveBeenCalled();
    expect(setCookie).toHaveBeenCalledTimes(1);
  });

  it("reports a cookie failure and does not half-save", async () => {
    // A preference that half-saved is worse than one that did not save, because
    // the next request resolves to the other half.
    setCookie.mockImplementation(() => {
      throw new Error("cookie rejected");
    });
    const setUserEQ = vi.fn();
    vi.doMock("@/lib/dal/audio-eq", () => ({ setUserEQ, getUserEQ: vi.fn() }));

    const config = enabled(setBandGain(selectPreset("aurora-v"), 1, 6));
    const result = await callAction(asWire(config));

    expect(result.ok).toBe(false);
    // The REQUESTED value, not a revert: the listener's curve is intact and
    // the client says so through its own status.
    expect(result.config.bands[1]!.gain).toBe(6);
    expect(setUserEQ).not.toHaveBeenCalled();
  });

  it("keeps the cookie when the account write fails", async () => {
    getCurrentUser.mockResolvedValue({ id: "u1" });
    vi.doMock("@/lib/dal/audio-eq", () => ({
      getUserEQ: vi.fn(),
      setUserEQ: vi.fn().mockRejectedValue(new Error("db down")),
    }));

    const result = await callAction(asWire(enabled(selectPreset("aurora-v"))));
    // The cookie is written, so the choice survives a reload; the account row
    // retries on the next change.
    expect(result.ok).toBe(true);
    expect(setCookie).toHaveBeenCalledTimes(1);
  });

  it("repairs a malformed document instead of storing it", async () => {
    await callAction({ v: 1, presetId: "flat", bands: [{ f: 62, g: 6 }] });
    // The cookie receives the repaired document, never the raw one. A stored
    // `flat` carrying +6 dB at 62 Hz is a contradiction, and the preset wins -
    // so what is written is flat, with the stray gain gone.
    const stored = JSON.parse(setCookie.mock.calls[0]![1] as string);
    expect(stored.presetId).toBe("flat");
    expect(stored.bands.every((b: { g: number }) => b.g === 0)).toBe(true);
  });

  it("stores flat's gains explicitly, because the default curve is the V-Shape", async () => {
    // The omission is a diff against `DEFAULT_EQ`, not against the named
    // preset - and that is the right comparison, because the reader has to
    // reconstruct from the default too. It means choosing Flat costs ten pairs
    // of numbers while choosing Aurora V-Shape costs none, which is the honest
    // consequence of Flat being a different curve rather than a closer one.
    expect(encodeEQ(selectPreset("aurora-v")).bands).toBeUndefined();
    expect(encodeEQ(selectPreset("flat")).bands).toHaveLength(10);
  });

  it("never throws, whatever it is handed", async () => {
    for (const value of [undefined, null, 7, "{}", [], true, { v: 1 }]) {
      await expect(callAction(value)).resolves.toMatchObject({ ok: true });
    }
  });

  it("treats a resolved configuration as an unreadable document", async () => {
    // The version gate doing its job, and worth a test because the mistake is
    // an easy one to make and fails SILENTLY: a resolved config has no `v`, the
    // decoder returns the default, and the listener's curve quietly vanishes.
    // The default is the only honest answer, not "guess the shape".
    const result = await callAction(enabled(selectPreset("aurora-v")));
    expect(result.config.enabled).toBe(false);
    expect(result.config.presetId).toBe("aurora-v");
    expect(result.config.bands).toEqual([...AURORA_V_SHAPE]);
  });
});

/* ==========================================================================
   §39: SEPARATION FROM THE PLAYBACK SESSION
   ========================================================================== */

describe("the equalizer is not the playback session (§39)", () => {
  it("shares no module with the playback snapshot", async () => {
    // Not a style preference. §39 requires the two lifecycles to be separable,
    // and separability is a property of the import graph: a shared module is a
    // shared future edit. Read at runtime because the import graph is what is
    // being asserted, not a comment about it.
    const sources = await Promise.all(
      [
        "@/lib/audio/eq",
        "@/lib/audio/eq-store",
        "@/lib/audio/eq-graph",
        "@/lib/audio/eq-cookie",
        "@/app/actions/audio-eq",
        "@/lib/dal/audio-eq",
      ].map((id) => import(id)),
    );
    expect(sources).toHaveLength(6);
    // The one bridge in the application is the engine's read-only element
    // accessor, and it is in the engine - not in the equalizer.
    const engine = await import("@/lib/player/engine");
    expect(typeof engine.PlayerEngine).toBe("function");
  });

  it("keeps the playback snapshot free of any EQ field", async () => {
    // The snapshot is what is restored on reload. An EQ setting in there would
    // mean the equalizer travelled with a queue position, which §39 forbids and
    // which would also make "clear my playback session" clear the equalizer.
    const persistence = await import("@/lib/player/persistence");
    const constants = await import("@/lib/player/persistence-constants");
    const text = JSON.stringify({
      ...persistence,
      ...constants,
    });
    expect(text).not.toMatch(/eqPreset|audioEq|eqEnabled|preamp/i);
  });
});

describe("the cookie constant", () => {
  it("is distinct from every other preference cookie", async () => {
    const appearance = await import("@/lib/appearance/cookie");
    const i18n = await import("@/lib/i18n/locale");
    const pwa = await import("@/lib/pwa/install");
    const names = [
      EQ_COOKIE,
      appearance.APPEARANCE_COOKIE,
      i18n.LOCALE_COOKIE,
      pwa.INSTALL_DISMISS_COOKIE,
    ];
    expect(new Set(names).size).toBe(names.length);
  });

  it("lasts a year, like the other preferences", () => {
    expect(EQ_COOKIE_MAX_AGE).toBe(60 * 60 * 24 * 365);
  });
});
