/**
 * Read-only test-database queries for authenticated E2E specs
 * (Phase 30). Runs under `tsx`. Usage:
 *
 *   tsx e2e/auth/read.mts titles <playlistId>
 *   tsx e2e/auth/read.mts liked <email> <providerTrackId>
 *   tsx e2e/auth/read.mts owner <playlistId>
 *   tsx e2e/auth/read.mts followed <email>
 *   tsx e2e/auth/read.mts queuejson <email>
 *
 * Prints a single JSON line. Never mutates.
 */
import { closeTestClient, getPlaylistTrackTitles, getQueueSnapshotRaw, getTestClient, isArtistFollowedByEmail, isTrackLikedByEmail } from "./db";

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "titles") {
    console.log(JSON.stringify(await getPlaylistTrackTitles(args[0])));
  } else if (command === "liked") {
    console.log(JSON.stringify(await isTrackLikedByEmail(args[0], args[1])));
  } else if (command === "followed") {
    console.log(JSON.stringify(await isArtistFollowedByEmail(args[0])));
  } else if (command === "queuejson") {
    console.log(JSON.stringify(await getQueueSnapshotRaw(args[0])));
  } else if (command === "owner") {
    const prisma = getTestClient();
    const playlist = await prisma.playlist.findUnique({
      where: { id: args[0] },
      include: { user: { select: { id: true, email: true } } },
    });
    console.log(
      JSON.stringify(
        playlist
          ? { userId: playlist.user.id, email: playlist.user.email }
          : null,
      ),
    );
  } else {
    throw new Error(`Unknown read command: ${command}`);
  }
  await closeTestClient();
} catch (error) {
  await closeTestClient().catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
