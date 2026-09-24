import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const publicDir = resolve(process.cwd(), "public");

interface ManifestIcon {
  src: string;
  sizes?: string;
  type?: string;
  purpose?: string;
}

interface Manifest {
  name?: string;
  short_name?: string;
  description?: string;
  start_url?: string;
  display?: string;
  theme_color?: string;
  background_color?: string;
  icons?: ManifestIcon[];
}

/** Minimal PNG IHDR reader: signature + width/height, nothing else. */
function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) {
      throw new Error(`${path} is not a PNG file`);
    }
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function loadManifest(): Manifest {
  const path = join(publicDir, "manifest.webmanifest");
  expect(existsSync(path), "manifest.webmanifest exists").toBe(true);
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

describe("web app manifest", () => {
  it("carries the Aurora product identity", () => {
    const manifest = loadManifest();
    expect(manifest.name).toBe("Aurora Music");
    expect(manifest.short_name).toBe("Aurora");
    expect(typeof manifest.description).toBe("string");
    expect((manifest.description ?? "").length).toBeGreaterThan(0);
  });

  it("uses a safe start URL and standalone display", () => {
    const manifest = loadManifest();
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("keeps theme metadata coherent with the dark app theme", () => {
    const manifest = loadManifest();
    expect(manifest.theme_color).toBe("#08070d");
    expect(manifest.background_color).toBe("#08070d");
  });

  it("declares installable icons that exist with matching dimensions", () => {
    const manifest = loadManifest();
    const icons = manifest.icons ?? [];
    const bySizes: Record<string, ManifestIcon[]> = {};
    for (const icon of icons) {
      expect(icon.src.startsWith("/")).toBe(true);
      expect(icon.type).toBe("image/png");
      const dimensions = pngDimensions(join(publicDir, icon.src));
      expect(`${dimensions.width}x${dimensions.height}`).toBe(icon.sizes);
      bySizes[icon.sizes ?? ""] = [...(bySizes[icon.sizes ?? ""] ?? []), icon];
    }
    expect(Object.keys(bySizes)).toContain("192x192");
    expect(Object.keys(bySizes)).toContain("512x512");
    const maskable = icons.filter((icon) => icon.purpose === "maskable");
    expect(maskable).toHaveLength(1);
    expect(maskable[0]?.sizes).toBe("512x512");
  });
});
