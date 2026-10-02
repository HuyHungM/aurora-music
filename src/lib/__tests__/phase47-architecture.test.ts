import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Phase 47 structural gates for the four new capabilities.
 *
 * These are ownership rules, not behaviour rules: a second toggle, a second
 * queue mutation path, a public surface that can reach a provider's playback
 * or a database identifier. Each of those is invisible to behavioural tests
 * until someone adds the second one, so they are gated at the source level
 * in the same style as the existing playback-singleton gates.
 */

const srcDir = resolve(process.cwd(), "src");

function sourceFiles(): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const fullPath = join(directory, entry);
      if (statSync(fullPath).isDirectory()) {
        return walk(fullPath);
      }
      return fullPath.endsWith(".ts") || fullPath.endsWith(".tsx")
        ? [fullPath]
        : [];
    });
  return walk(srcDir);
}

function productionOffenders(pattern: RegExp, options: { skip?: string[] } = {}) {
  const skip = (options.skip ?? []).map((file) => resolve(srcDir, file));
  return sourceFiles()
    .filter((file) => !file.includes("__tests__"))
    .filter((file) => !skip.includes(file))
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(srcDir.length + 1).split(/[\\/]/).join("/"));
}

const rel = (file: string) => file.slice(srcDir.length + 1).split(/[\\/]/).join("/");

/** Every non-test source file in `src` carrying a file-level "use server". */
function serverActionModules(): string[] {
  return sourceFiles()
    .filter((file) => !file.includes("__tests__"))
    .filter((file) => /^\s*["']use server["'];/.test(readFileSync(file, "utf8")));
}

/**
 * What kind of RUNTIME value an exported name resolves to. `type` and
 * `interface` never appear here: they are erased, so they are not exports
 * and the "use server" rule has nothing to say about them.
 */
type ExportedKind =
  | "async-function" // export async function / const x = async () => {}
  | "function" // export function f() {} — synchronous, not an action
  | "object" // object literal, array, class instance, service, config
  | "value"; // anything else that survives to runtime

interface ModuleExports {
  expressions: Map<string, ExportedKind>;
  hasDefaultExport: boolean;
}

function resolveLocalModule(specifier: string, fromFile: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    base,
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Classifies a top-level declaration list / function into its runtime kind. */
function classifyInitializer(initializer: ts.Expression | undefined): ExportedKind {
  if (!initializer) return "value";
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    return initializer.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
      ? "async-function"
      : "function";
  }
  return "object";
}

/**
 * The runtime export surface of a module, following LOCAL re-exports so a
 * barrel cannot hide a value behind another file. Non-local specifiers
 * (node_modules, the `@/` tree outside src) are left alone: only a local
 * barrel can contaminate a "use server" module's own export list.
 */
function runtimeExports(file: string, seen = new Set<string>()): ModuleExports {
  const expressions = new Map<string, ExportedKind>();
  let hasDefaultExport = false;
  if (seen.has(file)) return { expressions, hasDefaultExport };
  seen.add(file);

  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const modifiers = (node: ts.Node) =>
    ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  const isExported = (node: ts.Node) =>
    modifiers(node).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (node: ts.Node) =>
    modifiers(node).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

  // Local declarations, so `export { helper }` can be resolved to its kind.
  // Type aliases and interfaces are absent by construction: they are erased,
  // so they never enter `localKinds` and never classify as a runtime value.
  const localKinds = new Map<string, ExportedKind>();
  for (const stmt of sf.statements) {
    if (isExported(stmt)) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      localKinds.set(
        stmt.name.text,
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
          ? "async-function"
          : "function",
      );
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          localKinds.set(decl.name.text, classifyInitializer(decl.initializer));
        }
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      localKinds.set(stmt.name.text, "object");
    }
  }

  for (const stmt of sf.statements) {
    // Interfaces and type aliases are erased; they are not runtime exports.
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) continue;

    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue;
      if (isDefault(stmt)) {
        hasDefaultExport = true;
        continue;
      }
      const specifier = stmt.moduleSpecifier;
      const target =
        specifier && ts.isStringLiteral(specifier)
          ? resolveLocalModule(specifier.text, file)
          : null;
      const fromTarget = target ? runtimeExports(target, seen) : null;

      if (!stmt.exportClause) {
        // export * from "./x" — merges the target's whole runtime surface.
        if (fromTarget) {
          if (fromTarget.hasDefaultExport) hasDefaultExport = true;
          for (const [name, kind] of fromTarget.expressions) {
            expressions.set(name, kind);
          }
        }
        continue;
      }
      if (!ts.isNamedExports(stmt.exportClause)) continue;
      for (const element of stmt.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const name = (element.name as ts.Identifier).text;
        // `export { local }` re-exports an identifier declared in this file;
        // `export { x } from "./y"` is decided by the target module.
        const origin = (element.propertyName ?? element.name) as ts.Identifier;
        const kind = fromTarget
          ? (fromTarget.expressions.get(origin.text) ?? "value")
          : (localKinds.get(origin.text) ?? "value");
        expressions.set(name, kind);
      }
      continue;
    }

    // `export default ...` parses as an ExportAssignment, NOT an
    // ExportDeclaration, and it carries no `export` modifier to match on —
    // so it is checked before the isExported() gate below, which would
    // otherwise skip it. Either shape is a violation: a default export from a
    // "use server" module is still a registered action.
    if (ts.isExportAssignment(stmt)) {
      hasDefaultExport = true;
      continue;
    }

    if (!isExported(stmt)) continue;
    if (isDefault(stmt)) {
      hasDefaultExport = true;
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        expressions.set(decl.name.text, classifyInitializer(decl.initializer));
      }
      continue;
    }
    if (ts.isFunctionDeclaration(stmt)) {
      if (!stmt.name) continue;
      expressions.set(
        stmt.name.text,
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
          ? "async-function"
          : "function",
      );
      continue;
    }
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      expressions.set(stmt.name.text, "object");
      continue;
    }
    if (ts.isEnumDeclaration(stmt) && stmt.name) {
      expressions.set(stmt.name.text, "object");
    }
  }

  return { expressions, hasDefaultExport };
}

