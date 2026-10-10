// @vitest-environment jsdom
/**
 * The Ambient Light DEPTH layer: presets, the seven controls, and the
 * model/persistence/UI contracts that hold them together.
 *
 * The palette engine is NOT under test here — `artwork-palette.test.ts` owns
 * that, and this file deliberately does not re-derive a colour. What is under
 * test is the configuration layer: what a preset applies, when the label
 * becomes Custom, what survives a round trip through the wire format, and what
 * the settings page shows when the feature is off.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  AMBIENT_CUSTOM_CONTROLS,
  AMBIENT_PRESETS,
  AMBIENT_PRESET_IDS,
  DEFAULT_APPEARANCE,
  applyAmbientPreset,
  decodeAppearance,
  encodeAppearance,
  withAmbientControl,
  type Appearance,
} from "@/lib/appearance/appearance";
import { AppearancePanel } from "@/components/appearance/appearance-panel";
import { AppearanceRoot } from "@/components/appearance/appearance-root";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { clearPaletteCache } from "@/lib/appearance/artwork-palette";

function appearance(overrides: Partial<Appearance> = {}): Appearance {
  return { ...DEFAULT_APPEARANCE, background: { kind: "none" }, ...overrides };
}

// The panel reaches the app router through `LocaleProvider`, and the appearance
// action through the root's persistence path. Neither is what this file is
// about, and both need a stand-in in jsdom.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/app/actions/appearance", () => ({
  setAppearanceAction: vi.fn(),
}));

afterEach(cleanup);

describe("Ambient Light: registered palette colours cannot drift", () => {
  /**
   * `@property` descriptors are parsed before the cascade resolves, so their
   * `initial-value` cannot be a `var()` — it is a hard build error. These four
   * therefore repeat the primitive they mirror, which is exactly the kind of
   * second copy this repository does not allow to exist unverified.
   *
   * So it is verified: each `initial-value` is compared against the literal the
   * stylesheet declares for the `--p-*` primitive it stands in for. Move a
   * primitive and forget these, and this fails rather than the ambient palette
   * quietly shifting a shade.
   */
  const globals = readFileSync(
    resolve(process.cwd(), "src/app/globals.css"),
    "utf8",
  );

  const MIRRORS: readonly [property: string, primitive: string][] = [
    ["--aurora-artwork-primary", "--p-aurora-indigo"],
    ["--aurora-artwork-secondary", "--p-aurora-cyan"],
    ["--aurora-artwork-glow", "--p-aurora-violet"],
    ["--aurora-artwork-tint", "--p-neutral-2"],
  ];

  function registeredInitial(property: string): string | null {
    const block = new RegExp(
      `@property\\s+${property}\\s*\\{([^}]*)\\}`,
    ).exec(globals);
    return block?.[1].match(/initial-value:\s*([^;]+);/)?.[1]?.trim() ?? null;
  }

  function primitiveValue(token: string): string | null {
    return (
      new RegExp(`${token}:\\s*([^;]+);`).exec(globals)?.[1]?.trim() ?? null
    );
  }

  it.each(MIRRORS)(
    "%s starts from the same colour as %s",
    (property, primitive) => {
      expect(registeredInitial(property)).toBe(primitiveValue(primitive));
    },
  );

  it.each(MIRRORS)("%s never uses var() in initial-value", (property) => {
    // The regression itself: `initial-value: var(...)` is a parse error that
    // takes the production build down with it.
    expect(registeredInitial(property)).not.toContain("var(");
  });
});

describe("Ambient Light defaults", () => {
  it("is OFF, and a default preset does not enable it", () => {
    // The distinction that matters: a populated depth layer is not consent.
    expect(DEFAULT_APPEARANCE.artworkAmbient).toBe(false);
    expect(DEFAULT_APPEARANCE.ambientPreset).toBe("balanced");
  });

  it("defaults to the Balanced values the stylesheet declares", () => {
    const balanced = AMBIENT_PRESETS.balanced;
    for (const name of [
      "auroraIntensity",
      "ambientBlur",
      "ambientSpread",
      "ambientFade",
    ] as const) {
      expect(DEFAULT_APPEARANCE[name]).toBe(balanced[name]);
    }
  });
});

