/**
 * Design-token integrity (Phase 44a).
 *
 * The token rebuild is only worth anything if it cannot rot again. The
 * previous token block had seven duplicate alias pairs, a missing
 * primitive layer, and hand-written literal values sitting next to
 * semantic ones — all of which typechecks happily and all of which drift.
 *
 * These tests assert the structural properties that keep a single source
 * of truth intact, and they are deliberately static (they read the CSS
 * text) because the failure modes they guard are not observable at
 * runtime:
 *
 *   1. No self-referential custom property. `--x: var(--x)` is invalid
 *      CSS; the browser drops the declaration and every consumer of that
 *      token silently falls back to an inherited value.
 *   2. No dangling `var()` reference — a typo'd token name resolves to
 *      nothing and renders as transparent-black or an invalid shadow.
 *   3. The legacy shim stays alias-only, so the two token systems can
 *      never disagree about a value (§73).
 *   4. No dead primitives: every `--p-*` value is reachable.
 *   5. Typography classes and components agree in both directions.
 *   6. Decorative motion has a reduced-motion path (§46).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPEARANCE_CONTROL_NAMES,
  APPEARANCE_RANGES,
  DEFAULT_APPEARANCE,
} from "@/lib/appearance/appearance";
import { APPEARANCE_TOKENS } from "@/lib/appearance/apply";

const ROOT = resolve(__dirname, "../../..");
const GLOBALS_PATH = resolve(ROOT, "src/app/globals.css");
const RAW = readFileSync(GLOBALS_PATH, "utf-8");

/**
 * The file with comments removed.
 *
 * This is not cosmetic. The token file documents its own conventions, and
 * that prose contains backticked names — including a literal `@theme` and
 * names like `--radius-*` — so parsing the raw text treats the
 * documentation as declarations. Every structural assertion below reads
 * the stripped copy; only the shim slicer uses `RAW`, and it slices by
 * comment markers before stripping.
 */
const GLOBALS = RAW.replace(/\/\*[\s\S]*?\*\//g, " ");

/**
 * Custom properties injected outside this file. `next/font` writes the
 * Geist family variables onto the root element at runtime, so they are
 * the only legitimate source of a `var()` this file cannot define.
 */
const EXTERNAL_TOKENS = new Set(["--font-geist-sans", "--font-geist-mono"]);

interface Declaration {
  name: string;
  value: string;
  /** `--p-*` primitives are the only literals allowed in the file. */
  primitive: boolean;
}

/** Parses every `--name: value;` declaration, ignoring @keyframes stops. */
function parseDeclarations(css: string): Declaration[] {
  const out: Declaration[] = [];
  // Drop keyframe blocks: they contain `--`-less declarations and their
  // percentages are not custom properties.
  const withoutKeyframes = css.replace(
    /@keyframes\s+[\w-]+\s*\{(?:[^{}]|\{[^{}]*\})*\}/g,
    "",
  );
  const re = /(--[a-z0-9-]+)\s*:\s*([^;{}]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutKeyframes)) !== null) {
    out.push({
      name: m[1],
      value: m[2].trim(),
      primitive: m[1].startsWith("--p-"),
    });
  }
  return out;
}

const DECLARATIONS = parseDeclarations(GLOBALS);
const DEFINED = new Set(DECLARATIONS.map((d) => d.name));

