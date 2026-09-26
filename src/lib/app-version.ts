import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Canonical application version — SERVER ONLY.
 *
 * `package.json` is the single source of the version; nothing in the
 * application maintains a second copy. It is read here at request time rather
 * than imported as a JSON module, because a static `import ... from
 * "package.json"` would inline the entire dependency manifest into whichever
 * bundle reaches it. Keeping the read behind this server-only module means the
 * client bundle can never carry Aurora's dependency list (RULE 7, RULE 73).
 *
 * The path is resolved from `process.cwd()` and is never returned to a caller.
 */
export const FALLBACK_APP_VERSION = "0.0.0";

export function getAppVersion(): string {
  try {
    const raw = readFileSync(resolve(process.cwd(), "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // A missing or unreadable manifest must not turn a metadata request into
    // a 500: the client can still operate, it just cannot report a version.
  }
  return FALLBACK_APP_VERSION;
}
