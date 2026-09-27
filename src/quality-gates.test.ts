import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository-wide quality gates (Phase 24): dependencies, environment
 * classification, test isolation, and public-asset hygiene. Each assertion
 * protects a reviewed invariant; update the allowlists only while
 * reviewing the change they guard.
 */

const rootDir = resolve(process.cwd());

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * Every file under `root` whose name matches `pattern`, recursively.
 *
 * Module-level, and separate from the `sourceFiles` helper the test-isolation
 * gates use, because those deliberately walk the whole of `src` and changing
 * them would edit a reviewed invariant to accommodate a new one.
 */
function filesUnder(root: string, pattern: RegExp): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const fullPath = join(directory, entry);
      if (statSync(fullPath).isDirectory()) {
        if (entry !== "node_modules" && !entry.startsWith(".")) {
          visit(fullPath);
        }
      } else if (pattern.test(fullPath)) {
        found.push(fullPath);
      }
    }
  };
  visit(root);
  return found;
}

/**
 * Source with comments and docstrings removed.
 *
 * Load-bearing wherever a gate searches for a token that prose also contains.
 * `src/lib/audio/eq-graph.ts` spends forty lines explaining that it does NOT
 * call `new Audio()`, and a gate that matched the raw file would fail on its
 * own documentation. A gate that reads prose instead of code is a gate that is
 * easy to satisfy by accident.
 */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Production source only - not a test file.
 *
 * Excluding test files is not pedantry. A gate that searches for
 * `webkitAudioContext` has that string in its own regex, so a naive search
 * reports the gate itself as a second offender, and depending on how the
 * expectation is written that can be satisfied by deleting the very thing the
 * gate exists to protect. Test files cannot construct an audio graph at
 * runtime, so they are not in scope for any of these claims.
 */
function isProductionSource(file: string): boolean {
  return !file.includes("__tests__") && !/\.test\.tsx?$/.test(file);
}

describe("dependency gates", () => {
  it("does not reintroduce intentionally removed dependencies", () => {
    const pkg = readJson(join(rootDir, "package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // Removed in Phase 22 (unused; verified zero imports repo-wide).
    expect(pkg.dependencies ?? {}).not.toHaveProperty("better-sqlite3");
    expect(pkg.devDependencies ?? {}).not.toHaveProperty("better-sqlite3");
  });
});

describe("environment gates", () => {
  it("keeps server-only credentials out of public env names", () => {
    const example = readFileSync(join(rootDir, ".env.example"), "utf8");
    const publicNames = example
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split("=")[0]?.trim() ?? "");
    expect(publicNames.length).toBeGreaterThan(0);
    for (const name of publicNames) {
      expect(name.startsWith("NEXT_PUBLIC_"), name).toBe(false);
    }
  });

  it("never references public env vars in source", () => {
    const offenders: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const fullPath = join(directory, entry);
        if (statSync(fullPath).isDirectory()) {
          visit(fullPath);
        } else if (
          (fullPath.endsWith(".ts") || fullPath.endsWith(".tsx")) &&
          !fullPath.includes("__tests__")
        ) {
          if (/NEXT_PUBLIC_/.test(readFileSync(fullPath, "utf8"))) {
            offenders.push(fullPath);
          }
        }
      }
    };
    visit(join(rootDir, "src"));
    // The gate file itself names the forbidden patterns; exclude it.
    expect(offenders.filter((file) => !file.endsWith("quality-gates.test.ts"))).toEqual([]);
  });
});