function referencedTokens(css: string): string[] {
  const out = new Set<string>();
  const re = /var\(\s*(--[a-z0-9-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    out.add(m[1]);
  }
  return [...out];
}

/**
 * The temporary shim: the run of declarations between the shim banner and
 * the end of the `:root` block. It is a set of top-level declarations
 * rather than a nested block, so it is sliced by its banner marker.
 */
function legacyShimBlock(): string {
  // `lastIndexOf` matters: the file header also mentions the section by
  // name, and anchoring on the first mention would slice the whole of
  // `:root` instead of the shim.
  const banner = RAW.lastIndexOf("LEGACY ALIASES");
  expect(banner).toBeGreaterThan(-1);
  const from = RAW.indexOf("\n", RAW.indexOf("*/", banner));
  const to = RAW.indexOf("\n}", from);
  expect(to).toBeGreaterThan(from);
  return RAW.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Names published by any `@theme` block, i.e. those that become utilities. */
const THEME_BLOCK_NAMES = (() => {
  const names = new Set<string>();
  const re = /@theme[^{]*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(GLOBALS)) !== null) {
    for (const d of parseDeclarations(m[1])) names.add(d.name);
  }
  return names;
})();


function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const COMPONENT_FILES = [
  ...walk(resolve(ROOT, "src/components")),
  ...walk(resolve(ROOT, "src/app")),
];

/**
 * Hand-written utility families. These are the CSS classes this file owns
 * and exports to components — everything else is a generated Tailwind
 * utility, which cannot be checked without a build.
 */
const UTILITY_FAMILIES = ["t-", "aurora-", "eq-"] as const;

/**
 * Every utility-family class token a component actually applies. Extracted
 * from className values by splitting on whitespace rather than by scanning
 * raw text, so `text-transparent` can never be mistaken for a
 * `t-transparent` role.
 */
function usedUtilityClasses(): Set<string> {
  const used = new Set<string>();
  const patterns = [
    /className="([^"]*)"/g,
    /className=\{`([^`]*)`\}/g,
    /className=\{([^}]*)\}/g,
  ];
  for (const file of COMPONENT_FILES) {
    const source = readFileSync(file, "utf-8");
    for (const pattern of patterns) {
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(source)) !== null) {
        for (const token of m[1].split(/\s+/)) {
          const cleaned = token.replace(/[^a-z0-9-]/g, "");
          if (UTILITY_FAMILIES.some((f) => cleaned.startsWith(f))) {
            used.add(cleaned);
          }
        }
      }
    }
  }
  return used;
}

function definedUtilityClasses(): Set<string> {
  const out = new Set<string>();
  const re = /\.((?:t|aurora|eq)-[a-z0-9-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(GLOBALS)) !== null) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Roles that exist as classes but have no call site yet. Deliberate,
 * bounded debt: each entry names the phase that adopts it. 44d is required
 * to empty the reserved list, so the debt cannot quietly outlive its
 * justification.
 */
const RESERVED_ROLES: Record<string, string> = {
  "t-body": "44d — replaced by t-metadata / t-card-title at denser densities",
  "t-hero": "44b — home hero heading",
  "t-entity-title": "44d — album/artist/playlist headers",
  // `t-label` and `t-utility` left this list in Phase 53, when the Settings
  // appearance panel became their first call site. Removed rather than left
  // in place: this map means "no call site yet", and a role that HAS one and
  // is still listed here would make the list lie about the codebase.
};

describe("design token integrity", () => {
  it("declares no self-referential custom property", () => {
    // A custom property whose value is `var(--itself)` is invalid CSS:
    // the declaration is dropped at parse time and every consumer
    // inherits instead. This is silent, so it needs a static guard.
    const offenders = DECLARATIONS.filter((d) =>
      new RegExp(`var\\(\\s*${d.name.replace(/[-]/g, "\\-")}\\s*[,)]`).test(
        d.value,
      ),
    ).map((d) => `${d.name}: ${d.value}`);

    expect(offenders).toEqual([]);
  });

  it("resolves every var() reference to a defined token", () => {
    const dangling = referencedTokens(GLOBALS).filter(
      (name) => !DEFINED.has(name) && !EXTERNAL_TOKENS.has(name),
    );

    expect(dangling).toEqual([]);
  });

  it("keeps the legacy shim alias-only (single source of truth, §73)", () => {
    const shim = parseDeclarations(legacyShimBlock());

    // A shim entry that carried its own literal would be a second system:
    // the two names could then disagree, which is exactly the defect the
    // previous token block had in seven places.
    const withLiterals = shim.filter(
      (d) => !/^var\(\s*--[a-z0-9-]+\s*\)$/.test(d.value),
    );

    expect(withLiterals.map((d) => `${d.name}: ${d.value}`)).toEqual([]);
  });

  it("gives every primitive a reachable use", () => {
    // Unreachable primitives are the usual way a token file grows forever.
    // A primitive is reachable if something references it, or if a @theme
    // block publishes it as a Tailwind utility. Component references count:
    // a `var(--p-*)` inside a Tailwind arbitrary value
    // (`bottom-[calc(var(--p-queue-sheet-bottom)+...)]`) resolves at runtime
    // and the stylesheet scanner cannot see it, so the scan covers
    // components too rather than forcing a decorative CSS alias for every
    // token a component consumes directly.
    const referenced = new Set(referencedTokens(GLOBALS));
    for (const file of COMPONENT_FILES) {
      for (const token of referencedTokens(readFileSync(file, "utf-8"))) {
        referenced.add(token);
      }
    }
    const themeBlockNames = THEME_BLOCK_NAMES;

    const orphans = DECLARATIONS.filter(
      (d) =>
        d.primitive &&
        !referenced.has(d.name) &&
        !themeBlockNames.has(d.name),
    ).map((d) => d.name);

    expect(orphans).toEqual([]);
  });

  it("defines every utility class that components use", () => {
    // The class of bug this catches is silent: an undefined class is not a
    // build error, it is simply no styling. `bg-gradient-aurora` was
    // exactly that — a class two components relied on that no build ever
    // emitted.
    const missing = [...usedUtilityClasses()].filter(
      (cls) => !definedUtilityClasses().has(cls),
    );

    expect(missing).toEqual([]);
  });

  it("accounts for every utility class with or without a call site", () => {
    const unused = [...definedUtilityClasses()].filter(
      (cls) => !usedUtilityClasses().has(cls),
    );

    // Every class without a call site must be declared, with a reason.
    expect(unused.sort()).toEqual(Object.keys(RESERVED_ROLES).sort());
  });

  it("defines the aurora ambient fill as a class, not a theme key", () => {
    // Tailwind 4.3.3 cannot turn a named gradient theme key into a
    // `bg-gradient-*` utility, so the aurora blend has to be a real class.
    // If someone "simplifies" this back into @theme it silently stops
    // rendering again, with no build error.
    expect(GLOBALS).toMatch(/\.aurora-fill\s*\{[^}]*var\(--aurora-gradient\)/);
    expect(GLOBALS).not.toMatch(/--gradient-aurora\s*:/);
  });

  it("publishes a real utility for each scale it claims to own", () => {
    // Guards the namespaces that generate Tailwind utilities. If one is
    // misspelled it silently stops generating, and the call sites written
    // against it would render unstyled.
    //
    // `--spacing-` is deliberately absent — see the shadowing test below.
    for (const namespace of [
      "--radius-",
      "--shadow-",
      "--blur-",
      "--ease-",
      "--z-index-",
    ]) {
      const published = [...THEME_BLOCK_NAMES].filter((n) =>
        n.startsWith(namespace),
      );
      expect(published.length, `no ${namespace}* published`).toBeGreaterThan(0);
    }
  });

  it("shadows no Tailwind default scale key unintentionally", () => {
    /**
     * Regression guard for a bug that shipped and broke the app.
     *
     * Tailwind's `@theme` namespaces are NOT empty — the framework ships
     * default keys for `--radius-*`, `--container-*`, `--font-*`, and more.
     * A key declared here with the same namespace and name REPLACES that
     * default, silently, with no build error and no type error.
     *
     * Two real failures came out of that:
     *
     *   1. `--spacing-md` shadowed the container scale. Tailwind resolves
     *      `max-w-<name>` against `--container-*` but falls back to
     *      `--spacing-*` on a key match, so `max-w-md` became
     *      `var(--p-space-md)` = 1.25rem instead of 28rem. Every
     *      max-width-constrained surface collapsed app-wide.
     *   2. `--radius-*` was remapped only through `xl`, leaving `2xl`..`4xl`
     *      on Tailwind's numbers and inverting the scale: `rounded-xl`
     *      (1.25rem) came out larger than `rounded-2xl` (1rem).
     *
     * So this test reads Tailwind's real `theme.css` rather than a
     * hand-copied list, and requires every shadowed key to belong to a
     * scale this file deliberately owns in FULL.
     */
    const TAILWIND_THEME = readFileSync(
      join(ROOT, "node_modules/tailwindcss/theme.css"),
      "utf-8",
    ).replace(/\/\*[\s\S]*?\*\//g, " ");

    const tailwindDefaults = new Set<string>();
    for (const m of TAILWIND_THEME.matchAll(/(--[a-z0-9-]+)\s*:/g)) {
      tailwindDefaults.add(m[1]);
    }
    // Guard the guard: if Tailwind ever moves or renames theme.css this
    // parse must fail loudly rather than vacuously pass.
    expect(
      tailwindDefaults.has("--container-md"),
      "could not read Tailwind defaults from theme.css",
    ).toBe(true);
    expect(tailwindDefaults.has("--radius-md")).toBe(true);

    // Ordered scales this file replaces. A partial replacement is the
    // inversion bug from (2) above: the tail keeps Tailwind's numbers and
    // the ramp stops increasing.
    const RAMPS_OWNED_WHOLE = ["radius"];

    // Unordered scales, where replacing a subset is legitimate. Listed per
    // key so adding a new shadowed key is a deliberate act.
    const ENUMERATION_KEYS_ALLOWED = new Set([
      "--font-sans",
      "--font-mono",
    ]);

    const shadowed = [...THEME_BLOCK_NAMES].filter((n) =>
      tailwindDefaults.has(n),
    );

    const unexpected = shadowed.filter((name) => {
      const namespace = name.slice(2).replace(/-[^-]+$/, "");
      if (RAMPS_OWNED_WHOLE.includes(namespace)) return false;
      return !ENUMERATION_KEYS_ALLOWED.has(name);
    });
    expect(
      unexpected,
      `these @theme keys replace a Tailwind default that this file does ` +
        `not deliberately own: ${unexpected.join(", ")}`,
    ).toEqual([]);

    // Any owned ramp must be complete, or the tail keeps Tailwind's
    // numbers and the ramp goes non-monotonic.
    for (const namespace of RAMPS_OWNED_WHOLE) {
      const prefix = `--${namespace}-`;
      const theirs = [...tailwindDefaults].filter((n) => n.startsWith(prefix));
      const mine = shadowed.filter((n) => n.startsWith(prefix));
      const missing = theirs.filter((n) => !mine.includes(n));
      expect(
        missing,
        `--${namespace}-* is partially overridden; Tailwind's remaining ` +
          `defaults would break the ramp: ${missing.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("keeps the spacing scale out of the container namespace", () => {
    // `--spacing-<name>` and `--container-<name>` share their key sets
    // (3xs..4xl), and Tailwind prefers whichever it resolves first when
    // matching `max-w-<name>`. Publishing a space step under a
    // container-scale key silently redefines every `max-w-*` of that name.
    // The space scale is expressed as `--p-space-*` primitives only.
    const TAILWIND_THEME = readFileSync(
      join(ROOT, "node_modules/tailwindcss/theme.css"),
      "utf-8",
    );
    const containerKeys = new Set(
      [...TAILWIND_THEME.matchAll(/--container-([a-z0-9-]+)\s*:/g)].map(
        (m) => m[1],
      ),
    );
    expect(containerKeys.size, "could not read container defaults").toBeGreaterThan(0);

    const offenders = [...THEME_BLOCK_NAMES].filter((n) => {
      if (!n.startsWith("--spacing-")) return false;
      return containerKeys.has(n.slice("--spacing-".length));
    });
    expect(
      offenders,
      `these spacing keys collide with the container scale and would ` +
        `redefine max-w-*: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the radius ramp monotonic", () => {
    // A radius ramp that decreases is a design defect regardless of
    // framework bookkeeping: callers reason about `xl` as "rounder than
    // `lg`". Read the primitives in declaration order.
    const order = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"];
    const values = order.map((step) => {
      const m = GLOBALS.match(
        new RegExp(`--p-radius-${step}:\\s*([0-9.]+)rem`),
      );
      expect(m, `--p-radius-${step} is not declared in rem`).not.toBeNull();
      return Number(m![1]);
    });
    for (let i = 1; i < values.length; i += 1) {
      expect(
        values[i],
        `--p-radius-${order[i]} (${values[i]}rem) must exceed ` +
          `--p-radius-${order[i - 1]} (${values[i - 1]}rem)`,
      ).toBeGreaterThan(values[i - 1]);
    }
  });

  it("gives every decorative animation a reduced-motion path (§46)", () => {
    // The blanket net must exist for transitions declared anywhere,
    // including by dependencies.
    expect(GLOBALS).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?transition-duration:\s*0\.01ms\s*!important/,
    );

    // Decorative motion must additionally be gated at the declaration, so
    // it is never parsed into the cascade when motion is not wanted.
    const MARKER = "@media (prefers-reduced-motion: no-preference)";
    const blockStart = GLOBALS.indexOf(MARKER);
    expect(blockStart, "no no-preference block exists").toBeGreaterThan(-1);

    // Everything from the block's opening brace to its matching close.
    const open = GLOBALS.indexOf("{", blockStart);
    let depth = 0;
    let close = -1;
    for (let i = open; i < GLOBALS.length; i += 1) {
      if (GLOBALS[i] === "{") depth += 1;
      else if (GLOBALS[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    expect(close).toBeGreaterThan(open);

    for (const cls of [".aurora-press", ".aurora-rise", "::view-transition-old"]) {
      const at = GLOBALS.indexOf(cls);
      expect(at, `${cls} is not declared at all`).toBeGreaterThan(-1);
      expect(
        at >= open && at < close,
        `${cls} must be declared inside the no-preference block`,
      ).toBe(true);
    }
  });

  it("keeps the reduced-motion net from hiding state", () => {
    // The net may only shorten motion. It must never touch visibility,
    // opacity, or display, or users who ask for reduced motion would lose
    // the visual state of a control entirely.
    const netStart = GLOBALS.lastIndexOf(
      "@media (prefers-reduced-motion: reduce)",
    );
    const net = GLOBALS.slice(netStart);
    for (const forbidden of ["opacity", "visibility", "display", "transform"]) {
      expect(net).not.toMatch(new RegExp(`^\\s*${forbidden}\\s*:`, "m"));
    }
  });
});

