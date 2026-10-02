/**
 * Local-file <-> domain Track mapping. CLIENT-ONLY, and pure: it reads no file
 * and opens no media element.
 *
 * WHAT IS DELIBERATELY NOT HERE. No tag reader, and no duration probe. ID3 /
 * Vorbis / FLAC parsing is a real chunk of work, and the difference matters to
 * the user: a file tagged "04 - Artist - Title.mp3" shows the filename, not
 * the tag. Filename heuristics are therefore stated as heuristics, and the UI
 * shows the raw file name so nothing is silently misattributed.
 *
 * Durations are NOT computed here either. A duration probe needs a media
 * element per file, which for a large folder means thousands of them; and it
 * would be redundant anyway, because the audio element reports the real
 * duration the moment a track loads. Reading it up front would be cost with no
 * extra truth.
 */

import type { Track } from "@/lib/domain";

/** Extensions treated as audio. Checked case-insensitively. */
const AUDIO_EXTENSIONS: readonly string[] = [
  "mp3",
  "m4a",
  "m4b",
  "aac",
  "flac",
  "wav",
  "ogg",
  "oga",
  "opus",
  "webm",
  "aiff",
  "aif",
  "wma",
];

/** MIME types accepted when an extension is absent or wrong. */
const AUDIO_MIME_PREFIX = "audio/";

/**
 * Shown in the artist slot when a file genuinely carries no artist signal.
 *
 * AN EM DASH (U+2014), and it is load-bearing that it is one. This constant
 * previously held three characters, U+00E2 U+20AC U+201D, which is the exact
 * signature of one encoding pass too many: an em dash is U+2014, its UTF-8 is
 * the three bytes `E2 80 94`, and decoding those as windows-1252 yields
 * U+00E2, U+20AC and U+201D. The file's own bytes were valid UTF-8 throughout,
 * so nothing was wrong in transit - the mojibake had been written into the
 * source by a tool that round-tripped the text through a single-byte encoding.
 * The symptom was a local file with no artist tag rendering three garbage
 * glyphs where a dash should be.
 *
 * The corrupted sequence is deliberately NOT reproduced here. Writing it out
 * even inside a comment is how the next reader "fixes" it with a blind search
 * and replace, which would leave the encoding bug itself untouched.
 */
export const UNKNOWN_ARTIST = "—";

/** Artist id for every local track; local files have no provider artist. */
export const LOCAL_ARTIST_ID = "local";

export function audioExtensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * True when a file should appear in the offline list.
 *
 * Extension first, because a File obtained from the File System Access API
 * often has an empty `type` (the OS does not always report one for uncommon
 * codecs), and an extension is always present. MIME is the fallback so a file
 * with no extension is still playable when the platform can tell us it is
 * audio.
 */
export function isAudioFile(name: string, mimeType?: string): boolean {
  const extension = audioExtensionOf(name);
  if (extension !== "" && AUDIO_EXTENSIONS.includes(extension)) {
    return true;
  }
  const mime = typeof mimeType === "string" ? mimeType.toLowerCase() : "";
  return mime !== "" && mime.startsWith(AUDIO_MIME_PREFIX);
}

/** Strips a trailing audio extension, leaving any interior dots alone. */
export function stripAudioExtension(name: string): string {
  const extension = audioExtensionOf(name);
  if (extension === "" || !AUDIO_EXTENSIONS.includes(extension)) {
    return name;
  }
  return name.slice(0, name.length - extension.length - 1);
}

/**
 * Splits `"Artist - Title.mp3"` into its parts.
 *
 * Split on the FIRST separator only: `"A - B - C.mp3"` is an artist `A` and
 * a title `B - C`, which is the convention every tagger follows, and taking
 * the last part instead silently renames the track. Bracketed leading
 * track numbers are stripped because they are never part of a title.
 */
export function parseFileName(fileName: string): { title: string; artist?: string } {
  const withoutExtension = stripAudioExtension(fileName).trim();
  const withoutTrackNumber = withoutExtension.replace(/^\s*\[\d{1,3}\]\s*/, "").trim();
  const base = withoutTrackNumber === "" ? withoutExtension : withoutTrackNumber;

  const separator = base.indexOf(" - ");
  if (separator > 0 && separator + 3 < base.length) {
    const artist = base.slice(0, separator).trim();
    const title = base.slice(separator + 3).trim();
    if (artist !== "" && title !== "") {
      return { title, artist };
    }
  }
  return { title: base === "" ? fileName : base };
}

export interface LocalTrackInput {
  /** Stable id: the file's path relative to the granted folder. */
  id: string;
  /** Containing folder name relative to the granted folder, when nested. */
  folder: string | null;
  name: string;
}

/**
 * Builds the domain Track a local file plays as.
 *
 * `artistName` is the parsed artist, else the containing folder (music
 * libraries are usually `Artist/Album/track`), else {@link UNKNOWN_ARTIST}.
 * It is never a translated string: this is catalog data that participates in
 * dedupe keys, and a value that changed with the UI locale would make the
 * same file dedupe differently in Vietnamese and English.
 */
export function localTrack(input: LocalTrackInput): Track {
  const parsed = parseFileName(input.name);
  const folderName = input.folder?.trim() ?? "";
  const artistName = parsed.artist ?? (folderName !== "" ? folderName : UNKNOWN_ARTIST);
  return {
    id: input.id,
    provider: "local",
    providerTrackId: input.id,
    title: parsed.title,
    artistId: LOCAL_ARTIST_ID,
    artistName,
  };
}