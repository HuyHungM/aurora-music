import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSharedPlaylistByToken, getSharedPlaylistTracks } from "@/lib/dal/playlist";
import { shareTokenSchema } from "@/lib/validation";
import { SharedPlaylistView } from "@/components/playlist/shared-playlist-view";
import { getRequestLocale } from "@/lib/i18n/server";
import { getT } from "@/lib/i18n/translate";

/**
 * Phase 47 public shared-playlist route.
 *
 * The URL segment is an opaque share token and nothing else — no playlist
 * id, no owner id, no provider id. Access is decided by the DAL query,
 * which requires BOTH a matching token and `visibility = "shared"`, so:
 *
 *   - a private playlist is unreachable by guessing a database id, because
 *     this route never accepts one;
 *   - a revoked playlist is unreachable by keeping the old link, because
 *     revoking nulls the token;
 *   - a malformed or forged token is rejected by shape before any query.
 *
 * No session is required. The returned `SharedPlaylist` type has no
 * `ownerId` and no `shareToken`, so the owner cannot be identified and the
 * token cannot be re-shared by scraping this page.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const locale = await getRequestLocale();
  const t = getT(locale);
  const parsed = shareTokenSchema.safeParse(token);
  if (!parsed.success) {
    return { title: t("sharedPlaylist.notFoundTitle"), robots: { index: false } };
  }
  const shared = await getSharedPlaylistByToken(parsed.data).catch(() => null);
  if (!shared) {
    // The same 404 metadata a private playlist gets: a probe must not be
    // able to distinguish "wrong token" from "private playlist".
    return { title: t("sharedPlaylist.notFoundTitle"), robots: { index: false } };
  }
  const description =
    shared.description ??
    t("sharedPlaylist.byAuthor", { name: shared.ownerDisplayName });
  return {
    title: shared.title,
    description,
    openGraph: {
      title: shared.title,
      description,
      ...(shared.artwork ? { images: [{ url: shared.artwork }] } : {}),
    },
    // Only a resolvable shared playlist is indexable.
    robots: { index: true, follow: true },
  };
}

export default async function SharedPlaylistPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const locale = await getRequestLocale();
  const parsed = shareTokenSchema.safeParse(token);
  if (!parsed.success) {
    notFound();
  }
  // A revoked or private playlist resolves to null here and 404s, exactly
  // like a wrong token. No distinction is exposed to the caller.
  const [shared, tracks] = await Promise.all([
    getSharedPlaylistByToken(parsed.data),
    getSharedPlaylistTracks(parsed.data),
  ]);
  if (!shared) {
    notFound();
  }
  return <SharedPlaylistView playlist={shared} tracks={tracks} locale={locale} />;
}
