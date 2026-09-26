"use client";

import { toUserFacingError } from "@/lib/errors/user-error";
import { LOCALE_COOKIE, resolveLocale } from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/translate";

/**
 * Fatal root failure UI (Phase 21). Rendered by Next.js when the root
 * layout itself cannot render, so it must be fully self-contained: own
 * html/body, inline critical styles (no globals.css), no router, no
 * providers. Offers reload (fresh boot) and in-place reset; shows no
 * technical details.
 *
 * Phase 42: still translated. With no provider tree alive, the locale
 * comes straight from the anonymous-preference cookie (Vietnamese when
 * absent) and every string resolves through the shared dictionaries.
 */
function readCookieLocale(): ReturnType<typeof resolveLocale> {
  try {
    const match = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${LOCALE_COOKIE}=`));
    return resolveLocale(match?.slice(LOCALE_COOKIE.length + 1));
  } catch {
    return resolveLocale(undefined);
  }
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = readCookieLocale();
  const t = getT(locale);
  const mapped = toUserFacingError(error, undefined, locale);
  return (
    <html lang={locale}>
      <body style={{ margin: 0, background: "#08070d", color: "#f4f2ff" }}>
        <style>{`body{font-family:system-ui,sans-serif}button{cursor:pointer}`}</style>
        <div
          role="alert"
          style={{
            display: "flex",
            minHeight: "100vh",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1rem",
            padding: "1.5rem",
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "1.5rem", margin: 0 }}>Aurora Music</h1>
          <p style={{ color: "#8b86a0", maxWidth: "24rem" }}>
            {t("errors.description")} {mapped.message}
          </p>
          <p style={{ color: "#5c5a70", fontSize: "0.75rem" }}>
            {t("errors.errorCode", { code: mapped.code })}
          </p>
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                background: "#8b5cf6",
                color: "#f4f2ff",
                border: "none",
                borderRadius: "9999px",
                padding: "0.625rem 1.25rem",
                fontSize: "0.875rem",
                fontWeight: 600,
              }}
            >
              {t("errors.tryAgain")}
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                background: "transparent",
                color: "#f4f2ff",
                border: "1px solid #3a3550",
                borderRadius: "9999px",
                padding: "0.625rem 1.25rem",
                fontSize: "0.875rem",
                fontWeight: 600,
              }}
            >
              {t("errors.reloadApp")}
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
