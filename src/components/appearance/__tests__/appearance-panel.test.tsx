// @vitest-environment jsdom
/**
 * `AppearancePanel` tests (Phase 53).
 *
 * The panel is the only place a visitor can reach any of this, so these tests
 * are mostly about whether the interface tells the truth:
 *
 *   1. EVERY CONTROL IS A REAL CONTROL. A `role="switch"` with `aria-checked`
 *      and a spelled On/Off, a `radiogroup` with a roving tabindex, and native
 *      `input[type=range]` elements whose min/max/step are the model's own. A
 *      reimplemented slider would be a worse slider and a worse one to
 *      maintain, and the platform already knows how arrows and Home/End work.
 *
 *   2. THE STATE IS NEVER COLOUR-ONLY. The selected preset carries `aria-checked`
 *      AND a check glyph; the switch carries a word. Each claim is asserted so
 *      that removing the colour would fail the test rather than silently
 *      degrade the interface.
 *
 *   3. A REFUSED BACKGROUND ADDRESS CHANGES NOTHING. This is the sharpest one.
 *      A preview is not a promise, so a half-typed or rejected address must not
 *      reach the applied value - and the error must be a translated SENTENCE,
 *      never a raw i18n key, which is the mistake that key-based error
 *      plumbing invites.
 *
 *   4. A PRESET OWNS ITS OWN CONTROLS AND NOTHING ELSE. Choosing "Crystal"
 *      must not discard a background image the user set afterwards, and the
 *      values it does own must all land together.
 *
 * The REAL validator runs here, driven through stubbed `fetch` and `Image`, so
 * the wiring between the form and `validateBackgroundImage` is covered rather
 * than a mock of it. Its own edge cases are in
 * `src/lib/appearance/__tests__/background-image.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  APPEARANCE_RANGES,
  DEFAULT_APPEARANCE,
  GLASS_PRESET_IDS,
  applyPreset,
  type Appearance,
} from "@/lib/appearance/appearance";
import { setAppearanceAction } from "@/app/actions/appearance";
import { AppearanceRoot } from "@/components/appearance/appearance-root";
import { AppearancePanel } from "@/components/appearance/appearance-panel";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import type { Locale } from "@/lib/i18n/locale";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/app/actions/appearance", () => ({
  setAppearanceAction: vi.fn(),
}));

vi.mocked(setAppearanceAction).mockResolvedValue({
  ok: true,
  appearance: DEFAULT_APPEARANCE,
});

/* ==========================================================================
   THE BROWSER SURFACE THE VALIDATOR NEEDS
   ========================================================================== */

/** The eight bytes every PNG starts with. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface ImageStub {
  width: number;
  height: number;
  /**
   * The browser would report no dimensions and refuse to decode. Modelled
   * together on purpose: an image that fails to decode has `naturalWidth === 0`
   * in every real browser, so a stub that reported a size alongside a failed
   * decode would be testing a state that cannot occur.
   */
  broken?: boolean;
  /** The address does not resolve at all, so nothing loads. */
  offline?: boolean;
}

let imageStub: ImageStub = { width: 1920, height: 1080 };
/** Every `src` the panel asked an element to load. */
let requestedImages: string[] = [];
/** Every `fetch` the validator made. */
let fetches: { url: string; mode?: string; credentials?: string }[] = [];
let fetchImpl: (url: string) => Response | Promise<Response>;