describe("Ambient Light presets", () => {
  it("exposes exactly the four named looks", () => {
    expect([...AMBIENT_PRESET_IDS]).toEqual([
      "subtle",
      "balanced",
      "immersive",
      "custom",
    ]);
  });

  it("applies each named look's own values", () => {
    const subtle = applyAmbientPreset(appearance(), "subtle");
    const immersive = applyAmbientPreset(appearance(), "immersive");

    expect(subtle.ambientPreset).toBe("subtle");
    expect(immersive.ambientPreset).toBe("immersive");

    // Ordered along the axes the presets claim to differ on.
    expect(subtle.ambientSpread).toBeLessThan(immersive.ambientSpread);
    expect(subtle.ambientBlur).toBeGreaterThan(immersive.ambientBlur);
    expect(subtle.ambientFade).toBeGreaterThan(immersive.ambientFade);
    expect(subtle.auroraIntensity).toBeLessThan(immersive.auroraIntensity);
  });

  it("leaves everything outside Ambient Light untouched", () => {
    const before = appearance({
      glassAlpha: 0.35,
      backgroundDim: 0.25,
      background: { kind: "preset", id: "aurora-night" },
    });
    const after = applyAmbientPreset(before, "immersive");

    expect(after.glassAlpha).toBe(before.glassAlpha);
    expect(after.backgroundDim).toBe(before.backgroundDim);
    expect(after.background).toEqual(before.background);
    expect(after.glass).toBe(before.glass);
    expect(after.preset).toBe(before.preset);
  });

  it("carries through choices a preset does not own", () => {
    // Direction, Transition and Motion are the user's, not the preset's.
    const before = appearance({
      ambientDirection: "left",
      ambientTransition: "none",
      ambientMotion: "full",
    });
    const after = applyAmbientPreset(before, "subtle");

    expect(after.ambientDirection).toBe("left");
    expect(after.ambientTransition).toBe("none");
    expect(after.ambientMotion).toBe("full");
  });

  it("treats Custom as a label, not a fourth look", () => {
    const before = applyAmbientPreset(appearance(), "immersive");
    const custom = applyAmbientPreset(before, "custom");

    // Relabelled, and NOT reset to some invented default.
    expect(custom.ambientPreset).toBe("custom");
    expect(custom.ambientSpread).toBe(before.ambientSpread);
    expect(custom.ambientBlur).toBe(before.ambientBlur);
  });
});

describe("Custom semantics", () => {
  it("switches to Custom on an explicit control edit, for every control", () => {
    for (const name of AMBIENT_CUSTOM_CONTROLS) {
      const named = applyAmbientPreset(appearance(), "balanced");
      const edited = withAmbientControl(named, name, 0.9);
      expect(edited.ambientPreset, `${name} should mark the look Custom`).toBe(
        "custom",
      );
    }
  });

  it("applies the edited value and quantises it", () => {
    const named = applyAmbientPreset(appearance(), "balanced");
    const edited = withAmbientControl(named, "ambientBlur", 0.63);

    expect(edited.ambientBlur).toBe(0.65);
    expect(edited.ambientPreset).toBe("custom");
  });

  it("quantises an out-of-range or hostile value rather than storing it", () => {
    const base = appearance();
    expect(withAmbientControl(base, "ambientSpread", 99).ambientSpread).toBe(1);
    expect(withAmbientControl(base, "ambientFade", -4).ambientFade).toBe(0);
    expect(
      withAmbientControl(base, "ambientBlur", Number.NaN).ambientBlur,
    ).toBe(DEFAULT_APPEARANCE.ambientBlur);
  });

  it("never changes the enabled flag", () => {
    // Turning the feature off is not a customisation of it.
    const edited = withAmbientControl(appearance(), "ambientBlur", 0.2);
    expect(edited.artworkAmbient).toBe(false);
  });
});

