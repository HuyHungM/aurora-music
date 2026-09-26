import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import manifest from "@/app/manifest";
import {
  APP_APPLE_TOUCH_ICON,
  APP_CATEGORIES,
  APP_DISPLAY,
  APP_DISPLAY_OVERRIDE,
  APP_ICONS,
  APP_ID,
  APP_MANIFEST_DIR,
  APP_MANIFEST_LOCALE,
  APP_NAME,
  APP_ORIENTATION,
  APP_SCOPE,
  APP_SHORT_NAME,
  APP_START_URL,
  APP_SUPPORTED_LOCALES,
  APP_THEME_COLOR,
  appDescription,
} from "@/lib/app-metadata";
import { DEFAULT_LOCALE } from "@/lib/i18n/locale";

const rootDir = resolve(process.cwd());
const publicDir = resolve(rootDir, "public");

/**
 * Minimal PNG IHDR reader: signature + width/height, nothing else. RULE 66 is
 * explicit that dimensions must be measured, never inferred from a filename.
 */
function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) {
      throw new Error(`${path} is not a PNG file`);
    }
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Every application route the manifest is allowed to point at. */
function routeExists(url: string): boolean {
  if (url === "/") {
    return existsSync(resolve(rootDir, "src/app/(app)/page.tsx"));
  }
  const [first] = url.slice(1).split("/");
  if (["[", "..."].some((token) => first.startsWith(token))) {
    return existsSync(
      resolve(rootDir, "src/app/(app)", first, "page.tsx"),
    );
  }
  return existsSync(resolve(rootDir, "src/app/(app)", first, "page.tsx"));
}

describe("web app manifest", () => {
  const built = manifest();

  it("carries the Aurora product identity", () => {
    expect(built.name).toBe(APP_NAME);
    expect(built.name).toBe("Aurora Music");
    expect(built.short_name).toBe(APP_SHORT_NAME);
    expect(built.short_name).toBe("Aurora");
    expect(built.description).toBe(appDescription(APP_MANIFEST_LOCALE));
    expect((built.description ?? "").length).toBeGreaterThan(0);
  });

  it("uses a safe start URL, scope and stable identifier", () => {
    expect(built.start_url).toBe("/");
    expect(built.scope).toBe("/");
    // RULE 16: the id must be a stable identity, never a build hash, and it
    // must stay inside the scope so the launcher and the app agree.
    expect(built.id).toBe(APP_ID);
    expect(built.id).toBe("/");
    expect(built.start_url).toBe(APP_START_URL);
    expect(built.scope).toBe(APP_SCOPE);
    // No query, hash, or provider state can leak into a cold start.
    expect(built.start_url).not.toMatch(/[?#]/);
  });

  it("degrades gracefully through the display override chain", () => {
    expect(built.display).toBe(APP_DISPLAY);
    expect(built.display).toBe("standalone");
    expect(built.display_override).toEqual([...APP_DISPLAY_OVERRIDE]);
    // RULE 19: the chain must end somewhere every browser understands.
    expect(built.display_override).toContain("browser");
    expect(built.display_override?.[0]).toBe(built.display);
  });

  it("does not lock orientation", () => {
    // RULE 21: Aurora is responsive, so any orientation lock would be an
    // artificial product restriction.
    expect(built.orientation).toBe(APP_ORIENTATION);
    expect(built.orientation).toBe("any");
  });

  it("declares the canvas for browser chrome and the splash screen", () => {
    expect(built.theme_color).toBe(APP_THEME_COLOR);
    expect(built.background_color).toBe(APP_THEME_COLOR);
    // RULE 22: a real CSS colour, not a token expression. `theme_color` is
    // read by the OS and by browser chrome, where `oklch()` support is not
    // universal, so the hex form is required here.
    expect(built.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("advertises language and direction for the shipped default", () => {
    expect(built.lang).toBe(APP_MANIFEST_LOCALE);
    expect(built.lang).toBe(DEFAULT_LOCALE);
    expect(built.dir).toBe(APP_MANIFEST_DIR);
    expect(APP_SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });

  it("declares only truthful categories", () => {
    expect(built.categories).toEqual([...APP_CATEGORIES]);
    expect(built.categories).toContain("music");
  });

  it("ships a complete icon set with real, measured dimensions", () => {
    expect(built.icons).toEqual(APP_ICONS.map((icon) => ({ ...icon })));
    const sizes = new Set(built.icons?.map((icon) => icon.sizes));
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");

    for (const icon of built.icons ?? []) {
      expect(icon.type).toBe("image/png");
      expect(icon.sizes, `${icon.src} declares its size`).toBeTruthy();
      const path = resolve(publicDir, icon.src.replace(/^\//, ""));
      expect(existsSync(path), `${icon.src} exists`).toBe(true);
      const [width, height] = (icon.sizes as string)
        .split("x")
        .map(Number);
      const actual = pngDimensions(path);
      expect(actual, `${icon.src} matches its declared size`).toEqual({
        width,
        height,
      });
    }
  });

  it("ships a genuinely maskable icon, not a reused edge-to-edge asset", () => {
    const maskable = (built.icons ?? []).filter(
      (icon) => icon.purpose === "maskable",
    );
    expect(maskable).toHaveLength(1);
    const any = (built.icons ?? []).filter((icon) => icon.purpose === "any");
    expect(any.length).toBeGreaterThan(0);
    // RULE 24: a maskable icon is a different asset, not the plain one
    // relabelled. Distinct source file proves it was rendered for the mask.
    expect(maskable[0].src).not.toBe(any[0].src);
  });

  it("points every shortcut at a route that actually exists", () => {
    expect(built.shortcuts).toBeDefined();
    for (const shortcut of built.shortcuts ?? []) {
      expect(shortcut.name).toBeTruthy();
      expect(shortcut.url.startsWith("/")).toBe(true);
      expect(
        routeExists(shortcut.url),
        `${shortcut.url} is a real route`,
      ).toBe(true);
    }
    // RULE 45: no shortcut to a route Aurora does not have. There is no
    // /settings route, so there must be no settings shortcut.
    const urls = (built.shortcuts ?? []).map((shortcut) => shortcut.url);
    expect(urls).not.toContain("/settings");
  });

  it("labels shortcuts in the language the manifest declares", () => {
    // RULE 47: the manifest advertises `lang: vi`, so a launcher must not be
    // handed English labels next to a Vietnamese description.
    expect(built.lang).toBe("vi");
    // "Radio" is the same word in both languages, so it carries no signal
    // either way; the other two must be the Vietnamese strings.
    const untranslatedEnglish = new Set(["Search", "Library"]);
    for (const shortcut of built.shortcuts ?? []) {
      expect(untranslatedEnglish.has(shortcut.name)).toBe(false);
    }
    const names = (built.shortcuts ?? []).map((shortcut) => shortcut.name);
    expect(names).toContain("Tìm kiếm");
    expect(names).toContain("Thư viện");
    expect(names).toContain("Radio");
  });

  it("keeps the apple touch icon inside the reviewed asset set", () => {
    expect(APP_APPLE_TOUCH_ICON).toBe("/icons/icon-192.png");
    expect(existsSync(resolve(publicDir, APP_APPLE_TOUCH_ICON.replace(/^\//, "")))).toBe(
      true,
    );
  });

  it("does not re-add a static manifest file to public/", () => {
    // RULE 11 / RULE 81: exactly ONE manifest source. The framework-native
    // route owns it; a file in public/ would be a silent second definition.
    expect(existsSync(resolve(publicDir, "manifest.webmanifest"))).toBe(false);
  });
});
