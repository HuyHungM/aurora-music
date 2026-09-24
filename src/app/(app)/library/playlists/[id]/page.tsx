import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/dal/session";
import { getPlaylistDetail } from "@/lib/dal/library";
import { PlaylistDetailClient } from "@/components/playlist/playlist-detail-client";

export const metadata: Metadata = { title: "Playlist" };

export default async function PlaylistPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  const { id } = await params;

  if (!user) {
    notFound();
  }

  const detail = await getPlaylistDetail(user.id, id);

  if (!detail) {
    notFound();
  }

  const { playlist, tracks } = detail;
  const isOwner = playlist.ownerId === user.id;

  return (
    <PlaylistDetailClient
      playlist={playlist}
      tracks={tracks}
      isOwner={isOwner}
    />
  );
}