describe("persistence", () => {
  it("round-trips every depth field", () => {
    const custom: Appearance = appearance({
      artworkAmbient: true,
      ambientPreset: "custom",
      ambientDirection: "bottom",
      ambientTransition: "fast",
      ambientMotion: "full",
      ambientBlur: 0.15,
      ambientSpread: 0.85,
      ambientFade: 0.35,
      auroraIntensity: 0.65,
    });

    expect(decodeAppearance(encodeAppearance(custom))).toEqual(custom);
  });

  it("omits depth fields that still hold their defaults", () => {
    // The small-cookie strategy: most users never open Ambient Light, so its
    // seven fields should be absent from their cookie entirely.
    const wire = encodeAppearance(appearance());

    expect(wire.ambientPreset).toBeUndefined();
    expect(wire.ambientDirection).toBeUndefined();
    expect(wire.ambientTransition).toBeUndefined();
    expect(wire.ambientMotion).toBeUndefined();
    expect(wire.ambientBlur).toBeUndefined();
    expect(wire.ambientSpread).toBeUndefined();
    expect(wire.ambientFade).toBeUndefined();
    expect(wire.artworkAmbient).toBeUndefined();
  });

  it("decodes a stored value from before the depth layer existed", () => {
    // Backward compatibility: no migration, because absence is the default.
    const legacy = decodeAppearance({
      v: 1,
      glass: false,
      artworkAmbient: true,
      auroraIntensity: 0.9,
    });

    expect(legacy.artworkAmbient).toBe(true);
    expect(legacy.auroraIntensity).toBe(0.9);
    expect(legacy.ambientPreset).toBe("balanced");
    expect(legacy.ambientDirection).toBe("all");
    expect(legacy.ambientBlur).toBe(DEFAULT_APPEARANCE.ambientBlur);
  });

  it("falls back to the default for an unknown enum, keeping its neighbours", () => {
    const decoded = decodeAppearance({
      v: 1,
      artworkAmbient: true,
      ambientDirection: "diagonal",
      ambientTransition: "none",
    });

    expect(decoded.ambientDirection).toBe("all");
    // The valid field alongside it survives; a bad enum is not a bad object.
    expect(decoded.ambientTransition).toBe("none");
    expect(decoded.artworkAmbient).toBe(true);
  });
});