/** Builds a response carrying PNG magic bytes and a plausible length. */
function pngResponse(bytes = 64_000): Response {
  const buffer = new ArrayBuffer(bytes);
  const view = new Uint8Array(buffer);
  view.set(PNG_MAGIC, 0);
  return new Response(buffer, {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

class StubImage {
  naturalWidth = 0;
  naturalHeight = 0;
  crossOrigin: string | null = null;
  onload: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  #src = "";

  get src(): string {
    return this.#src;
  }

  set src(value: string) {
    this.#src = value;
    requestedImages.push(value);
    // No dimensions, because nothing loaded. A browser reports 0 for an image
    // it could not load OR could not decode, and the validator reads that as
    // the signal it is; a stub that reported a size for a broken image would
    // be testing a state no browser can produce.
    if (imageStub.offline || imageStub.broken) {
      return;
    }
    this.naturalWidth = imageStub.width;
    this.naturalHeight = imageStub.height;
  }

  async decode(): Promise<void> {
    if (imageStub.broken || imageStub.offline) {
      throw new Error("the image could not be decoded");
    }
  }
}

beforeEach(() => {
  imageStub = { width: 1920, height: 1080 };
  requestedImages = [];
  fetches = [];
  fetchImpl = () => pngResponse();
  vi.stubGlobal("fetch", (input: string, init?: { mode?: string; credentials?: string }) => {
    fetches.push({ url: input, ...init });
    return Promise.resolve(fetchImpl(input));
  });
  vi.stubGlobal("Image", StubImage);
  vi.mocked(setAppearanceAction).mockReset().mockResolvedValue({
    ok: true,
    appearance: DEFAULT_APPEARANCE,
  });
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) {
      document.cookie = `${name}=; Max-Age=0; Path=/`;
    }
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ==========================================================================
   RENDERING
   ========================================================================== */

function renderPanel(
  initial: Partial<Appearance> = {},
  locale: Locale = "en",
) {
  const appearance: Appearance = { ...DEFAULT_APPEARANCE, ...initial };
  return render(
    <AppearanceRoot initial={appearance} authenticated={false}>
      <LocaleProvider initialLocale={locale}>
        <AppearancePanel />
      </LocaleProvider>
    </AppearanceRoot>,
  );
}

/** The live draft, read back out of the shell root's custom properties. */
function draft(): Appearance {
  const root = document.querySelector<HTMLElement>("[data-aurora-glass]");
  if (!root) {
    throw new Error("the shell root was not rendered");
  }
  // `parseFloat` rather than `Number`, because the blur tokens carry a `px`
  // unit ("18px") while the rest are bare numbers. Reading them back as
  // numbers is also the only way to assert what the STYLESHEET will see, which
  // is the thing that actually has to be right.
  const read = (property: string): number =>
    parseFloat(root.style.getPropertyValue(property));
  return {
    ...DEFAULT_APPEARANCE,
    glass: root.getAttribute("data-aurora-glass") === "on",
    artworkAmbient: root.getAttribute("data-aurora-artwork") === "on",
    glassAlpha: read("--p-appearance-alpha"),
    glassBlur: read("--p-appearance-blur"),
    glassSaturation: read("--p-appearance-saturation"),
    borderIntensity: read("--p-appearance-border"),
    auroraIntensity: read("--p-appearance-aurora"),
    background: { kind: "none" },
  };
}

/* ==========================================================================
   1. THE SWITCH
   ========================================================================== */

describe("the glass switch", () => {
  it("is a real switch with its state exposed, not a styled checkbox", () => {
    renderPanel();
    const control = screen.getByTestId("glass-switch");
    expect(control.getAttribute("role")).toBe("switch");
    expect(control.getAttribute("aria-checked")).toBe("true");
  });

  it("spells the state in words, so it survives greyscale", () => {
    // The mission's "active states must not be colour-only". A switch whose
    // only difference is a coloured pill is unreadable in high contrast and
    // invisible to a screen reader.
    const { unmount } = renderPanel();
    expect(control1().textContent).toContain("On");
    unmount();

    renderPanel({ glass: false });
    expect(control1().textContent).toContain("Off");
  });

  function control1() {
    return screen.getByTestId("glass-switch");
  }

  it("toggles the value when activated, by click and by keyboard", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("glass-switch"));
    expect(screen.getByTestId("glass-switch").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(draft().glass).toBe(false);

    // A native `button` is reachable and activatable with the keyboard, so the
    // switch is too - asserted rather than assumed, because replacing it with
    // a `div` is the obvious way to break this.
    screen.getByTestId("glass-switch").focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("glass-switch").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(draft().glass).toBe(true);
  });

  it("still works with glass off, and offers the plain surfaces", async () => {
    // An OFF state is a supported configuration, not a broken one: the panel
    // must remain fully usable so the feature can be turned back on.
    const user = userEvent.setup();
    renderPanel({ glass: false });

    await user.click(screen.getByTestId("preset-crystal"));
    expect(draft().glassAlpha).toBe(0.3);

    await user.click(screen.getByTestId("glass-switch"));
    expect(draft().glass).toBe(true);
  });
});

/* ==========================================================================
   2. THE PRESET GROUP
   ========================================================================== */

describe("the preset group", () => {
  it("is a radiogroup with an accessible name, holding exactly the four looks", () => {
    renderPanel();
    const group = screen.getByRole("radiogroup", { name: "Preset" });
    const options = screen.getAllByRole("radio");
    expect(options).toHaveLength(GLASS_PRESET_IDS.length);
    for (const option of options) {
      expect(group.contains(option)).toBe(true);
      expect(option.hasAttribute("aria-checked")).toBe(true);
    }
  });

  it("puts the tab stop on the selected option and nowhere else", () => {
    // THE ROVING TABINDEX. Without it a keyboard user has to Tab through four
    // stops to change one setting, which is how a radiogroup stops being one.
    renderPanel({ preset: "crystal" });
    const selected = screen.getByTestId("preset-crystal");
    expect(selected.getAttribute("tabindex")).toBe("0");
    for (const id of GLASS_PRESET_IDS) {
      if (id === "crystal") continue;
      expect(screen.getByTestId(`preset-${id}`).getAttribute("tabindex"), id).toBe(
        "-1",
      );
    }
  });

  it("marks the selected look with a check glyph as well as with colour", () => {
    // The selected preset already has `aria-checked`; the glyph is for
    // somebody who can see but cannot distinguish the accent from the border.
    const { unmount } = renderPanel({ preset: "aurora" });
    const selected = screen.getByTestId("preset-aurora");
    expect(selected.className).toContain("border-accent");
    expect(selected.querySelector("svg")).not.toBeNull();

    const unselected = screen.getByTestId("preset-minimal");
    expect(unselected.querySelector("svg")).toBeNull();
    unmount();
  });

  it("moves AND selects with the arrow keys, as a radio group must", async () => {
    // Selection following movement is the behaviour that makes arrows feel
    // like a radio group rather than like navigation.
    const user = userEvent.setup();
    renderPanel({ preset: "aurora" });
    screen.getByTestId("preset-aurora").focus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("preset-balanced").getAttribute("aria-checked")).toBe(
      "true",
    );
    // And the focus moved with it.
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "preset-balanced",
    );
    expect(draft().glassAlpha).toBe(
      applyPreset(DEFAULT_APPEARANCE, "balanced").glassAlpha,
    );

    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("preset-crystal").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("wraps around at both ends, and does not scroll the page", async () => {
    const user = userEvent.setup();
    renderPanel({ preset: "aurora" });
    screen.getByTestId("preset-aurora").focus();

    // Backwards from the first option must land on the last, not do nothing.
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByTestId("preset-minimal").getAttribute("aria-checked")).toBe(
      "true",
    );
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("preset-aurora").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("lands every value the preset owns, in one change", async () => {
    // One `update` per choice, so there is no intermediate state in which the
    // alpha has moved and the blur has not. The observable consequence is that
    // the applied value always satisfies the preset as a whole.
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId("preset-crystal"));
    const expected = applyPreset(DEFAULT_APPEARANCE, "crystal");
    const current = draft();
    for (const name of [
      "glassAlpha",
      "glassBlur",
      "glassSaturation",
      "borderIntensity",
      "auroraIntensity",
    ] as const) {
      expect(current[name], name).toBeCloseTo(expected[name], 6);
    }
  });

  it("leaves settings a preset does not own exactly as they were", async () => {
    // THE REGRESSION THIS GUARDS. A preset is a set of glass values, so a user
    // who picks a look, then chooses a background, then picks a DIFFERENT look
    // must keep that background. A preset that reset the whole appearance would
    // take it away, and the user would have no explanation.
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId("background-preset-polar-glow"));
    await user.click(screen.getByTestId("preset-crystal"));

    const root = document.querySelector<HTMLElement>("[data-aurora-background]");
    expect(root?.getAttribute("data-aurora-background")).toBe("preset-polar-glow");
  });
});

/* ==========================================================================
   3. THE BACKGROUND
   ========================================================================== */

describe("the background presets", () => {
  it("offers the shipped images as pressed toggles", () => {
    renderPanel();
    const buttons = [
      "aurora-night",
      "polar-glow",
      "deep-space",
      "northern-light",
      "midnight-bloom",
    ].map((id) => screen.getByTestId(`background-preset-${id}`));
    for (const button of buttons) {
      expect(button.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("applies the one chosen, and marks exactly that one pressed", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId("background-preset-deep-space"));

    expect(
      screen.getByTestId("background-preset-deep-space").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByTestId("background-preset-aurora-night").getAttribute("aria-pressed"),
    ).toBe("false");
    expect(document.querySelector("[data-aurora-background]")?.getAttribute(
      "data-aurora-background",
    )).toBe("preset-deep-space");
  });

  it("deselects the preset when a different background kind is chosen", async () => {
    // A stale "pressed" on a background that is no longer applied would be a
    // control lying about state.
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId("background-preset-deep-space"));
    await user.click(screen.getByTestId("background-remove"));
    expect(
      screen.getByTestId("background-preset-deep-space").getAttribute("aria-pressed"),
    ).toBe("false");
  });
});

describe("the background URL field", () => {
  it("previews what is typed without applying it", async () => {
    // THE PREVIEW CONTRACT. A preview is not a promise; a half-typed address
    // must not drive the whole application.
    const user = userEvent.setup();
    renderPanel();
    const field = screen.getByTestId("background-url");
    await user.type(field, "https://img.test/photo.jpg");

    const preview = screen.getByTestId("background-preview");
    expect((preview as HTMLElement).style.backgroundImage).toContain(
      "https://img.test/photo.jpg",
    );
    // Applied: no.
    expect(
      document.querySelector("[data-aurora-background]")?.getAttribute(
        "data-aurora-background",
      ),
    ).toBe("none");
    expect(fetches).toHaveLength(0);
  });

  it("refuses an insecure address without asking the network", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(
      screen.getByTestId("background-url"),
      "http://img.test/photo.jpg{Enter}",
    );

    const error = await screen.findByTestId("background-error");
    // The sentence says what to do, not merely that something went wrong.
    expect(error.textContent).toContain("https://");
    // Never left the browser: the scheme is checked before the fetch.
    expect(fetches).toHaveLength(0);
    expect(
      document.querySelector("[data-aurora-background]")?.getAttribute(
        "data-aurora-background",
      ),
    ).toBe("none");
  });

  it("refuses credentials in the address", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(
      screen.getByTestId("background-url"),
      "https://user:pw@img.test/a.jpg{Enter}",
    );
    expect(await screen.findByTestId("background-error")).toBeTruthy();
    expect(fetches).toHaveLength(0);
  });

  it("refuses a file that is too large to be worth loading", async () => {
    // The byte cap is the one that protects the user from a 400 MB "image".
    const user = userEvent.setup();
    renderPanel();
    fetchImpl = () => pngResponse(5 * 1024 * 1024);
    await user.type(
      screen.getByTestId("background-url"),
      "https://img.test/huge.jpg{Enter}",
    );
    expect((await screen.findByTestId("background-error")).textContent).toContain(
      "4 MB",
    );
  });

  it("refuses a file whose real type is not an image", async () => {
    const user = userEvent.setup();
    renderPanel();
    fetchImpl = () =>
      new Response("<html>not an image</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    await user.type(
      screen.getByTestId("background-url"),
      "https://img.test/page.html{Enter}",
    );
    expect(await screen.findByTestId("background-error")).toBeTruthy();
    expect(requestedImages).toHaveLength(0);
  });

  it("refuses an image too small to work as a background", async () => {
    const user = userEvent.setup();
    renderPanel();
    imageStub = { width: 64, height: 64 };
    await user.type(
      screen.getByTestId("background-url"),
      "https://img.test/icon.png{Enter}",
    );
    expect((await screen.findByTestId("background-error")).textContent).toContain(
      "480",
    );
  });

  it("refuses an image that will not decode", async () => {
    const user = userEvent.setup();
    renderPanel();
    // Real bytes, a real type, and a browser that will not decode them: a
    // truncated or deliberately malformed payload. Storing it would give a
    // background that is silently blank forever.
    imageStub = { width: 1920, height: 1080, broken: true };
    await user.type(
      screen.getByTestId("background-url"),
      "https://img.test/broken.png{Enter}",
    );
    expect(await screen.findByTestId("background-error")).toBeTruthy();
    expect(
      document.querySelector("[data-aurora-background]")?.getAttribute(
        "data-aurora-background",
      ),
    ).toBe("none");
  });

  it("survives a network failure, and says so in a sentence", async () => {
    const user = userEvent.setup();
    renderPanel();
    // Both routes fail: the CORS request AND the plain image load, which is
    // what a mistyped host actually looks like.
    imageStub = { width: 1920, height: 1080, offline: true };
    fetchImpl = () => {
      throw new Error("offline");
    };
    await user.type(
      screen.getByTestId("background-url"),
      "https://img.test/photo.jpg{Enter}",
    );
    const error = await screen.findByTestId("background-error");
    // A translated SENTENCE, never a key. `settings.backgroundError.networkError`
    // in front of a person is the specific failure this asserts against, and
    // the `role="alert"` is what makes a screen reader say it unprompted.
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).not.toMatch(/settings\./);
    expect(error.textContent?.trim()).not.toBe("");
    // And it is actionable rather than merely negative.
    expect(error.textContent).toContain("connection");
  });

  it("accepts an image from a host that refuses to cooperate over CORS", async () => {
    // THE FALLBACK WORTH KEEPING. A CDN without
    // `Access-Control-Allow-Origin` fails the byte-sniffing fetch, but the
    // browser loads the image perfectly well as an ordinary `<img>`. Refusing
    // it there would reject a large number of perfectly ordinary image hosts
    // for a reason the user cannot do anything about and would not understand.
    const user = userEvent.setup();
    renderPanel();
    // A CORS failure arrives as an opaque response: no `ok`, no readable body.
    fetchImpl = () => new Response(null, { status: 0 });
    await user.type(
      screen.getByTestId("background-url"),
      "https://cdn.test/photo.png{Enter}",
    );

    await waitFor(() =>
      expect(
        document.querySelector("[data-aurora-background]")?.getAttribute(
          "data-aurora-background",
        ),
      ).toBe("url"),
    );
    // The size cap could not be enforced on this route, so it is not claimed
    // to have been - the honest outcome is acceptance on a weaker guarantee.
    expect(fetches).toHaveLength(1);
    expect(requestedImages).toEqual(["https://cdn.test/photo.png"]);
  });

  it("accepts a valid image, and stores the address that was checked", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(
      screen.getByTestId("background-url"),
      "  https://img.test/photo.png  {Enter}",
    );

    await waitFor(() =>
      expect(
        document.querySelector("[data-aurora-background]")?.getAttribute(
          "data-aurora-background",
        ),
      ).toBe("url"),
    );
    const root = document.querySelector<HTMLElement>("[data-aurora-background]");
    // TRIMMED, because the address that was validated is the address that is
    // stored. Storing the raw text would persist leading whitespace that the
    // next validation would have to strip again.
    expect(root?.style.getPropertyValue("--aurora-background-image")).toBe(
      'url("https://img.test/photo.png")',
    );
    // And the field is cleared, so the next paste is not appended to this one.
    expect(
      (screen.getByTestId("background-url") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.queryByTestId("background-error")).toBeNull();
  });

  it("asks the network for exactly what a background needs", async () => {
    // No credentials, and CORS - so a private image behind a session cookie is
    // not sent on the user's behalf, and a CDN that does not allow the read
    // fails here rather than as a broken background later.
    const user = userEvent.setup();
    renderPanel();
    await user.type(
      screen.getByTestId("background-url"),
      "https://img.test/photo.png{Enter}",
    );
    await waitFor(() => expect(fetches).toHaveLength(1));
    expect(fetches[0].mode).toBe("cors");
    expect(fetches[0].credentials).toBe("omit");
  });

  it("clears the error as soon as the address is edited", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(
      screen.getByTestId("background-url"),
      "http://img.test/a.jpg{Enter}",
    );
    expect(await screen.findByTestId("background-error")).toBeTruthy();

    await user.type(screen.getByTestId("background-url"), "x");
    expect(screen.queryByTestId("background-error")).toBeNull();
  });

  it("removes the background, and an empty submission does the same", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId("background-preset-deep-space"));

    await user.click(screen.getByTestId("background-remove"));
    expect(
      document.querySelector("[data-aurora-background]")?.getAttribute(
        "data-aurora-background",
      ),
    ).toBe("none");

    // And the field path: submitting nothing means "no image", not "error".
    await user.click(screen.getByTestId("background-apply"));
    expect(screen.queryByTestId("background-error")).toBeNull();
  });
});