/* ==========================================================================
   AURORA GLASS (Phase 53)
   ========================================================================== */

/**
 * The eight user-facing primitives, and the four derived ones.
 *
 * Separate lists because they are separate claims. The eight are what the
 * Settings sliders write; the four are the levels CSS derives from them. A
 * slider that could write a derived value would let a user produce an alpha
 * ladder with no consistent ratio, which is the one thing a glass system has
 * to guarantee.
 */
const APPEARANCE_PRIMITIVES = Object.values(APPEARANCE_TOKENS);

const APPEARANCE_DERIVED = [
  "--p-appearance-chrome-lift",
  "--p-appearance-float-lift",
  "--p-appearance-scrim-floor",
  "--p-z-backdrop",
] as const;

/** The three surface alphas, which are the derived part of the ladder. */
const GLASS_ALPHAS = [
  "--glass-nested-alpha",
  "--glass-chrome-alpha",
  "--glass-float-alpha",
] as const;

/** The clamp, so it is read rather than assumed. */
const GLASS_ALPHA_CEILING = 0.96;

/** The four surface classes, in the order the hierarchy requires. */
const GLASS_CLASSES = [
  "aurora-glass",
  "aurora-glass-float",
  "aurora-glass-nested",
  "aurora-glass-edge",
] as const;

