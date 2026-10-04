/**
 * Provider-scoped deep-link ids — a PURE string helper, deliberately free of
 * any registry, environment or provider import.
 *
 * WHY THIS IS ITS OWN MODULE. `providers/server.ts` imports the env gate and the
 * provider registry, so it is server-only. `AlbumCard`, `ArtistCard` and
 * `TrackRow` are client components and need to build these ids, and importing
 * the registry from them fails `client-boundary.test.ts` — correctly, because it
 * would drag the whole provider layer into the browser bundle. The format is two
 * strings and a colon; it has no business knowing about providers.
 *
 * WHY THE FORMAT EXISTS AT ALL. A `providerAlbumId`/`providerTrackId`/
 * `providerArtistId` is only meaningful to the provider that issued it, so a URL
 * carrying just the bare id leaves the route guessing which provider to ask.
 * It used to guess the PREFERRED provider, which meant `/album/[id]` 404'd for
 * every album that did not come from that one provider. The id now names its
 * own provider, and the server resolves against it.
 *
 * The separator is the FIRST colon only, because provider ids are short and
 * constrained while the resource id after it is opaque and may contain colons.
 */

/** Splits `spotify:4uLU6` into its parts, or `null` for a bare id. */
export function parseProviderScopedId(
  raw: string,
): { providerId: string; id: string } | null {
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    return null;
  }
  return { providerId: raw.slice(0, separator), id: raw.slice(separator + 1) };
}

/**
 * Builds the provider-scoped id a deep link carries.
 *
 * Both halves are percent-encoded, but the SEPARATOR is left literal so the
 * URL stays readable (`/album/deezer:ext-al-99` rather than
 * `/album/deezer%3Aext-al-99`). That is safe because the separator is written
 * here rather than produced by `encodeURIComponent`, so a resource id that
 * itself contains a colon is encoded to `%3A` and can never be mistaken for the
 * boundary. The routes call `decodeURIComponent` on the segment before parsing,
 * so a provider or id containing `/`, `?` or `#` still survives the round trip.
 */
export function providerScopedId(providerId: string, id: string): string {
  return `${encodeURIComponent(providerId)}:${encodeURIComponent(id)}`;
}