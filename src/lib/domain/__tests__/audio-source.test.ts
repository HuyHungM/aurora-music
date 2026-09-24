import { describe, expect, it } from "vitest";
import {
  isAudioSourceExpired,
  parseAudioSource,
  serializeAudioSource,
} from "@/lib/domain/audio-source";
import type { AudioSource } from "@/lib/domain/audio-source";

describe("AudioSource", () => {
  it("treats a source without expiry as non-expired", () => {
    const source: AudioSource = { url: "https://stream.example/t.mp3" };
    expect(isAudioSourceExpired(source, Date.now())).toBe(false);
  });

  it("detects expired sources at and past expiry", () => {
    const now = Date.now();
    const expired: AudioSource = {
      url: "https://stream.example/old.mp3",
      expiresAt: new Date(now - 1_000),
    };
    const fresh: AudioSource = {
      url: "https://stream.example/new.mp3",
      expiresAt: new Date(now + 60_000),
    };
    expect(isAudioSourceExpired(expired, now)).toBe(true);
    expect(isAudioSourceExpired(fresh, now)).toBe(false);
  });

  it("serializes to a JSON-safe payload with ISO expiry", () => {
    const source: AudioSource = {
      url: "https://stream.example/t.mp3",
      mimeType: "audio/mpeg",
      durationMs: 213_000,
      expiresAt: new Date("2026-09-21T00:00:00.000Z"),
      bitrate: 128_000,
    };
    const serialized = serializeAudioSource(source);
    expect(serialized).toEqual({
      url: "https://stream.example/t.mp3",
      mimeType: "audio/mpeg",
      durationMs: 213_000,
      expiresAt: "2026-09-21T00:00:00.000Z",
      bitrate: 128_000,
    });
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });

  it("rejects malformed payloads instead of throwing", () => {
    expect(parseAudioSource(null)).toBeNull();
    expect(parseAudioSource({})).toBeNull();
    expect(parseAudioSource({ url: "" })).toBeNull();
    expect(parseAudioSource({ url: 42 })).toBeNull();
  });

  it("parses valid payloads and drops invalid expiry", () => {
    const parsed = parseAudioSource({
      url: "https://stream.example/t.mp3",
      durationMs: 200_500.9,
      expiresAt: "not-a-date",
    });
    expect(parsed).toMatchObject({
      url: "https://stream.example/t.mp3",
      durationMs: 200_500,
    });
    expect(parsed?.expiresAt).toBeUndefined();
  });

  it("round-trips through serialization", () => {
    const source: AudioSource = {
      url: "https://stream.example/t.mp3",
      expiresAt: new Date("2026-09-21T00:00:00.000Z"),
    };
    const roundTripped = parseAudioSource(JSON.parse(JSON.stringify(serializeAudioSource(source))));
    expect(roundTripped?.url).toBe(source.url);
    expect(roundTripped?.expiresAt?.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });
});