describe("aurora glass", () => {
  it("agrees with the model about every default, unit for unit", () => {
    // THE ONE-AUTHORITY CHECK, and the most likely thing to rot. The model in
    // `lib/appearance/appearance.ts` decides the defaults, the ranges and the
    // presets; the stylesheet decides how to paint them. The moment those two
    // disagree, a user whose preference is at its default gets one thing from
    // the server-rendered inline style and another from the cascade - a
    // mismatch that only shows up on the first paint, which is the one frame
    // nobody can screenshot twice.
    //
    // Every primitive must exist first: a missing token would make the loop
    // below pass vacuously on `undefined`, which is why the presence check is
    // a separate assertion rather than an assumption. The names come from
    // `APPEARANCE_TOKENS` - the map the runtime actually writes through - so
    // this cannot pass by agreeing with a list the test made up.
    for (const token of [...APPEARANCE_PRIMITIVES, ...APPEARANCE_DERIVED]) {
      expect(DEFINED, token).toContain(token);
    }
    expect(APPEARANCE_PRIMITIVES).toHaveLength(APPEARANCE_CONTROL_NAMES.length);

    // Units compared by parsing rather than by coercion, because the two
    // disagree about form on purpose: the model holds `18` and the token holds
    // `18px`.
    for (const name of APPEARANCE_CONTROL_NAMES) {
      const token = APPEARANCE_TOKENS[name];
      const declaration = DECLARATIONS.find((d) => d.name === token);
      const expected = DEFAULT_APPEARANCE[name];
      expect(typeof expected, name).toBe("number");
      const actual = parseFloat(declaration?.value ?? "");
      expect(actual, `${name}: stylesheet has ${declaration?.value}`).toBeCloseTo(
        expected as number,
        6,
      );
      // And the default is inside the control's own range, so a value restored
      // from storage is never quantised out from under the user.
      const range = APPEARANCE_RANGES[name];
      expect(actual, `${name} below its minimum`).toBeGreaterThanOrEqual(range.min);
      expect(actual, `${name} above its maximum`).toBeLessThanOrEqual(range.max);
    }
  });

  it("derives every surface alpha from the user's alpha, and clamps the lifted ones", () => {
    // The three alphas are the part of the ladder that must not be a literal.
    // A raw percentage written into `--glass-chrome` would mean moving the
    // slider moved one surface and left the other two behind, which is the
    // failure a token system exists to prevent.
    for (const token of GLASS_ALPHAS) {
      const declaration = DECLARATIONS.find((d) => d.name === token);
      expect(declaration, token).toBeDefined();
      expect(declaration?.value, token).toContain("calc(");
      expect(declaration?.value, token).toContain("--p-appearance-alpha");
    }
    // The clamp is not decoration, and it is only needed where a LIFT is added:
    // `color-mix()` with a percentage over 100% is invalid, so a slider at its
    // maximum would produce a declaration the browser drops and the surface
    // would silently go fully transparent. The unlifted one needs no ceiling
    // because the model already bounds the slider below 1.
    for (const token of ["--glass-chrome-alpha", "--glass-float-alpha"]) {
      const value = DECLARATIONS.find((d) => d.name === token)?.value ?? "";
      expect(value, token).toContain("min(");
      expect(value, token).toContain(String(GLASS_ALPHA_CEILING * 100));
    }
  });

  it("keeps the depth ladder ordered at every point on the slider", () => {
    // The actual property, evaluated rather than pattern-matched: a nested
    // control is never more opaque than the surface it sits on, and a chrome
    // surface is never more opaque than the dialog above it. Checked across the
    // whole range because the interesting failures are at the ends - at a very
    // low alpha the lifts dominate, and at the maximum the clamp flattens the
    // top two levels together.
    const lift = (token: string): number =>
      Number(
        DECLARATIONS.find((d) => d.name === token)?.value.trim(),
      );
    const chromeLift = lift("--p-appearance-chrome-lift");
    const floatLift = lift("--p-appearance-float-lift");
    expect(Number.isFinite(chromeLift)).toBe(true);
    expect(Number.isFinite(floatLift)).toBe(true);
    // The two lifts are themselves ordered, so the ladder cannot cross.
    expect(floatLift).toBeGreaterThan(chromeLift);

    const range = DECLARATIONS.find((d) => d.name === "--p-appearance-alpha");
    expect(range).toBeDefined();
    const { min, max } = APPEARANCE_RANGES.glassAlpha;

    for (let alpha = min; alpha <= max + 1e-9; alpha += 0.01) {
      const nested = Math.min(1, alpha);
      const chrome = Math.min(GLASS_ALPHA_CEILING, alpha + chromeLift);
      const float = Math.min(GLASS_ALPHA_CEILING, alpha + floatLift);
      const at = `alpha ${alpha.toFixed(2)}`;
      expect(nested, at).toBeLessThanOrEqual(chrome);
      expect(chrome, at).toBeLessThanOrEqual(float);
      // And nothing exceeds what `color-mix` can be given.
      expect(float, at).toBeLessThanOrEqual(GLASS_ALPHA_CEILING);
    }
  });

  it("keeps the whole glass vocabulary reachable from a use", () => {
    // The existing "gives every primitive a reachable use" rule covers the
    // design tokens; the glass roles are a closed set added on top of them, so
    // a role that is defined and never read would be invisible debt. It is a
    // closed set on purpose: every `--glass-*` role in the stylesheet is either
    // listed here or this test fails on the leftover, which is the only way a
    // duplicate alias like a second focus colour can be caught.
    const used = new Set(referencedTokens(GLOBALS));
    const declared = [...DEFINED].filter((token) => token.startsWith("--glass-"));
    for (const token of declared) {
      expect(used, `${token} is defined but never read`).toContain(token);
    }
    // And the vocabulary is a real one, not a list that shrank to nothing to
    // make the assertion above pass.
    expect(declared.length).toBeGreaterThanOrEqual(11);
  });

  it("scopes every glass rule to the attribute, so OFF is not 'reduced'", () => {
    // THE LOAD-BEARING CLAIM. With `data-aurora-glass="off"` no glass rule is
    // in the cascade at all, rather than resolving to values that happen to
    // resemble the pre-Phase-53 rendering. That is what makes the OFF state
    // provably byte-for-byte the old one instead of approximately it.
    for (const cls of GLASS_CLASSES) {
      const declarations = new RegExp(
        `(^|[,\\s>])\\[data-aurora-glass="on"\\][^{]*\\.${cls}\\s*\\{`,
        "m",
      );
      expect(GLOBALS, `${cls} is not scoped to the glass attribute`).toMatch(
        declarations,
      );
    }
  });

  it("declares no backdrop-filter on a nested surface", () => {
    // `backdrop-filter` samples everything painted behind the element, which
    // includes the already-blurred parent. Two stacked backdrop roots force
    // the browser to snapshot and re-blur the same pixels, and the visual
    // result is a control that looks *less* like glass than the surface around
    // it. A control inside a glass surface therefore gets a tint and a
    // border, and no filter of its own.
    const nested = GLOBALS.indexOf(
      '[data-aurora-glass="on"] .aurora-glass-nested',
    );
    expect(nested, ".aurora-glass-nested is not declared").toBeGreaterThan(-1);
    const open = GLOBALS.indexOf("{", nested);
    const close = GLOBALS.indexOf("}", open);
    expect(close).toBeGreaterThan(open);
    const block = GLOBALS.slice(open, close);
    expect(block).not.toContain("backdrop-filter");
    expect(block).not.toContain("-webkit-backdrop-filter");
  });

  it("removes the filter entirely at zero blur rather than setting it to zero", () => {
    // `blur(0px)` still promotes the element to its own compositing layer and
    // still costs a backdrop copy on every frame, so a user who chose no blur
    // would be paying for the blur they turned off. The switch is an
    // attribute, and the rule is `none`.
    const rule = GLOBALS.slice(
      GLOBALS.indexOf('[data-aurora-glass="on"][data-aurora-blur="off"]'),
    );
    const open = rule.indexOf("{");
    expect(open).toBeGreaterThan(-1);
    const block = rule.slice(0, rule.indexOf("}", open));
    expect(block).toContain("backdrop-filter: none");
    expect(block).not.toContain("blur(0");
  });

  it("falls back to an opaque surface where backdrop-filter does not exist", () => {
    // A browser without `backdrop-filter` must not get a transparent panel
    // with a border and nothing behind it. The fallback is `--surface-*`, which
    // is opaque, so the interface is the plain Aurora theme rather than an
    // unreadable one.
    const at = GLOBALS.indexOf("@supports not");
    expect(at, "no @supports fallback for backdrop-filter").toBeGreaterThan(-1);
    // Read the BLOCK, do not pattern-match the prelude. The previous form
    // required `(backdrop-filter` to sit immediately after `not (` and required
    // the condition to end right there - but the condition has a second
    // alternative, `or (-webkit-backdrop-filter: ...)`, which the old regex had
    // no room for. It was also broken across lines by the formatter. A gate
    // that fails on how the CSS is written is a gate that teaches people to
    // switch it off, so the block is sliced out and judged on what it does.
    const open = GLOBALS.indexOf("{", at);
    const close = GLOBALS.indexOf("}", open);
    const block = GLOBALS.slice(at, close);
    expect(block, "the feature query does not test backdrop-filter").toContain(
      "backdrop-filter",
    );
    expect(
      block,
      "the fallback must be an opaque --surface-* fill, not a transparent one",
    ).toMatch(/background-color:\s*var\(--surface-/);
  });

  it("keeps the decorative drift inside the no-preference block", () => {
    // The ambient wash drifts. That is a constant animation, which the mission
    // forbids unless the visitor has not asked for reduced motion - so the
    // keyframes and the rule that runs them both live inside the block the
    // existing reduced-motion test already established.
    const MARKER = "@media (prefers-reduced-motion: no-preference)";
    const blockStart = GLOBALS.indexOf(MARKER);
    const open = GLOBALS.indexOf("{", blockStart);
    let depth = 0;
    let close = -1;
    for (let i = open; i < GLOBALS.length; i += 1) {
      if (GLOBALS[i] === "{") depth += 1;
      else if (GLOBALS[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    expect(close).toBeGreaterThan(open);
    const inner = GLOBALS.slice(open, close);

    expect(inner, "the drift keyframes are outside the block").toContain(
      "@keyframes aurora-drift",
    );
    // And they are actually applied, not merely defined.
    expect(inner).toMatch(/animation:[^;]*aurora-drift/);
  });

  it("gives every glass class a call site, so none of the four is dead weight", () => {
    const used = usedUtilityClasses();
    for (const cls of GLASS_CLASSES) {
      expect(used, `.${cls} has no call site`).toContain(cls);
    }
  });

  it("keeps backdrop-filter out of the components entirely", () => {
    // THE SCATTERING RULE. Glass is reached through the four utility classes
    // and nothing else, so a component cannot decide how much blur its own
    // surface gets. That is the difference between a glass system and a set of
    // bespoke translucent boxes: with a per-component value there is no longer
    // a single blur radius, no longer a single saturation, and no way to answer
    // "how expensive is this page" without reading every file on it.
    //
    // Comments are stripped first, and deliberately. Several components explain
    // at length why they do NOT have a filter, and that reasoning is the most
    // valuable text in the file - it must not be the thing that fails the gate.
    const offenders: string[] = [];
    for (const file of COMPONENT_FILES) {
      const code = readFileSync(file, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/backdrop-filter|backdropFilter/.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the glass classes off the backdrop layer itself", () => {
    // The one place a filter WOULD be legal is the background image layer, and
    // it is not expressed as a `backdrop-filter` either - it is a `filter` on
    // the image itself, which is a different and much cheaper thing. Asserting
    // the vocabulary is present keeps that decision from being quietly
    // reversed by somebody reaching for the one property that is banned above.
    expect(GLOBALS).toMatch(/\.aurora-backdrop-image\s*\{[^}]*filter:/);
  });
});