describe("Phase 47: one keep-listening control", () => {
  // §42: one control, plus contextual access. A *second implementation* — a
  // different icon, a different active colour, a toggle with its own copy of
  // the preference — would let two surfaces disagree about one setting. That
  // is what this gates: the control is one exported component in one file, and
  // every surface renders THAT component rather than writing its own.
  //
  // It is a whitelist, not a prohibition: autoplay legitimately lives in the
  // player and in the queue panel, so the failure this catches is a NEW file
  // growing its own autoplay button, not the known set of hosts.
  it("renders the shared autoplay control from known hosts only", () => {
    const hosts = productionOffenders(/<AutoplayButton\b|<KeepListeningToggle\b/, {
      skip: [
        "components/player/autoplay-button.tsx",
        "components/player/keep-listening-toggle.tsx",
      ],
    });
    expect(hosts.sort()).toEqual([
      "components/player/full-player.tsx",
      "components/player/player-bar.tsx",
      "components/player/queue-panel.tsx",
    ]);
  });

  it("has exactly one autoplay control implementation", () => {
    const implementations = productionOffenders(
      /export function (AutoplayButton|KeepListeningToggle)\b/,
    ).sort();
    expect(implementations).toEqual([
      "components/player/autoplay-button.tsx",
      "components/player/keep-listening-toggle.tsx",
    ]);
  });

  // §15: the UI reads the runtime state; it does not keep a second copy that
  // can drift. The single binding between the coordinator and every surface
  // lives in one hook, so a surface that wanted to diverge would have to
  // re-implement the subscription rather than merely forget to call it.
  it("binds autoplay state in exactly one place", () => {
    const binders = productionOffenders(/\bgetKeepListeningCoordinator\(/, {
      skip: ["lib/listening/instance.ts"],
    });
    expect(binders.sort()).toEqual(["lib/listening/use-keep-listening.ts"]);
  });

  // §65: the coordinator decides WHEN and HOW MANY to generate; QueueManager
  // remains the only thing that writes to the queue. A component appending
  // on its own would bypass the coordinator's generation and epoch guards.
  // Radio is a separate, pre-existing writer and stays authoritative (§56).
  //
  // Granularity is the FILE, not the call: this catches a new surface growing
  // its own queue writer (the realistic failure), not a second method added
  // to one of the listed writers.
  //
  // The sixth entry is the resolved-collection header's "Add all to queue",
  // which is the bulk form of what `track-action-menu.tsx` already does per
  // row: a user-initiated append through `QueueManager`, not a generation
  // source, so the coordinator's guards are untouched. It writes only after
  // `resolveSearchLink` has cross-source matched and deduplicated on
  // canonical identity, so a duplicate cannot reach the queue through it.
  // The seventh entry is the local-files list's per-row "add to queue". It is
  // a user-initiated append through `QueueManager` of the same shape as
  // `track-action-menu.tsx`, not a generation source, so the coordinator's
  // epoch guards are untouched — and it has to exist, because the offline
  // source plays through the one shared engine (RULE 4) and therefore has to
  // reach the one queue.
  it("has no queue writer beyond the known ones", () => {
    const writers = productionOffenders(/\.queue\.(add|replace|clear|remove|reorder)\(/);
    expect(writers.sort()).toEqual([
      "app/(app)/search/link-result.tsx",
      "app/(app)/track/[id]/track-player.tsx",
      "components/offline/offline-library.tsx",
      "components/player/queue-panel.tsx",
      "components/tracks/track-action-menu.tsx",
      "lib/listening/coordinator.ts",
      "lib/radio/session.ts",
    ]);
  });
});

describe("Phase 47: the shared route leaks nothing structural", () => {
  // §9/§18: the public URL is an opaque token. An ungated by-id read would
  // re-open exactly the hole the share token exists to close, so nothing may
  // import one.
  it("nothing imports an ungated by-id playlist read", () => {
    const offenders = productionOffenders(
      /import[^;]*\bgetPlaylist\b[^;]*from\s*["'][^"']*dal\/playlist/,
      { skip: ["lib/dal/playlist.ts"] },
    );
    expect(offenders).toEqual([]);
  });

  // §12: a shared viewer may view, play, queue, like and add to their OWN
  // playlist — and nothing else. The write actions are owner-gated, so the
  // public surface must not even be able to reach one.
  it("the public share surface imports no playlist write action", () => {
    const publicSurface = productionOffenders(
      /(updatePlaylistAction|removeTrackFromPlaylistAction|reorderPlaylistAction|deletePlaylistAction|setPlaylistVisibilityAction)/,
    ).filter((file) =>
      /playlist\/share\/|shared-playlist/.test(file),
    );
    expect(publicSurface).toEqual([]);
  });
});

describe("Phase 47: server action modules", () => {
  /**
   * A module under `app/actions` that a client component imports MUST open
   * with `"use server"`. Without it Next treats the file as an ordinary
   * module and bundles it — and everything it imports — for the browser, so
   * the Prisma/pg chain lands in the client build and the build fails on
   * `util/types`, `fs`, `dns`, `net` and `tls`.
   *
   * Phase 47 shipped exactly this bug: `actions/recommendations.ts` was
   * missing the directive, and `player-host` → `coordinator` → the action
   * took the production build down. The failure is loud, but only at build
   * time, after the unit suite is green — so it is gated here instead.
   */
  it("every module under app/actions opens with the use server directive", () => {
    const actionsDir = resolve(srcDir, "app/actions");
    const modules = sourceFiles().filter(
      (file) => file.startsWith(actionsDir) && !file.includes("__tests__"),
    );
    expect(modules.length).toBeGreaterThan(0);

    const missing = modules
      .filter((file) => !/^\s*["']use server["'];/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(srcDir.length + 1).split(/[\\/]/).join("/"));
    expect(missing).toEqual([]);
  });

  /**
   * The corollary: a `"use server"` module may only export server actions and
   * types. A plain helper exported from one becomes a remotely callable
   * endpoint, so a client could invoke it with arguments the author never
   * intended to accept from the network.
   *
   * Next enforces the same rule from the other side, and it is not a warning.
   * A file-level `"use server"` module has EVERY runtime export registered as
   * an action; when one is not a function, module evaluation throws
   * `A "use server" file can only export async functions, found object`
   * (E352) before the request can complete, taking down every route that
   * transitively reaches the module. A barrel that re-exports a config object
   * and a plain `export default { ... }` both fail that way, and both are
   * invisible to the unit suite because nothing in `app/actions` imports them
   * directly.
   *
   * This gate therefore reads the AST rather than the text, because the text
   * cannot separate the cases that matter:
   *
   *   - `export type` / `export interface` are erased and are NOT exports.
   *     The rule forbids non-function VALUES, so type-only exports are legal
   *     and the action modules rely on it.
   *   - `export const a = async () => {}` is a legal action; a blanket
   *     "no exported const" rule would reject it.
   *   - `export { radioActions }` re-exports a local object without ever
   *     writing the word `const` at the export site.
   *   - `export * from "./config"` contaminates the module from a distance.
   *
   * Reads source only. It asserts nothing about `.next` output, chunk names
   * or generated loader filenames, all of which are build products that
   * change with any unrelated build change.
   */
  it("action modules export only async functions", () => {
    const offenders: string[] = [];
    for (const file of serverActionModules()) {
      for (const [name, kind] of runtimeExports(file).expressions) {
        if (kind === "async-function") continue;
        offenders.push(`${rel(file)} exports \`${name}\` (${kind})`);
      }
      if (runtimeExports(file).hasDefaultExport) {
        offenders.push(`${rel(file)} has a default export`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  /**
   * The reported failure named the radio actions explicitly, so they are
   * pinned by name rather than only by the blanket rule above: a future edit
   * that repackages them behind an object or a barrel fails here with the
   * four action names in the message.
   */
  it("the radio action module exports exactly the four async radio actions", () => {
    const radio = resolve(srcDir, "app/actions/radio.ts");
    expect(existsSync(radio)).toBe(true);

    const { expressions, hasDefaultExport } = runtimeExports(radio);
    expect(hasDefaultExport).toBe(false);
    expect([...expressions.keys()].sort()).toEqual([
      "extendRadioBatchAction",
      "startArtistRadioAction",
      "startDiscoveryRadioAction",
      "startTrackRadioAction",
    ]);
    for (const kind of expressions.values()) {
      expect(kind).toBe("async-function");
    }
  });
});

describe("Phase 47: recommendations are not an external service", () => {
  // §19: no ML, no vector database, no embeddings, no LLM, no external
  // recommendation API. The layer reaches the network only through
  // `RadioDiscoveryBackend`, which is the provider layer's job; a `fetch` in
  // the recommendation layer itself would make the deterministic pipeline a
  // thin veneer over someone else's model.
  it("the recommendation layer makes no network calls of its own", () => {
    const offenders = productionOffenders(/\b(fetch|XMLHttpRequest|EventSource|WebSocket)\b/).filter(
      (file) => file.startsWith("lib/recommendations/"),
    );
    expect(offenders).toEqual([]);
  });

  // §27/§34: ranking is deterministic, so the result must not depend on
  // wall-clock time or randomness. Either would make the same request return
  // different tracks and make the "deterministic" claim false.
  it("the recommendation pipeline uses neither the clock nor randomness", () => {
    for (const file of [
      "lib/recommendations/service.ts",
      "lib/recommendations/signals.ts",
    ]) {
      const source = readFileSync(resolve(srcDir, file), "utf8");
      expect(source, file).not.toMatch(/Math\.random/);
      expect(source, file).not.toMatch(/\bDate\.now\b/);
      expect(source, file).not.toMatch(/new Date\(/);
    }
  });
});
