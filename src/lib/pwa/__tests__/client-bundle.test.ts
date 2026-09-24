import { dirname } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanChunks } from "../../../../scripts/verify-client-bundle.mjs";

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
