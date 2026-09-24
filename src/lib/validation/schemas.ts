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

export const updatePlaylistSchema = z.object({
  playlistId: idSchema,
  title: z.string().trim().min(1, "Playlist name is required").max(200).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

export const deletePlaylistSchema = z.object({
  playlistId: idSchema,
});

export const addTrackSchema = z.object({
  playlistId: idSchema,
  track: z.object({
    id: z.string(),
    provider: z.string(),
    title: z.string(),
    artistId: z.string(),
    artistName: z.string(),
    albumId: z.string().optional(),
    albumName: z.string().optional(),
    artworkUrl: z.string().optional(),
    streamUrl: z.string().optional(),
    previewUrl: z.string().optional(),
    duration: z.number().optional(),
    genres: z.array(z.string()).optional(),
    releaseDate: z.string().optional(),
    providerUrl: z.string().optional(),
    explicit: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
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

export const playbackStateSaveSchema = z.object({
  provider: providerIdSchema,
  providerTrackId: z.string().trim().min(1).max(256),
  position: z.coerce.number().int().min(0).max(86400),
  revision: z.coerce.number().int().min(0),
});

export const playbackStateSnapshotSchema = z.object({
  provider: providerIdSchema,
  providerTrackId: z.string().trim().min(1).max(256),
  position: z.coerce.number().int().min(0).max(86400),
  revision: z.coerce.number().int().min(0),
});