describe("the local preview", () => {
  let revoked: string[];
  let counter: number;

  beforeEach(() => {
    revoked = [];
    counter = 0;
    // A URL whose object-URL methods are observable. It extends the real
    // constructor so `checkBackgroundUrl`'s `new URL(...)` still works.
    class StubURL extends URL {}
    const statics = StubURL as unknown as {
      createObjectURL: (blob: Blob) => string;
      revokeObjectURL: (url: string) => void;
    };
    statics.createObjectURL = () => {
      counter += 1;
      return `blob:aurora-${counter}`;
    };
    statics.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    vi.stubGlobal("URL", StubURL);
  });

  function choose(name: string, type: string) {
    const file = new File([new Uint8Array(PNG_MAGIC)], name, { type });
    // `fireEvent` rather than `user.upload`, because the input's `accept`
    // filter would silently drop the very non-image file this has to prove is
    // refused.
    fireEvent.change(screen.getByTestId("background-upload"), {
      target: { files: [file] },
    });
  }

  function backgroundKind() {
    return document
      .querySelector("[data-aurora-background]")
      ?.getAttribute("data-aurora-background");
  }

  it("offers nothing to remove until a file is chosen", () => {
    renderPanel();
    expect(screen.getByTestId("background-upload")).toBeTruthy();
    expect(screen.queryByTestId("background-upload-remove")).toBeNull();
    expect(screen.queryByTestId("background-upload-active")).toBeNull();
    // The address path is labelled as the one that is kept.
    expect(screen.getByTestId("background-persisted")).toBeTruthy();
  });

  it("adopts a valid file as a session-only preview, and says so", async () => {
    renderPanel();
    choose("cover.png", "image/png");

    await waitFor(() => expect(backgroundKind()).toBe("local"));
    const root = document.querySelector<HTMLElement>("[data-aurora-background]");
    expect(root?.style.getPropertyValue("--aurora-background-image")).toBe(
      'url("blob:aurora-1")',
    );
    expect(screen.getByTestId("background-upload-active").textContent).toContain(
      "session only",
    );
    expect(screen.getByTestId("background-upload-remove")).toBeTruthy();
    // Nothing is written anywhere: no action call, no cookie.
    expect(setAppearanceAction).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain("aurora-appearance");
  });

  it("refuses a non-image file without changing the background", async () => {
    renderPanel();
    choose("page.html", "text/html");

    const error = await screen.findByTestId("background-error");
    expect(error.textContent).not.toMatch(/settings\./);
    expect(backgroundKind()).toBe("none");
    expect(screen.queryByTestId("background-upload-remove")).toBeNull();
  });

  it("revokes the previous object URL when a new file replaces it", async () => {
    renderPanel();
    choose("one.png", "image/png");
    await waitFor(() => expect(backgroundKind()).toBe("local"));

    choose("two.png", "image/png");
    await waitFor(() =>
      expect(
        document
          .querySelector<HTMLElement>("[data-aurora-background]")
          ?.style.getPropertyValue("--aurora-background-image"),
      ).toBe('url("blob:aurora-2")'),
    );
    // The first Blob is released the moment it stops being shown.
    expect(revoked).toEqual(["blob:aurora-1"]);
  });

  it("clears the preview, and reverts to the persisted background", async () => {
    renderPanel();
    choose("cover.png", "image/png");
    await waitFor(() => expect(backgroundKind()).toBe("local"));

    fireEvent.click(screen.getByTestId("background-upload-remove"));

    expect(backgroundKind()).toBe("none");
    expect(revoked).toEqual(["blob:aurora-1"]);
    expect(screen.queryByTestId("background-upload-remove")).toBeNull();
  });
});