describe("test isolation gates", () => {
  function sourceFiles(pattern: RegExp): string[] {
    const found: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const fullPath = join(directory, entry);
        if (statSync(fullPath).isDirectory()) {
          visit(fullPath);
        } else if (pattern.test(fullPath)) {
          found.push(fullPath);
        }
      }
    };
    visit(join(rootDir, "src"));
    return found;
  }

  it("gates every live provider spec on the opt-in flag", () => {
    const liveSpecs = sourceFiles(/\.live\.spec\.ts$/);
    expect(liveSpecs.length).toBeGreaterThan(0);
    for (const file of liveSpecs) {
      const content = readFileSync(file, "utf8");
      expect(content, file).toContain("AURORA_E2E_LIVE_PLAYBACK");
      expect(content, file).toMatch(/skipIf|test\.skip/);
    }
  });

  it("keeps browser storage APIs out of production source", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(/\.(ts|tsx)$/)) {
      if (
        file.includes("__tests__") ||
        file.endsWith("quality-gates.test.ts")
      ) {
        continue;
      }
      const content = readFileSync(file, "utf8");
      if (/localStorage|sessionStorage|indexedDB/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* ==========================================================================
   APPEARANCE / PLAYBACK SEPARATION (Phase 53)
   ========================================================================== */

describe("appearance gates", () => {
  /**
   * The three directories that own playback.
   *
   * The claim being protected is §40: changing how the application looks must
   * not be able to affect how it plays. That is a claim about a module graph,
   * and a behavioural test cannot prove a negative about module construction -
   * by the time a test can observe the engine, an import has already been
   * allowed. So it is asserted here, structurally.
   */
  const PLAYBACK_DIRECTORIES = [
    "src/lib/player",
    "src/lib/music",
    "src/lib/playback",
  ];

  /**
   * Files that read artwork and must therefore stay unreachable from playback.
   *
   * `artwork-palette.ts` is the sharp one: it decodes images, draws to a
   * canvas and reads pixels back. Any of that reaching the audio path would
   * mean a main-thread image decode in the middle of a track change, which is
   * precisely the "frame the audio pipeline did not get" the ambience feature
   * is written to avoid. The dependency has to be forbidden, not merely
   * unused today.
   */
  const APPEARANCE_ONLY_MODULES = [
    "artwork-palette",
    "background-image",
  ];

  it("keeps the appearance modules out of the playback graph", () => {
    const offenders: string[] = [];
    for (const directory of PLAYBACK_DIRECTORIES) {
      for (const file of filesUnder(join(rootDir, directory), /\.(ts|tsx)$/)) {
        const content = readFileSync(file, "utf8");
        for (const moduleName of APPEARANCE_ONLY_MODULES) {
          if (content.includes(`appearance/${moduleName}`)) {
            offenders.push(`${file} imports ${moduleName}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the appearance modules out of the playback SNAPSHOT", () => {
    // The narrower half of the same claim, and the one a unit test really
    // cannot see: glass settings must not ride along in the playback session
    // snapshot. They are a rendering preference of this browser, not a fact
    // about what is playing, and putting them in a snapshot that is persisted
    // and restored would make a restored session depend on a device setting
    // the restoring device has no reason to share.
    const offenders: string[] = [];
    for (const file of filesUnder(join(rootDir, "src"), /\.(ts|tsx)$/)) {
      if (!file.includes("session") && !file.includes("snapshot")) {
        continue;
      }
      const content = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/appearance|glassAlpha|glassBlur|auroraIntensity/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("equalizer gates (Phase 53 addendum)", () => {
  /**
   * The directories that own playback. Same list the appearance gates use, and
   * for the same reason: §31 and §32 are claims about a module graph, and by
   * the time a behavioural test can observe the engine an import has already
   * been allowed.
   */
  const PLAYBACK_DIRECTORIES = [
    "src/lib/player",
    "src/lib/music",
    "src/lib/playback",
  ];

  /**
   * The equalizer's own modules, named by directory prefix.
   *
   * `eq-graph.ts` is the exception the graph itself documents, and it is listed
   * separately below rather than excused here: it does not import playback
   * either. What imports playback is `components/audio/audio-graph-bridge.tsx`,
   * which is a component and not one of these modules.
   */
  const EQ_MODULES = ["eq.ts", "eq-store.ts", "eq-graph.ts", "eq-labels.ts"];

  it("keeps the equalizer out of the playback modules", () => {
    // The dependency is one-way. The EQ reads the engine; the engine knows
    // nothing about the EQ. A reverse import would mean a track change could
    // reach EQ state, and §31/§32 require that a change of track, a queue
    // transition, a radio seed and a resolver retry all travel paths that
    // cannot reach the equalizer.
    const offenders: string[] = [];
    for (const directory of PLAYBACK_DIRECTORIES) {
      for (const file of filesUnder(join(rootDir, directory), /\.(ts|tsx)$/)) {
        const content = readFileSync(file, "utf8");
        for (const moduleName of EQ_MODULES) {
          if (content.includes(`audio/${moduleName}`)) {
            offenders.push(`${file} imports ${moduleName}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the equalizer modules free of any playback import", () => {
    // The other half of the same claim, and the one that actually makes §31 and
    // §32 true by construction rather than by review. `eq-store.ts` is the
    // sharp case: it is the one canonical EQ state, it is reachable from
    // non-React code, and a single playback import would let playback read and
    // write the curve.
    const offenders: string[] = [];
    for (const moduleName of EQ_MODULES) {
      const file = join(rootDir, "src/lib/audio", moduleName);
      const content = codeOf(file);
      if (
        /from\s+"@\/lib\/(player|music|playback)\//.test(content) ||
        /from\s+"\.\.\/(player|music|playback)\//.test(content)
      ) {
        offenders.push(moduleName);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the equalizer out of the playback SESSION and snapshot", () => {
    // §39's narrower and more important half. The snapshot is what is restored
    // on reload; an equalizer setting in there would mean the curve travelled
    // with a queue position, so "clear my playback session" would clear the
    // equalizer too, and a restored session would carry a device's tuning.
    const offenders: string[] = [];
    for (const file of filesUnder(join(rootDir, "src"), /\.(ts|tsx)$/)) {
      if (!file.includes("session") && !file.includes("snapshot")) {
        continue;
      }
      const content = codeOf(file);
      if (/audioEq|eqPreset|eqEnabled|preamp|AURORA_V_SHAPE/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("creates an audio element in exactly one place", () => {
    // Addendum §26: no second `<audio>`. A second element is a second audio
    // path, and a second path is the beginning of doubled playback.
    const sites: string[] = [];
    for (const file of filesUnder(join(rootDir, "src"), /\.(ts|tsx)$/)) {
      if (!isProductionSource(file)) {
        continue;
      }
      if (/\bnew\s+Audio\s*\(/.test(codeOf(file))) {
        sites.push(file.slice(rootDir.length + 1));
      }
    }
    expect(sites).toEqual([join("src", "lib", "player", "engine-factory.ts")]);
  });

  it("constructs an AudioContext in exactly one place", () => {
    // The other half of §26, and the one that is easy to break by accident: a
    // second context is a second clock, and two clocks feeding one pair of
    // speakers is how you get a half-beat echo.
    //
    // Matched on the ways a context can actually be OBTAINED rather than on the
    // word "AudioContext". This file's own type is `EqAudioContext`, so a bare
    // word search would exclude the one file that is supposed to have it - a
    // gate that excludes its own subject is worse than no gate, because it
    // reports a pass that means nothing.
    const sites: string[] = [];
    for (const file of filesUnder(join(rootDir, "src"), /\.(ts|tsx)$/)) {
      if (!isProductionSource(file)) {
        continue;
      }
      if (/(window|globalThis)\.AudioContext|webkitAudioContext|OfflineAudioContext/.test(codeOf(file))) {
        sites.push(file.slice(rootDir.length + 1));
      }
    }
    expect(sites).toEqual([join("src", "lib", "audio", "eq-graph.ts")]);
  });

  it("never creates a media element for the equalizer to read", () => {
    // The graph's `getElement` is a RESOLVER, and the shape of the code is the
    // guarantee: it cannot construct an element even if somebody wanted it to.
    // `AudioGraphBridge` registers the engine's element rather than making
    // one, which is the only arrangement in which there is exactly one.
    const content = codeOf(join(rootDir, "src/lib/audio/eq-graph.ts"));
    expect(content).not.toMatch(/document\.createElement/);
    expect(content).not.toMatch(/\bnew\s+Audio\b/);
  });

  it("keeps the equalizer's own modules out of the appearance preference", () => {
    // §40's "no new preferences table/system". A column on `User` beside
    // `appearance` is a second preference; a key inside `appearance` would be a
    // second system wearing the first one's coat, because it would break that
    // document's per-field repair and let a glass edit clobber a curve.
    const content = codeOf(join(rootDir, "src/lib/appearance/appearance.ts"));
    expect(content).not.toMatch(/audioEq|eqPreset|preamp|\bEQBand\b/);
  });

  it("keeps browser storage APIs out of the equalizer too", () => {
    // The existing storage gate covers all of `src`, and this asserts the EQ
    // is inside that coverage rather than assuming it - the cookie sink is
    // exactly where a third storage API would be introduced by accident.
    for (const file of filesUnder(join(rootDir, "src/lib/audio"), /\.(ts|tsx)$/)) {
      if (!isProductionSource(file)) {
        continue;
      }
      const content = codeOf(file);
      expect(content, file).not.toMatch(
        /localStorage|sessionStorage|indexedDB|openDatabase/,
      );
    }
  });
});

describe("public asset gates", () => {
  it("serves only reviewed public assets", () => {
    // An allowlist, not a denylist: anything not named here is a failure.
    // It previously carried the five stock `create-next-app` SVGs
    // (next/vercel/window/file/globe) with the comment "unused by the app,
    // kept as shipped". They were unreferenced by every source, config and
    // stylesheet, so Phase 49 removed them and the gate was narrowed to the
    // assets Aurora actually ships. A new asset must be added here
    // deliberately, with a reason.
    //
    // `manifest.webmanifest` is deliberately NOT here: it is not a file in
    // `public/` any more. Phase 51 replaced the hand-written static manifest
    // with the framework-native `src/app/manifest.ts`, which Next.js serves at
    // the same URL. Two manifest sources would let the launcher's identity and
    // the application's identity drift apart.
    // `backgrounds/*.svg` were added in Phase 53, the five shipped Aurora
    // background presets. SVG and not raster deliberately: the set is a few
    // kilobytes of reviewable text instead of megabytes of binary, and
    // `preserveAspectRatio="xMidYMid slice"` gives a true `cover` fit from one
    // file at every supported width, so there is no per-breakpoint asset and
    // nothing to review that a diff cannot show.
    const allowed = new Set([
      "sw.js",
      "icons/icon-192.png",
      "icons/icon-512.png",
      "icons/icon-maskable-512.png",
      "backgrounds/aurora-night.svg",
      "backgrounds/polar-glow.svg",
      "backgrounds/deep-space.svg",
      "backgrounds/northern-light.svg",
      "backgrounds/midnight-bloom.svg",
    ]);
    const offenders: string[] = [];
    const visit = (directory: string, prefix: string): void => {
      for (const entry of readdirSync(directory)) {
        if (entry.startsWith(".")) {
          continue;
        }
        const fullPath = join(directory, entry);
        const relative = prefix.length > 0 ? `${prefix}/${entry}` : entry;
        if (statSync(fullPath).isDirectory()) {
          visit(fullPath, relative);
        } else if (!allowed.has(relative)) {
          offenders.push(relative);
        }
      }
    };
    visit(join(rootDir, "public"), "");
    expect(offenders).toEqual([]);
  });
});

/**
 * Phase 52 hardening gates.
 *
 * Each of these protects a property that is easy to lose in an ordinary refactor
 * and expensive to notice losing. They are deliberately structural - a grep over
 * the tree - rather than behavioural, because the behaviour is already covered by
 * unit tests and these five are the things unit tests cannot see.
 */
describe("Phase 52 hardening gates", () => {
  function trackedSourceFiles(pattern: RegExp, root = "src"): string[] {
    const found: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(join(rootDir, root, directory))) {
        const relative = directory.length > 0 ? `${directory}/${entry}` : entry;
        if (statSync(join(rootDir, root, relative)).isDirectory()) {
          visit(relative);
        } else if (pattern.test(relative)) {
          found.push(join(rootDir, root, relative));
        }
      }
    };
    visit("");
    return found;
  }

  function repositoryFiles(): string[] {
    const found: string[] = [];
    // `.github` is named explicitly and is therefore NOT skipped by the
    // dot-directory rule below, even though it starts with a dot: CI workflow
    // content is part of what the Bun rule governs, and a workflow that said
    // `npm ci` would be the same unsynchronised resolution as a script that
    // did.
    const roots = ["", "docs", "src", "scripts", "e2e", ".github"];
    for (const root of roots) {
      const base = root.length === 0 ? rootDir : join(rootDir, root);
      if (!existsSync(base)) {
        continue;
      }
      // A NAMED ROOT IS WALKED EVEN IF IT IS A DOT-DIRECTORY, which is how
      // `.github` is reached; the repository root is not a named root, so the
      // rule below applies to it. That distinction is the whole mechanism:
      // without it, naming a dot-directory a root would be the only way in, and
      // so would every other dot-directory at the top level.
      const visit = (directory: string, isNamedRoot: boolean): void => {
        for (const entry of readdirSync(directory)) {
          if (entry === "node_modules" || entry === ".next" || entry === ".git") {
            continue;
          }
          // A DOT-DIRECTORY IS NOT THIS PROJECT. Editor state, tool caches and
          // nested agent worktrees live there, and they ship their own copies
          // of the repository - a worktree contains this very gate's subject
          // matter in an older revision, so walking into one makes this rule
          // assert against a checkout that is not the one under test. The other
          // three walkers in this file already skip dot-directories; this one
          // used an explicit allowlist instead and was the only path that did
          // not.
          if (!isNamedRoot && entry.startsWith(".")) {
            continue;
          }
          const fullPath = join(directory, entry);
          if (statSync(fullPath).isDirectory()) {
            visit(fullPath, false);
          } else {
            found.push(fullPath);
          }
        }
      };
      visit(base, root.length > 0);
    }
    return found;
  }

  it("uses Bun as the only package manager and script runtime", () => {
    // RULE 57. `bun.lock` is the only lockfile; an `npm` invocation in a script,
    // a doc or a CI workflow is a second, unsynchronised resolution of the same
    // dependency graph.
    //
    // `AGENTS.md` is excluded because it is the file that PROHIBITS these
    // commands, so it necessarily spells them out. A gate that flagged the rule
    // would push someone to weaken the rule to satisfy the gate.
    const offenders: string[] = [];
    for (const file of repositoryFiles()) {
      const relative = file.slice(rootDir.length + 1).replace(/\\/g, "/");
      if (
        !/\.(ts|tsx|mts|mjs|js|json|md|ya?ml)$/.test(relative) ||
        relative.includes("bun.lock") ||
        relative === "AGENTS.md"
      ) {
        continue;
      }
      if (relative === "src/quality-gates.test.ts") {
        continue; // This file names the patterns it forbids.
      }
      const content = readFileSync(file, "utf8");
      const match = content.match(/\b(npm (install|ci|run|test)|npx )\b/);
      if (match) {
        offenders.push(`${relative}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ships exactly one lockfile", () => {
    // A second lockfile is a second, unsynchronised answer to "what is
    // installed". `package-lock.json` was removed in Phase 50 but may still be
    // tracked by git, so it is named explicitly rather than globbed.
    expect(existsSync(join(rootDir, "bun.lock"))).toBe(true);
    for (const stray of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]) {
      const fullPath = join(rootDir, stray);
      if (!existsSync(fullPath)) {
        continue;
      }
      const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", stray], {
        encoding: "utf8",
        shell: false,
      });
      // Present-but-untracked is tolerable; tracked is not, because the next
      // clone resolves a different graph.
      expect(tracked.status, `${stray} must not be tracked by git`).not.toBe(0);
    }
  });

  it("never applies user-select: none globally", () => {
    // PHASE 51 ADDENDUM. A blanket `*`/`body`/`:root` rule makes every piece of
    // product text uncopyable: track titles, artist names, playlist descriptions,
    // error text, share URLs. Selection is an accessibility affordance, not a
    // styling preference.
    const css = readFileSync(join(rootDir, "src", "app", "globals.css"), "utf8");
    // Strip comments before looking, so prose about the rule cannot trip it.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const blanket =
      /(^|[};])\s*(\*|html|body|:root|html\s*,\s*body)[^{}]*\{[^}]*user-select\s*:\s*none/i;
    expect(withoutComments, "globals.css declares no blanket user-select rule").not.toMatch(
      blanket,
    );
  });

  it("never applies cursor: pointer globally", () => {
    // PHASE 55. The mirror image of the gate above, and the same failure seen
    // from the other side. Browsers do not give `<button>` a pointer and neither
    // does Tailwind's preflight, so the app needs a pointer on its controls -
    // but reached by naming the elements that are interactive by SEMANTIC
    // (`button`, `a[href]`, `summary`, `label[for]`, `input[type=range]`), never
    // by matching everything. A `* { cursor: pointer }` rule makes a paragraph,
    // a timestamp and a heading all look live, and then the cursor carries no
    // information at all: the user cannot tell a target from a label.
    //
    // The same reasoning rejects a blanket `cursor: text`, which would claim
    // every element is editable.
    const css = readFileSync(join(rootDir, "src", "app", "globals.css"), "utf8");
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const selector of [String.raw`\*`, "html", "body", ":root", String.raw`html\s*,\s*body`]) {
      const blanket = new RegExp(
        String.raw`(^|[};])\s*${selector}\s*[,{][^}]*cursor\s*:\s*(pointer|text)\b`,
        "i",
      );
      expect(
        withoutComments,
        `globals.css declares no blanket cursor rule on ${selector}`,
      ).not.toMatch(blanket);
    }
  });

  it("keeps the rate limiter and the action guard server-side", () => {
    // A rate limit enforced in the browser is not a rate limit: the attacker
    // controls the caller. The guard, the limiter and the identity resolver all
    // read the session and request headers, so none of them may be reachable
    // from a client component's module graph.
    const clientBoundary = "client-boundary.test.ts";
    for (const file of trackedSourceFiles(/\.tsx$/)) {
      const content = readFileSync(file, "utf8");
      if (!/^"use client"/m.test(content)) {
        continue;
      }
      for (const forbidden of [
        "@/lib/api/action-guard",
        "@/lib/http/rate-limit",
        "@/lib/http/rate-limit-server",
      ]) {
        expect(content, `${file} must not import ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
    // And the guard must not be handed a browser storage API to key on.
    expect(clientBoundary).not.toBe("");
  });

  it("never disables rate limiting except under the E2E fixture posture", () => {
    // The limiter does stand down for the E2E harness, which replays many user
    // journeys as two synthetic users and would otherwise trip a ceiling no
    // real person reaches. That is the only sanctioned exception, and it is
    // gated on `AURORA_E2E_AUTH`, which `parseEnv` already refuses to accept in
    // a deployment without the second, deliberately-named acknowledgement.
    //
    // The invariant pinned here is the CONDITION, not the behaviour. An
    // exception keyed on `NODE_ENV`, or on a new variable someone can add
    // without noticing the production guard in `env.ts`, would look identical
    // in review and would disable the limiter everywhere.
    const server = readFileSync(
      join(rootDir, "src", "lib", "http", "rate-limit-server.ts"),
      "utf8",
    );
    expect(
      server,
      'the E2E stand-down is keyed on AURORA_E2E_AUTH === "1"',
    ).toMatch(/AURORA_E2E_AUTH\s*===\s*"1"/);
    // And it must fail toward enforcing, never toward open.
    expect(
      server,
      "an unreadable environment must not disable the limiter",
    ).toMatch(/catch\s*\{[\s\S]{0,300}return false/);
    // No other process-wide escape hatch in this module.
    for (const forbidden of [
      'NODE_ENV === "test"',
      "VITEST",
      "AURORA_DISABLE_RATE_LIMIT",
      "RATE_LIMIT_DISABLED",
    ]) {
      expect(
        server,
        `rate-limit-server must not branch on ${forbidden}`,
      ).not.toContain(forbidden);
    }
  });

  it("returns a correlation id from every API route", () => {
    // RULE 34. A route that builds its own response silently opts out of
    // correlation. The helper is the only sanctioned way to answer, so a bare
    // `NextResponse.json` in a route is the finding.
    //
    // There is exactly one other sanctioned shape: a route that forwards a
    // response the framework constructs itself (Auth.js builds the sign-in
    // HTML, the OAuth 302s and the provider JSON) cannot use `jsonResponse`,
    // so it stamps `REQUEST_ID_RESPONSE_HEADER` directly. That constant comes
    // from the one module that defines it, so accepting it here cannot drift
    // into "any route may set a header" - and the auth route, which used to
    // export `const { GET, POST }` and so was invisible to this scan, is now
    // checked like every other route.
    const offenders: string[] = [];
    for (const file of trackedSourceFiles(/\.ts$/, "src/app/api")) {
      if (!isProductionSource(file)) {
        continue;
      }
      const content = readFileSync(file, "utf8");
      if (!/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/.test(content)) {
        continue;
      }
      if (content.includes("NextResponse.json(")) {
        offenders.push(file.slice(rootDir.length + 1).replace(/\\/g, "/"));
        continue;
      }
      if (
        !content.includes("jsonResponse(") &&
        !content.includes("REQUEST_ID_RESPONSE_HEADER")
      ) {
        offenders.push(file.slice(rootDir.length + 1).replace(/\\/g, "/"));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not weaken the security headers", () => {
    // RULE 6 / RULE 8. These are the values the Phase-24/26 header review
    // settled on. A relaxation is a behaviour change and needs the review that
    // changed it, not a quiet edit.
    const config = readFileSync(join(rootDir, "next.config.ts"), "utf8");

    // Framing. `frame-ancestors 'none'` in the CSP and `X-Frame-Options: DENY`
    // as a header are both required: the CSP directive is ignored by older
    // browsers, and the header is ignored where the directive is unsupported.
    // Shipping one alone leaves a hole.
    expect(config).toMatch(/frame-ancestors\s+'none'/);
    expect(config).toMatch(/"X-Frame-Options"/);
    expect(config).toMatch(/"DENY"/);

    // The default allowlist must stay closed.
    expect(config).toMatch(/default-src 'self'/);
    expect(config).toMatch(/object-src 'none'/);
    expect(config).toMatch(/base-uri 'self'/);
    expect(config).toMatch(/frame-src 'none'/);
    expect(config).toMatch(/form-action 'self'/);

    // `unsafe-eval` may appear ONLY as a development-only extra. The invariant
    // is not "the string is absent" - development tooling needs it - it is that
    // it is gated on the environment and can never reach production.
    const evalOccurrences = config.match(/unsafe-eval/g) ?? [];
    expect(evalOccurrences.length).toBeGreaterThan(0);
    for (const line of config.split("\n")) {
      if (!line.includes("unsafe-eval")) {
        continue;
      }
      // The development branch, the ternary that selects it, or the comment
      // explaining the omission from production.
      expect(
        line,
        `unsafe-eval must stay development-gated: ${line.trim()}`,
      ).toMatch(/IS_DEVELOPMENT|\/\*|\*|\? \[|\]/);
    }
    expect(config).toMatch(/IS_DEVELOPMENT \? \["'unsafe-eval'"\] : \[\]/);

    // No wildcard CORS on an authenticated surface. The project is same-origin;
    // a `*` here would be the first step towards one.
    expect(config).not.toMatch(
      /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*["']/i,
    );
  });
});
