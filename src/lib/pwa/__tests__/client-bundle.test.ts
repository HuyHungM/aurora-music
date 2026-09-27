import { dirname } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  scanChunks,
  scanServiceWorkerGuard,
} from "../../../../scripts/verify-client-bundle.mjs";

let directories: string[] = [];

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories = [];
});

function fixtureDir(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "aurora-bundle-"));
  directories.push(directory);
  for (const [name, content] of Object.entries(files)) {
    const fullPath = join(directory, name);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return directory;
}

describe("client bundle scanner", () => {
  it("passes clean client chunks", () => {
    const directory = fixtureDir({
      "app.js": "console.log('player');function play(){return 1}",
      "nested/vendor.js": "var react={};",
    });
    const result = scanChunks(directory);
    expect(result.files).toBe(2);
    expect(result.violations).toEqual([]);
  });

  it("flags server-only markers with file and reason", () => {
    const directory = fixtureDir({
      "app.js": "var youtubei=require('x');",
      "ok.js": "console.log('fine');",
    });
    const result = scanChunks(directory);
    expect(result.files).toBe(2);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.marker).toBe("youtubei");
    expect(result.violations[0]?.file).toContain("app.js");
    expect(typeof result.violations[0]?.reason).toBe("string");
  });

  it("ignores non-JS files", () => {
    const directory = fixtureDir({
      "app.css": ".youtubei{color:red}",
      "app.js": "console.log('fine');",
    });
    const result = scanChunks(directory);
    expect(result.files).toBe(1);
    expect(result.violations).toEqual([]);
  });
});

describe("service-worker secure-context gate", () => {
  // The compiled registration effect as Turbopack actually emits it: the
  // presence test, then the dereference, then the call.
  const compiledGuard =
    'if("u"<typeof navigator||!("serviceWorker"in navigator))return;' +
    "let t=navigator.serviceWorker;if(\"function\"!=typeof t.register)return;t.register(r);";
  const compiledUnguarded =
    'if("u"<typeof navigator)return;let t=navigator.serviceWorker;' +
    'if("function"!=typeof t.register)return;t.register(r);';

  it("accepts a presence test that precedes the registration call", () => {
    const directory = fixtureDir({ "sw.js": compiledGuard });
    const result = scanServiceWorkerGuard(directory);
    expect(result.guarded).toBe(1);
    expect(result.violations).toEqual([]);
  });

  it("flags a registration call with no presence test at all", () => {
    const directory = fixtureDir({ "sw.js": compiledUnguarded });
    const result = scanServiceWorkerGuard(directory);
    expect(result.guarded).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.presenceTest).toBe(-1);
    expect(result.violations[0]?.call).toBeGreaterThan(-1);
  });

  it("flags a presence test that only appears after the call", () => {
    const directory = fixtureDir({
      "sw.js": `${compiledUnguarded}if(!("serviceWorker"in navigator))return;`,
    });
    const result = scanServiceWorkerGuard(directory);
    expect(result.guarded).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.presenceTest).toBeGreaterThan(
      result.violations[0]?.call as number,
    );
  });

  it("ignores chunks that never touch the service worker API", () => {
    const directory = fixtureDir({
      "app.js": "console.log(Object.register&&1);",
      "nested/react.js": "var r={register:function(){}};",
    });
    const result = scanServiceWorkerGuard(directory);
    expect(result.guarded).toBe(0);
    expect(result.violations).toEqual([]);
  });
});