/* ==========================================================================
   4. THE ADVANCED CONTROLS
   ========================================================================== */

describe("the advanced disclosure", () => {
  it("is closed to begin with, so the default is four controls and a switch", async () => {
    // A form of ten sliders whose defaults are already good reads as
    // unfinished. The first-time visitor is not shown them.
    const user = userEvent.setup();
    renderPanel();
    const toggle = screen.getByTestId("appearance-advanced-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("appearance-advanced")).toBeNull();
    expect(screen.queryByTestId("control-glassAlpha")).toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("appearance-advanced")).toBeTruthy();
  });

  it("points the toggle at the region it controls", async () => {
    // `aria-expanded` with no `aria-controls` describes a state but gives no
    // way to find what changed.
    const user = userEvent.setup();
    renderPanel();
    const toggle = screen.getByTestId("appearance-advanced-toggle");
    const region = () => screen.getByTestId("appearance-advanced");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-controls")).toBe(region().id);
    expect(region().getAttribute("aria-labelledby")).toBe(toggle.id);
  });

  it("uses native range inputs with the model's own min, max and step", async () => {
    // `step` is the model's, not `any`. A value restored from storage is
    // quantised with that same step, so a handle can never come to rest
    // somewhere the control could not itself produce. Read from the model
    // rather than hardcoded, so widening a range does not silently leave the
    // test asserting a range the product no longer ships.
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId("appearance-advanced-toggle"));

    const slider = screen.getByTestId("control-glassAlpha") as HTMLInputElement;
    const range = APPEARANCE_RANGES.glassAlpha;
    expect(slider.type).toBe("range");
    expect(slider.getAttribute("min")).toBe(String(range.min));
    expect(slider.getAttribute("max")).toBe(String(range.max));
    expect(slider.getAttribute("step")).toBe(String(range.step));
  });

  it("describes each value in a way a screen reader can read out", async () => {
    // A bare "0.62" is meaningless spoken aloud, and "62%" is not either.
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId("appearance-advanced-toggle"));

    const range = APPEARANCE_RANGES.glassAlpha;
    const slider = screen.getByTestId("control-glassAlpha");
    const text = slider.getAttribute("aria-valuetext") ?? "";
    expect(text).toContain("%");
    expect(text).toContain(`${Math.round(DEFAULT_APPEARANCE.glassAlpha * 100)}%`);
    expect(text).toContain(`${Math.round(range.min * 100)}%`);
    expect(text).toContain(`${Math.round(range.max * 100)}%`);
    // And the value is shown as text beside the control, not only on the
    // attribute, because a sighted user cannot hover a screen reader. Scoped,
    // because two controls legitimately read "60%" at the default and an
    // unscoped query would pass for the wrong reason.
    const readout = screen.getByTestId("control-glassAlpha").closest("div");
    expect(readout).not.toBeNull();
    expect(
      within(readout as HTMLElement).getByText(
        `${Math.round(DEFAULT_APPEARANCE.glassAlpha * 100)}%`,
      ),
    ).toBeTruthy();
  });

  it("moves the draft, the stylesheet and the readout together", async () => {
    // THREE CONSUMERS OF ONE VALUE. A slider that updated only its own
    // `aria-valuetext` would leave the glass unchanged; one that updated only
    // the glass would leave the readout lying. All three come from the one
    // draft, so they cannot disagree.
    //
    // A synthetic `change` rather than an arrow key, because jsdom does not
    // implement the browser's arrow-key stepping for a range input. The
    // platform behaviour itself is not what's under test - the wiring is.
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId("appearance-advanced-toggle"));

    const slider = screen.getByTestId("control-glassAlpha");
    const before = draft().glassAlpha;
    fireEvent.change(slider, { target: { value: "0.35" } });

    expect(draft().glassAlpha).toBe(0.35);
    expect(draft().glassAlpha).not.toBe(before);
    // The stylesheet sees it, with the unit the token expects.
    expect(
      document
        .querySelector<HTMLElement>("[data-aurora-glass]")
        ?.style.getPropertyValue("--p-appearance-alpha"),
    ).toBe("0.35");
    // And the readout agrees.
    expect(screen.getByText("35%")).toBeTruthy();
    expect(slider.getAttribute("aria-valuetext")).toContain("35%");
  });

  it("keeps the background dim distinct from the glass alpha", async () => {
    // THE DISTINCTION THE MISSION ASKS FOR. Both are percentages and both
    // darken something, so a single "opacity" control would be ambiguous about
    // what it changes. They are two named controls, and the caption says which
    // is which.
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId("appearance-advanced-toggle"));

    expect(screen.getByTestId("control-backgroundDim")).toBeTruthy();
    expect(screen.getByTestId("control-glassAlpha")).toBeTruthy();
    const dimLabel = screen
      .getByTestId("control-backgroundDim")
      .closest("div")
      ?.textContent;
    const alphaLabel = screen
      .getByTestId("control-glassAlpha")
      .closest("div")
      ?.textContent;
    expect(dimLabel).not.toBe(alphaLabel);
  });

  it("offers the artwork ambience as a labelled checkbox", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId("appearance-advanced-toggle"));

    const toggle = screen.getByTestId("artwork-ambient") as HTMLInputElement;
    expect(toggle.type).toBe("checkbox");
    // Off until asked, and the label is text rather than a tooltip.
    expect(toggle.checked).toBe(false);
    expect(document.querySelector("[data-aurora-artwork]")?.getAttribute(
      "data-aurora-artwork",
    )).toBe("off");

    await user.click(toggle);
    expect(draft().artworkAmbient).toBe(true);
    expect(document.querySelector("[data-aurora-artwork]")?.getAttribute(
      "data-aurora-artwork",
    )).toBe("on");
  });
});

