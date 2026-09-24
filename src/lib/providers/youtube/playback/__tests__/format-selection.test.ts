import { describe, expect, it } from "vitest";
import {
  rankAudioFormats,
  selectAudioFormat,
} from "@/lib/providers/youtube/playback/format-selection";
import type { PlaybackFormatCandidate } from "@/lib/providers/youtube/playback/types";

function audio(
  url: string,
  overrides: Partial<PlaybackFormatCandidate> = {},
): PlaybackFormatCandidate {
  return { url, hasAudio: true, hasVideo: false, ...overrides };
}

describe("selectAudioFormat", () => {
  it("prefers audio-only over video-carrying formats", () => {
    const video = audio("https://cdn.example/v", {
      hasVideo: true,
      mimeType: "video/mp4",
      bitrate: 5_000_000,
    });
    const audioOnly = audio("https://cdn.example/a", { mimeType: "audio/webm" });
    expect(selectAudioFormat([video, audioOnly])).toBe(audioOnly);
  });

  it("never selects video-only or url-less formats", () => {
    expect(
      selectAudioFormat([
        { url: "https://cdn.example/v", hasAudio: false, hasVideo: true },
      ]),
    ).toBeNull();
    expect(
      selectAudioFormat([{ url: "", hasAudio: true, hasVideo: false }]),
    ).toBeNull();
    expect(selectAudioFormat([])).toBeNull();
  });

  it("prefers mp4 over webm for browser compatibility", () => {
    const webm = audio("https://cdn.example/a.webm", {
      mimeType: 'audio/webm; codecs="opus"',
      bitrate: 160_000,
    });
    const mp4 = audio("https://cdn.example/a.m4a", {
      mimeType: 'audio/mp4; codecs="mp4a.40.2"',
      bitrate: 128_000,
    });
    expect(selectAudioFormat([webm, mp4])).toBe(mp4);
  });

  it("prefers higher bitrate within the same container", () => {
    const low = audio("https://cdn.example/low", { mimeType: "audio/mp4", bitrate: 48_000 });
    const high = audio("https://cdn.example/high", { mimeType: "audio/mp4", bitrate: 128_000 });
    expect(selectAudioFormat([low, high])).toBe(high);
  });

  it("sorts missing bitrate last without estimating", () => {
    const unknown = audio("https://cdn.example/u", { mimeType: "audio/mp4" });
    const known = audio("https://cdn.example/k", { mimeType: "audio/mp4", bitrate: 1 });
    expect(selectAudioFormat([unknown, known])).toBe(known);
  });

  it("breaks remaining ties deterministically, ignoring input order", () => {
    const a = audio("https://cdn.example/b", { mimeType: "audio/mp4", bitrate: 128_000 });
    const b = audio("https://cdn.example/a", { mimeType: "audio/mp4", bitrate: 128_000 });
    expect(selectAudioFormat([a, b])).toBe(b);
    expect(selectAudioFormat([b, a])).toBe(b);
  });

  it("ranks unknown mime types below known audio types", () => {
    const unknown = audio("https://cdn.example/u", { bitrate: 256_000 });
    const webm = audio("https://cdn.example/w", { mimeType: "audio/webm", bitrate: 48_000 });
    expect(selectAudioFormat([unknown, webm])).toBe(webm);
  });

  it("falls back to muxed audio+video only when no audio-only url exists", () => {
    // Phase 17 runtime finding: YouTube may withhold audio-only URLs while
    // serving a ciphered muxed stream. HTMLAudioElement extracts the audio
    // track, so muxed is a last resort — never preferred over audio-only.
    const muxed = audio("https://cdn.example/m", {
      hasVideo: true,
      mimeType: "video/mp4",
      bitrate: 5_000_000,
    });
    expect(selectAudioFormat([muxed])).toBe(muxed);
    const opus = audio("https://cdn.example/o", { mimeType: "audio/webm" });
    expect(selectAudioFormat([muxed, opus])).toBe(opus);
  });

  it("prefers muxed mp4 over muxed webm within the fallback tier", () => {
    const webm = audio("https://cdn.example/w", {
      hasVideo: true,
      mimeType: "video/webm",
    });
    const mp4 = audio("https://cdn.example/m", {
      hasVideo: true,
      mimeType: "video/mp4",
    });
    expect(selectAudioFormat([webm, mp4])).toBe(mp4);
  });
});

describe("rankAudioFormats", () => {
  it("returns the full ranking best-first with the same policy", () => {
    const muxed = audio("https://cdn.example/m", {
      hasVideo: true,
      mimeType: "video/mp4",
      bitrate: 5_000_000,
    });
    const webm = audio("https://cdn.example/w", {
      mimeType: 'audio/webm; codecs="opus"',
      bitrate: 160_000,
    });
    const mp4 = audio("https://cdn.example/a", {
      mimeType: 'audio/mp4; codecs="mp4a.40.2"',
      bitrate: 128_000,
    });
    expect(rankAudioFormats([muxed, webm, mp4])).toEqual([mp4, webm, muxed]);
    expect(rankAudioFormats([muxed, webm, mp4])[0]).toBe(
      selectAudioFormat([muxed, webm, mp4]),
    );
  });

  it("excludes url-less and video-only formats from the ranking", () => {
    expect(
      rankAudioFormats([
        { url: "", hasAudio: true, hasVideo: false },
        { url: "https://cdn.example/v", hasAudio: false, hasVideo: true },
      ]),
    ).toEqual([]);
  });
});