describe("Appearance panel: Ambient Light is a first-class, progressive setting", () => {
  /** Renders through the real shell root, so the draft is read back the way
   *  the stylesheet sees it rather than through a private prop. */
  function renderPanel(initial: Partial<Appearance> = {}, locale = "en") {
    const value = appearance(initial);
    render(
      <AppearanceRoot initial={value} authenticated={false}>
        <LocaleProvider initialLocale={locale as "en" | "vi"}>
          <AppearancePanel />
        </LocaleProvider>
      </AppearanceRoot>,
    );
    return { root: document.querySelector<HTMLElement>("[data-aurora-glass]") };
  }

  /**
   * Opens the "More controls" disclosure.
   *
   * Six of the seven Ambient Light controls live behind it, so any assertion
   * about Blur/Spread/Fade/Direction/Transition/Motion has to say so. Kept as a
   * helper rather than repeating the click so a future change to the
   * disclosure's test id is one edit.
   */
  function openMore() {
    fireEvent.click(screen.getByTestId("ambient-more-toggle"));
  }

  it("shows the switch and hides every depth control while OFF", () => {
    renderPanel({ artworkAmbient: false });

    expect(screen.getByTestId("artwork-ambient")).toBeTruthy();
    expect(screen.getByText("Ambient Light")).toBeTruthy();
    // Progressive disclosure: none of the depth layer exists in the DOM.
    expect(screen.queryByTestId("appearance-ambient-depth")).toBeNull();
    expect(screen.queryByTestId("ambient-preset")).toBeNull();
    expect(screen.queryByTestId("ambient-ambientDirection")).toBeNull();
  });

  /**
   * The Ambient switch is the SAME control as the Glass switch, not a second
   * one.
   *
   * It was a bare `<input type=checkbox>`: no `role`, no `aria-checked` and no
   * word — so a screen reader announced an unlabelled checkbox, and a greyscale
   * or high-contrast user had a tick mark and nothing else. `GlassSwitch`
   * already had this right, and this file's header states the rule ("the switch
   * is a `button[role=switch]` with a visible On/Off word, never colour
   * alone"), so this was the one control in the panel contradicting it.
   */
  it("is a real switch: role, exposed state, a word for the state, and a 44px floor", () => {
    const { root } = renderPanel({ artworkAmbient: false });
    const control = screen.getByTestId("artwork-ambient");

    expect(control.tagName).toBe("BUTTON");
    expect(control.getAttribute("role")).toBe("switch");
    expect(control.getAttribute("aria-checked")).toBe("false");
    // Not colour alone: the state is a word, in the reader's language.
    expect(control.textContent).toContain("Off");
    // Named by the row's title rather than by a `<label for>`, because a
    // `button[role=switch]` is not a labelable control — so with the label gone
    // the name has to be wired explicitly or the switch announces as "Off".
    const labelId = control.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toContain(
      "Enable Ambient Light",
    );
    // The floor is carried by THIS control. Unlike the Glass switch — whose
    // whole row is the button, so the row is already the target — this row is
    // prose beside a control, so the control has to clear `--p-touch-target`
    // itself. `aurora-touch` is a coarse-pointer-only floor (globals.css), so
    // the class is what jsdom can see of it: jsdom applies no stylesheet, and
    // the real measurement is `e2e/mobile-layout.spec.ts`'s per-width sweep.
    expect(control.className).toContain("aurora-touch");

    fireEvent.click(control);

    // Same DOM node, new state — and the word flips with it.
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.textContent).toContain("On");
    expect(control.textContent).not.toContain("Off");
    // Still the one persistence path: `update({ artworkAmbient })` onto the
    // shell root, which is where the stylesheet reads the feature from.
    expect(root?.getAttribute("data-aurora-artwork")).toBe("on");
    expect(screen.getByTestId("appearance-ambient-depth")).toBeTruthy();
  });

  it("reveals the depth layer once enabled", () => {
    renderPanel({ artworkAmbient: true });

    const depth = screen.getByTestId("appearance-ambient-depth");
    // Always visible: the switch, the preset, and intensity. Intensity is the
    // decision someone enabling the feature is actually making, so it is not
    // behind the disclosure.
    expect(within(depth).getByTestId("ambient-preset")).toBeTruthy();
    expect(within(depth).getByLabelText("Ambient Light intensity")).toBeTruthy();
    // The six refinements are NOT rendered until asked for.
    expect(within(depth).queryByTestId("appearance-ambient-more")).toBeNull();
    expect(within(depth).queryByLabelText("Blur")).toBeNull();
    expect(within(depth).queryByTestId("ambient-ambientDirection")).toBeNull();
  });

  it("keeps the six refinements behind one disclosure", () => {
    // Measured reason this exists: with all seven visible, switching Ambient
    // Light on grew the page 169px -> 941px. Progressive disclosure is what
    // brings it back.
    renderPanel({ artworkAmbient: true });
    fireEvent.click(screen.getByTestId("ambient-more-toggle"));

    const more = screen.getByTestId("appearance-ambient-more");
    expect(within(more).getByLabelText("Blur")).toBeTruthy();
    expect(within(more).getByLabelText("Spread")).toBeTruthy();
    expect(within(more).getByLabelText("Fade")).toBeTruthy();
    expect(within(more).getByTestId("ambient-ambientDirection")).toBeTruthy();
    expect(within(more).getByTestId("ambient-ambientTransition")).toBeTruthy();
    expect(within(more).getByTestId("ambient-ambientMotion")).toBeTruthy();
  });

  it("the disclosure is a real expandable region with a state", () => {
    renderPanel({ artworkAmbient: true });
    const toggle = screen.getByTestId("ambient-more-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  /**
   * The chevron, and why it is a path and not a `▾` character.
   *
   * The glyph was never mis-aligned as a BOX — it sat exactly on the button's
   * centre line. It floated high because of where its INK sits inside that box:
   * `▾` in Geist has an ink box 7px above and 2px below the baseline, so the
   * painted centre is 7.5px above the centre of the 20px line box. No flex
   * alignment could fix that, because the element was already centred, and the
   * offset depended on which font the visitor's browser actually resolved.
   *
   * jsdom has no font metrics, so this asserts what it CAN see: the mark is an
   * SVG from the shared icon set (so it carries `aria-hidden` and cannot be
   * read out as text), it flips between the two chevrons with the state, and
   * neither glyph carries a baseline to mis-align against.
   */
  it("marks the disclosure with an icon that flips with its state", () => {
    renderPanel({ artworkAmbient: true });
    const toggle = screen.getByTestId("ambient-more-toggle");

    // Decorative: the button's own text is the accessible name, so a screen
    // reader must not read a second, meaningless thing here.
    expect(toggle.textContent).not.toMatch(/[▾▴]/);

    const chevron = () => toggle.querySelector("svg[aria-hidden='true']");
    const closed = chevron();
    expect(closed, "the disclosure has no chevron").toBeTruthy();
    const closedPath = closed!.querySelector("path")!.getAttribute("d");

    fireEvent.click(toggle);
    const open = chevron();
    expect(
      open!.querySelector("path")!.getAttribute("d"),
      "the chevron did not flip with aria-expanded",
    ).not.toBe(closedPath);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("labels every preset, direction, transition and motion option", async () => {
    renderPanel({ artworkAmbient: true });
    openMore();
    const section = within(screen.getByTestId("appearance-ambient"));
    // Scoped per CONTROL, not per section: "Subtle" names both a preset and a
    // motion level, and "Balanced" also names a glass preset. The labels are
    // correct as specified; they are simply only unambiguous inside their own
    // control, which is how they are rendered.
    //
    // A menu vocabulary, not a native popup: opening each trigger lists its
    // options as `menuitemradio` rows inside the menu it owns.
    const openLabels = async (testId: string): Promise<string[]> => {
      fireEvent.click(section.getByTestId(testId));
      const menu = await screen.findByRole("menu");
      const labels = within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent ?? "");
      fireEvent.click(section.getByTestId(testId));
      return labels;
    };

    expect(await openLabels("ambient-preset")).toEqual([
      "Subtle",
      "Balanced",
      "Immersive",
      "Custom",
    ]);
    expect(await openLabels("ambient-ambientDirection")).toEqual(
      expect.arrayContaining(["All", "Top", "Bottom"]),
    );
    expect(await openLabels("ambient-ambientTransition")).toEqual(
      expect.arrayContaining(["Smooth", "Fast", "None"]),
    );
    expect(await openLabels("ambient-ambientMotion")).toEqual(
      expect.arrayContaining(["Off", "Full"]),
    );
  });

  it("the enumerated controls are menu buttons: one tab stop, and the menu checks the current value", async () => {
    renderPanel({ artworkAmbient: true });

    const section = within(screen.getByTestId("appearance-ambient"));
    const preset = section.getByRole("button", { name: "Preset" });

    // One tab stop while closed: the menu is the platform's job no longer —
    // the rows live behind the trigger, and this is the control the Tab key
    // lands on.
    expect(preset.tagName).toBe("BUTTON");
    expect(preset.getAttribute("tabindex")).toBeNull();
    expect(section.getAllByRole("button", { name: "Preset" })).toHaveLength(1);
    expect(preset.textContent).toContain("Balanced");

    fireEvent.click(preset);
    const menu = await screen.findByRole("menu");
    const checked = within(menu)
      .getAllByRole("menuitemradio")
      .filter((item) => item.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]!.textContent).toContain("Balanced");

    fireEvent.click(within(menu).getByTestId("ambient-preset-immersive"));
    expect(preset.textContent).toContain("Immersive");
  });

  it("the select shows the stored direction, and every option carries its own value", async () => {
    renderPanel({ artworkAmbient: true, ambientDirection: "bottom" });
    openMore();

    const select = screen.getByRole("button", { name: "Direction" });
    expect(select.textContent).toContain("Bottom");

    fireEvent.click(select);
    const menu = await screen.findByRole("menu");
    // The selected value must be reachable by name too, so the menu shows a
    // word rather than an id or a colour — and every row keeps its own testid
    // so a test can name a VALUE not a position.
    expect(within(menu).getByTestId("ambient-ambientDirection-top").textContent).toContain(
      "Top",
    );
    expect(
      within(menu).getByTestId("ambient-ambientDirection-bottom").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("editing a slider switches the preset to Custom", () => {
    const { root } = renderPanel({
      artworkAmbient: true,
      ambientPreset: "balanced",
    });
    openMore();

    const blur = screen.getByLabelText("Blur") as HTMLInputElement;
    fireEvent.change(blur, { target: { value: "0.2" } });

    // Read back off the shell root, which is where the stylesheet reads it.
    expect(root?.getAttribute("data-aurora-artwork")).toBe("on");
    expect(
      parseFloat(root?.style.getPropertyValue("--p-appearance-ambient-blur") ?? ""),
    ).toBe(0.2);
  });

  it("choosing a preset applies its values and does not touch the feature flag", async () => {
    const { root } = renderPanel({ artworkAmbient: true });

    fireEvent.click(screen.getByTestId("ambient-preset"));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByTestId("ambient-preset-immersive"));

    expect(root?.getAttribute("data-aurora-artwork")).toBe("on");
    expect(
      parseFloat(
        root?.style.getPropertyValue("--p-appearance-ambient-spread") ?? "",
      ),
    ).toBe(AMBIENT_PRESETS.immersive.ambientSpread);
  });

  it("writes the direction, transition and motion switches as data attributes", () => {
    const { root } = renderPanel({
      artworkAmbient: true,
      ambientDirection: "left",
      ambientTransition: "none",
      ambientMotion: "off",
    });

    // The stylesheet selects on these, which is how a single-edge direction can
    // set the other three gradients to `none`.
    expect(root?.getAttribute("data-aurora-artwork-direction")).toBe("left");
    expect(root?.getAttribute("data-aurora-artwork-transition")).toBe("none");
    expect(root?.getAttribute("data-aurora-artwork-motion")).toBe("off");
  });

  it("renders Vietnamese labels for the whole section", async () => {
    renderPanel({ artworkAmbient: true }, "vi");
    openMore();
    const section = within(screen.getByTestId("appearance-ambient"));
    // The name comes from the label element the trigger names, so it survives
    // translation the same way the platform association did.
    const openButton = async (name: string) => {
      const button = section.getByRole("button", { name });
      fireEvent.click(button);
      return screen.findByRole("menu");
    };

    expect(screen.getByText("Ánh sáng môi trường")).toBeTruthy();
    expect(section.getByText("Bật ánh sáng môi trường")).toBeTruthy();

    const presetMenu = await openButton("Kiểu");
    expect(within(presetMenu).getByText("Cân bằng")).toBeTruthy();
    expect(within(presetMenu).getByText("Đắm chìm")).toBeTruthy();
    expect(within(presetMenu).getByText("Tùy chỉnh")).toBeTruthy();
    fireEvent.click(section.getByRole("button", { name: "Kiểu" }));

    const directionMenu = await openButton("Hướng");
    expect(within(directionMenu).getByText("Mọi hướng")).toBeTruthy();
    fireEvent.click(section.getByRole("button", { name: "Hướng" }));

    const transitionMenu = await openButton("Chuyển tiếp");
    expect(within(transitionMenu).getByText("Mượt mà")).toBeTruthy();
    fireEvent.click(section.getByRole("button", { name: "Chuyển tiếp" }));

    expect(section.getByText("Độ lan")).toBeTruthy();
    expect(section.getByText("Độ chuyển mờ")).toBeTruthy();
    // The two glow multipliers are localized too, not left as English keys.
    expect(section.getByText("Ánh sáng viền")).toBeTruthy();
    expect(section.getByText("Ánh sáng trình phát")).toBeTruthy();
  });

  /**
   * The two glow multipliers have to reach PAINT, not just the shell root.
   *
   * Both were added for exactly the reason the §32.2 substitution trap exists:
   * a token that is declared and written but never multiplied into a colour is a
   * slider that moves and changes nothing. jsdom has no stylesheet, so the
   * consumption is asserted against the stylesheet source — the same shape as
   * the rest of this repository's structural CSS gates.
   */
  describe("the glow multipliers are consumed by the stylesheet", () => {
    const globals = readFileSync(
      resolve(process.cwd(), "src/app/globals.css"),
      "utf8",
    );

    it("scales every one of the four viewport-edge gradients", () => {
      for (const edge of ["top", "right", "bottom", "left"]) {
        const block = new RegExp(
          `--aurora-artwork-edge-${edge}:\\s*radial-gradient\\(([\\s\\S]*?)\\n\\s*\\);`,
        ).exec(globals);
        expect(block, `--aurora-artwork-edge-${edge} is not a gradient`).toBeTruthy();
        expect(
          block![1],
          `--aurora-artwork-edge-${edge} ignores --p-appearance-ambient-edge`,
        ).toContain("var(--p-appearance-ambient-edge)");
      }
    });

    it("scales both of the Player emitter's box-shadows", () => {
      const emitter = /\[data-aurora-glass\]\[data-aurora-artwork="on"\][^{]*\{([\s\S]*?)\n\}/.exec(
        globals,
      );
      expect(emitter, "the Player emitter rule is gone").toBeTruthy();
      const body = emitter![1];
      // Both shadows, not just one: a control that dims only half of the
      // emitter reads as a broken control.
      const uses = body.match(/var\(--p-appearance-ambient-player\)/g) ?? [];
      expect(uses.length, "both emitter shadows must scale").toBe(2);
    });

    it("multiplies the horizontal nudge into the core gradient", () => {
      // `--aurora-artwork-source-nudge-x` was declared four times and read
      // zero, which made Left and Right a menu that only turned three edges off.
      // Anchored on the LAST declaration, not the first: there are two
      // `--aurora-artwork-core` blocks in this file, and the earlier one is the
      // old viewport-centred edge wash. The player-anchored block is the one
      // that reads the nudge, and it is the one that ends at
      // `--aurora-artwork-layer`.
      const start = globals.lastIndexOf("--aurora-artwork-core:");
      expect(start, "the player-anchored core gradient is gone").toBeGreaterThan(-1);
      const rest = globals.slice(start);
      // Read to the end of the block (its closing brace at column 0), not to a
      // named declaration: `--aurora-artwork-layer` is declared ABOVE this
      // block, so anchoring on it found nothing.
      const end = rest.indexOf("\n}");
      expect(end, "the player-anchored core gradient is unterminated").toBeGreaterThan(-1);
      const block = rest.slice(0, end);
      expect(
        block,
        "the horizontal nudge is still unused, so Left/Right never moves the field",
      ).toContain("var(--aurora-artwork-source-nudge-x)");
      // And the vertical one keeps multiplying the HEIGHT, which is what the
      // ratio-instead-of-percentage rule exists for.
      expect(block).toContain(
        "var(--aurora-artwork-source-h) * var(--aurora-artwork-source-nudge-y)",
      );
    });

    it("leaves the shipped appearance untouched at the default", () => {
      // Both default to 1, which multiplies by nothing. Anything else would
      // silently dim the edges or the Player on upgrade.
      expect(DEFAULT_APPEARANCE.ambientEdgeGlow).toBe(1);
      expect(DEFAULT_APPEARANCE.ambientPlayerGlow).toBe(1);
    });
  });
});

describe("Appearance panel: image-only Advanced controls admit they need a background", () => {
  function renderAdvanced(initial: Partial<Appearance> = {}, locale = "en") {
    render(
      <AppearanceRoot initial={appearance(initial)} authenticated={false}>
        <LocaleProvider initialLocale={locale as "en" | "vi"}>
          <AppearancePanel />
        </LocaleProvider>
      </AppearanceRoot>,
    );
    fireEvent.click(screen.getByTestId("appearance-advanced-toggle"));
  }

  const slider = (name: string) =>
    screen.getByTestId(`control-${name}`) as HTMLInputElement;

  // The image layer is `display: none` at `background: none`, so these three
  // had a live handle and no effect — the exact "state changed, nothing
  // consumed it" shape this audit exists to catch.
  const IMAGE_ONLY = ["backgroundDim", "backgroundSaturation", "backgroundBlur"];
  const ALWAYS = ["glassAlpha", "glassBlur", "glassSaturation", "borderIntensity", "auroraIntensity"];

  it("disables them and says why while no background is chosen", () => {
    renderAdvanced({ background: { kind: "none" } });

    for (const name of IMAGE_ONLY) {
      expect(slider(name).disabled, name).toBe(true);
    }
    // One reason per disabled control, and it is prose rather than a key.
    expect(
      screen.getAllByText(
        "Applies to the background image. Choose one in Background to use this.",
      ),
    ).toHaveLength(IMAGE_ONLY.length);
  });

  it("leaves every control that works without an image alone", () => {
    renderAdvanced({ background: { kind: "none" } });

    for (const name of ALWAYS) expect(slider(name).disabled, name).toBe(false);
  });

  it("re-enables them the moment a background exists", () => {
    renderAdvanced({ background: { kind: "preset", id: "aurora-night" } });

    for (const name of IMAGE_ONLY) expect(slider(name).disabled, name).toBe(false);
  });

  it("states the reason in Vietnamese too, rather than showing a raw key", () => {
    renderAdvanced({ background: { kind: "none" } }, "vi");

    expect(
      screen.getAllByText(
        "Áp dụng cho ảnh nền. Hãy chọn một ảnh trong Nền để dùng thanh này.",
      ).length,
    ).toBe(IMAGE_ONLY.length);
  });
});

describe("palette engine is untouched by the depth layer", () => {
  it("keeps the cache clearable, so nothing here reaches into the palette", () => {
    // A cheap structural reminder: the depth layer adds presentation only, and
    // the palette module's own test surface still exists and works.
    expect(typeof clearPaletteCache).toBe("function");
    clearPaletteCache();
  });
});