/* ==========================================================================
   5. THE SAVE STATE AND THE RESET
   ========================================================================== */

describe("the save state", () => {
  it("is a live region, so a failure is announced rather than only coloured", () => {
    renderPanel();
    const status = screen.getByTestId("appearance-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("says nothing at all when there is nothing wrong", () => {
    // A region that announced "saved" after every slider step is noise a
    // screen-reader user has to sit through.
    renderPanel();
    expect(screen.getByTestId("appearance-status").textContent).toBe("");
  });
});

describe("the reset control", () => {
  it("restores every value, and says what it does not touch", async () => {
    const user = userEvent.setup();
    renderPanel({
      glass: false,
      preset: "crystal",
      background: { kind: "preset", id: "deep-space" },
      artworkAmbient: true,
    });

    await user.click(screen.getByTestId("appearance-reset"));

    expect(draft().glass).toBe(true);
    expect(draft().glassAlpha).toBe(DEFAULT_APPEARANCE.glassAlpha);
    expect(draft().artworkAmbient).toBe(false);
    expect(
      document.querySelector("[data-aurora-background]")?.getAttribute(
        "data-aurora-background",
      ),
    ).toBe("none");
    // The promise is in the caption, and it is specific: not "your settings".
    expect(screen.getByText(/queue, likes and playlists are not touched/)).toBeTruthy();
  });

  it("is available while the advanced controls are closed", () => {
    // It is not a control hidden behind a disclosure: a person who has changed
    // three things and wants them gone should not have to find a fourth
    // control first.
    renderPanel();
    expect(screen.getByTestId("appearance-reset")).toBeTruthy();
    expect(screen.queryByTestId("appearance-advanced")).toBeNull();
  });
});

/* ==========================================================================
   6. NO RAW TEXT, IN EITHER LANGUAGE
   ========================================================================== */

describe("nothing is hardcoded", () => {
  for (const locale of ["en", "vi"] as const) {
    it(`renders no i18n key and no English text in ${locale}`, async () => {
      const user = userEvent.setup();
      const { container } = renderPanel({}, locale);
      // Open everything, so the labels under test are all on screen.
      await user.click(screen.getByTestId("appearance-advanced-toggle"));

      const text = container.textContent ?? "";
      expect(text).not.toMatch(/\bsettings\.[a-zA-Z]/);
      // No raw CSS custom property, no unresolved template, no `undefined`.
      expect(text).not.toMatch(/--[a-z-]+:/);
      expect(text).not.toMatch(/\bundefined\b/);
      expect(text).not.toMatch(/\bNaN\b/);
      // `interpolate` leaves a `{name}` in place when the parameter is absent,
      // so an unresolved placeholder is visible text and has to fail here too.
      expect(text).not.toMatch(/\{[a-zA-Z]+\}/);
      expect(text.trim().length).toBeGreaterThan(0);
    });
  }

  it("translates the rejection reasons, not just the labels", async () => {
    // The failure path is the one most likely to leak a key, because the reason
    // travels as a key and only the render translates it.
    const user = userEvent.setup();
    const { container } = renderPanel({}, "vi");
    await user.type(
      screen.getByTestId("background-url"),
      "http://img.test/a.jpg{Enter}",
    );
    await screen.findByTestId("background-error");

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/settings\.backgroundError/);
    // And it is actually Vietnamese, not the English string.
    expect(text).not.toContain("encrypted");
  });
});
