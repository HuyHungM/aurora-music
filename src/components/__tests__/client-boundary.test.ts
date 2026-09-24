import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = resolve(process.cwd(), "src");

function walk(directory: string): string[] {
  const entries = readdirSync(directory);
  return entries.flatMap((entry) => {
    const fullPath = join(directory, entry);
    return statSync(fullPath).isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const serverOnlyImports = [
  /from ["']@\/lib\/db["']/,
  /from ["']@\/lib\/dal/,
  /from ["']@\/lib\/auth/,
  /from ["']@\/lib\/config\/env["']/,
  /from ["']@\/lib\/providers\/server["']/,
];

const playerDir = resolve(srcDir, "lib", "player");

function isUnder(dir: string, file: string): boolean {
  const relative = file.startsWith(dir) ? file.slice(dir.length) : file;
  return file.startsWith(dir) && !relative.startsWith("__tests__");
}

describe("client component boundaries", () => {
  it("no client surface imports server-only modules", () => {
    const files = walk(srcDir).filter((file) => {
      if (file.endsWith(".tsx")) {
        return true;
      }
      return isUnder(playerDir, file) && file.endsWith(".ts");
    });
    const offenders: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const isClientFile = content.includes('"use client"') || isUnder(playerDir, file);
      if (!isClientFile) {
        continue;
      }
      const hasServerOnlyImport =
        content.split("\n").some((line) => serverOnlyImports.some((pattern) => pattern.test(line)));
      if (hasServerOnlyImport) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});