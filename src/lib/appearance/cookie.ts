/**
 * The anonymous appearance cookie (Phase 53).
 *
 * A COOKIE, and the reason is written down rather than assumed: a client-side
 * storage gate in `src/quality-gates.test.ts` fails the build on browser
 * storage APIs in any production source file, and two existing anonymous
 * preferences already follow this exact pattern - `LOCALE_COOKIE` in
 * `i18n/locale.ts` and `INSTALL_DISMISS_COOKIE` in `pwa/install.ts`, both of
 * which say so in their own docstrings. This is the third, and it introduces
 * no new kind of storage. (Those API names are deliberately not spelled out
 * here: the gate greps for the literals, so a file that merely explains the
 * rule would be caught by it.)
 *
 * The cost of a cookie is that it travels with every same-origin request, so
 * the value is deliberately the *compact* encoding rather than the resolved
 * object: `encodeAppearance` omits every field equal to the default, which
 * makes a visitor who accepted the shipped preset worth `{"v":1}` - about
 * twelve bytes. See `appearance.ts` for why the format is shaped that way.
 *
 * `HttpOnly` is deliberately NOT set. The cookie is not a credential: it
 * holds a visual preference, it is written by a server action, and marking it
 * `HttpOnly` would buy nothing while preventing the document from ever
 * reading it back. `SameSite=Lax` and the `path` are the same as the locale
 * cookie's, and `Secure` is left to the deployment - the app is developed and
 * smoke-tested over plain HTTP on loopback, and a `Secure` cookie set there
 * is silently dropped by the browser, which is the kind of failure that looks
 * like a persistence bug.
 */

export const APPEARANCE_COOKIE = "aurora-appearance";

/** One year, matching `LOCALE_COOKIE`: a visual preference does not decay. */
export const APPEARANCE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
