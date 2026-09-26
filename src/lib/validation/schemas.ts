import { z } from "zod";

export const providerIdSchema = z.string().trim().min(1).max(64);

export const idSchema = z.string().trim().min(1).max(256);

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const searchQuerySchema = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createPlaylistSchema = z.object({
  title: z.string().trim().min(1, "Playlist name is required").max(200),
  description: z.string().trim().max(500).optional(),
});

/**
 * Phase 47 custom playlist artwork.
 *
 * The repository has no object storage or upload pipeline, so artwork is a
 * URL field, not a file. What IS validated is everything that matters for
 * a field a client can write:
 *   - the scheme is http/https only. `javascript:`, `data:`, `blob:`,
 *     `file:` and protocol-relative `//host` are rejected, so a crafted
 *     value can never become a script or a local-file reference;
 *   - the URL must actually parse as a URL with a non-empty host;
 *   - the length is bounded, matching the artwork length already accepted
 *     in the queue snapshot schema.
 * Ownership is enforced separately, in the DAL (`requirePlaylistOwner`);
 * schema validation alone never authorizes a write.
 */
export const PLAYLIST_ARTWORK_MAX_LENGTH = 2048;

export const playlistArtworkSchema = z
  // `undefined` means "the client is not touching artwork" and must be
  // distinguishable from an explicit `null` ("clear it"). The previous
  // shape made artwork required, which broke every title-only edit.
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => (typeof value === "string" ? value.trim() : value))
  .refine(
    (value) =>
      value === undefined ||
      value === null ||
      (value.length > 0 && value.length <= PLAYLIST_ARTWORK_MAX_LENGTH),
    { message: "Artwork must be empty or a valid http(s) URL" },
  )
  .refine(
    (value) => {
      if (value === undefined || value === null || value.length === 0) {
        return true;
      }
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }
      return parsed.hostname.length > 0;
    },
    { message: "Artwork must be an http(s) URL" },
  );

export const updatePlaylistSchema = z.object({
  playlistId: idSchema,
  title: z.string().trim().min(1, "Playlist name is required").max(200).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  // Phase 47 custom artwork reuses the existing Playlist.artwork column.
  // `null` clears it back to the default artwork.
  artwork: playlistArtworkSchema,
});

/** Phase 47 sharing visibility. Two states, by design. */
export const playlistVisibilitySchema = z.enum(["private", "shared"]);

export const playlistVisibilityUpdateSchema = z.object({
  playlistId: idSchema,
  visibility: playlistVisibilitySchema,
});

/**
 * Phase 47 share-token shape. `mintShareToken` emits 24 random bytes as
 * base64url, which is always exactly 32 characters from the URL-safe
 * alphabet. Validating the shape at the public route rejects malformed
 * and hostile input before it ever reaches Prisma.
 */
export const SHARE_TOKEN_LENGTH = 32;

export const shareTokenSchema = z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9_-]{${SHARE_TOKEN_LENGTH}}$`));

export const deletePlaylistSchema = z.object({
  playlistId: idSchema,
});

export const addTrackSchema = z.object({
  playlistId: idSchema,
  // `streamUrl`, `previewUrl` and `metadata` are deliberately absent, so
  // zod strips them from the parsed payload before it can reach the DAL.
  // They are not needed (playback resolves a fresh AudioSource per load) and
  // accepting them let a client write a media URL into a shared, unowned
  // catalog row that every other user then reads. See `dal/catalog.ts`.
  // Ownership is still enforced separately, in the DAL
  // (`requirePlaylistOwner`); schema validation alone never authorizes.
  track: z.object({
    id: z.string(),
    provider: z.string(),
    title: z.string(),
    artistId: z.string(),
    artistName: z.string(),
    albumId: z.string().optional(),
    albumName: z.string().optional(),
    artworkUrl: z.string().optional(),
    duration: z.number().optional(),
    genres: z.array(z.string()).optional(),
    releaseDate: z.string().optional(),
    providerUrl: z.string().optional(),
    explicit: z.boolean().optional(),
  }),
});

export const removeTrackSchema = z.object({
  playlistId: idSchema,
  trackRef: z.object({
    provider: z.string(),
    providerTrackId: z.string(),
  }),
});

export const reorderPlaylistSchema = z.object({
  playlistId: idSchema,
  orderedRefs: z.array(
    z.object({
      provider: z.string(),
      providerTrackId: z.string(),
    }),
  ),
});

const queueSnapshotSourceSchema = z
  .object({ source: z.string().min(1).max(64), id: z.string().min(1).max(256) })
  .strict();

const queueSnapshotEntrySchema = z
  .object({
    provider: z.string().min(1).max(64),
    providerTrackId: z.string().min(1).max(256),
    title: z.string().min(1).max(512),
    artistId: z.string().min(1).max(256),
    artistName: z.string().min(1).max(512),
    albumId: z.string().min(1).max(256).optional(),
    albumName: z.string().min(1).max(512).optional(),
    artworkUrl: z.string().min(1).max(2048).optional(),
    duration: z.number().int().min(1).optional(),
    explicit: z.boolean().optional(),
    genres: z.array(z.string().min(1).max(128)).max(32).optional(),
    sources: z.array(queueSnapshotSourceSchema).max(8).optional(),
  })
  // Strict: playback-URL-shaped fields (streamUrl, previewUrl, url,
  // mimeType, ...) fail validation instead of being silently stripped.
  .strict();

/**
 * Wire shape of the versioned queue snapshot. Structural only —
 * semantic validation (version support, index bounds, URL-field
 * rejection, v1 → v2 migration) happens in validateQueueSnapshot on both
 * write (DAL) and read.
 *
 * Version 1 is accepted on the wire so a snapshot written by an older
 * build (or a tab that has not reloaded) still validates; the DAL
 * migrates it to the current version on write and on read.
 */
export const queueSnapshotSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    entries: z.array(queueSnapshotEntrySchema).max(200),
    playOrder: z.array(z.number().int().min(0)).max(200),
    position: z.number().int().min(-1),
    mediaPosition: z.number().int().min(0).max(86400),
    shuffle: z.boolean(),
    repeat: z.enum(["off", "all", "one"]),
    // Phase 43 player preferences; required at v2, absent at v1.
    volume: z.number().min(0).max(1).optional(),
    muted: z.boolean().optional(),
    savedAt: z.number().int().min(0).optional(),
  })
  .strict();

export const playbackStateSaveSchema = z.object({
  provider: providerIdSchema,
  providerTrackId: z.string().trim().min(1).max(256),
  position: z.coerce.number().int().min(0).max(86400),
  revision: z.coerce.number().int().min(0),
  queueSnapshot: queueSnapshotSchema.optional(),
});

export const playbackStateSnapshotSchema = z.object({
  provider: providerIdSchema,
  providerTrackId: z.string().trim().min(1).max(256),
  position: z.coerce.number().int().min(0).max(86400),
  revision: z.coerce.number().int().min(0),
});
