/**
 * The anonymous EQ cookie (Phase 53 addendum).
 *
 * A COOKIE, for the same written-down reason the appearance cookie is one: the
 * client-side storage gate in `src/quality-gates.test.ts` fails the build on
 * browser storage APIs in any production source file, and two anonymous
 * preferences already follow this pattern - `LOCALE_COOKIE` in `i18n/locale.ts`
 * and `INSTALL_DISMISS_COOKIE` in `pwa/install.ts`. This introduces no new kind
 * of storage. (Those API names are deliberately not spelled out here: the gate
 * greps for the literals, so a file that merely explains the rule would be
 * caught by it.)
 *
 * THE VALUE IS THE COMPACT ENCODING, and this module deliberately does not
 * know how to produce one. Ten band gains spelled out would be roughly 150
 * bytes travelling with every same-origin request; a visitor who has not opened
 * the equalizer is worth `{"v":1}` - eleven bytes. `encodeEQ` in `./eq` is the
 * single authority for what travels, and both sinks that write this cookie
 * (the client root, for a signed-out visitor, and the server action) call it.
 * A second serialiser here would be a second answer to "what does a preference
 * look like on the wire", which is the exact thing §39 asks to avoid.
 *
 * `HttpOnly` is deliberately NOT set. This is a listening preference, not a
 * credential, and the document has to be able to write it synchronously the
 * moment somebody releases a slider - see `EQPersistenceRoot`, where the
 * debounced server write is the thing that can afford to wait but this cannot.
 * `SameSite=Lax` and the `path` match the locale cookie's, and `Secure` is left
 * to the deployment: the app is developed and smoke-tested over plain HTTP on
 * loopback, and a `Secure` cookie set there is silently dropped, which looks
 * exactly like a persistence bug.
 */

export const EQ_COOKIE = "aurora-eq";

/** One year, matching `LOCALE_COOKIE`: a listening preference does not decay. */
export const EQ_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
