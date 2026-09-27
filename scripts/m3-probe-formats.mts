/**
 * Mission-3 investigation probe (read-only, deleted after use).
 *
 * Question: the live suite now rejects 7/7 YouTube candidates with
 * `probe_status_403`. ARCHITECTURE.md §7 documents that the adaptive (DASH)
 * ladder refuses whole-body reads with 403 while the progressive (muxed)
 * format of the same video is unaffected. If ALL 7 candidates are rejected
 * now, that documented split no longer holds and playback is dead product-wide
 * - a provider behaviour change, not a code change.
 *
 * Prints, per candidate: itag, mime, audioQuality, whether the format is
 * adaptive or muxed, and the status for BOTH request shapes (open-ended range
 * = what a browser sends first, and a bounded range = proof the URL is alive).
 */
import { createInnertubePlaybackClient } from "../src/lib/providers/youtube/playback/innertube-client";

const VIDEO_IDS = ["dQw4w9WgXcQ", "kJQP7kiw5Fk", "XetvJxkbfYU"];

const client = createInnertubePlaybackClient();

async function probe(url: string, range: string): Promise<number | string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: { Range: range },
      redirect: "manual",
      signal: controller.signal,
    });
    try {
      await response.body?.cancel();
    } catch {
      // status only
    }
    return response.status;
  } catch (error) {
    return `ERR ${(error as { name?: string }).name ?? "unknown"}`;
  } finally {
    clearTimeout(timer);
  }
}

for (const videoId of VIDEO_IDS) {
  let media;
  try {
    media = await client.getMediaInfo(videoId);
  } catch (error) {
    console.log(`${videoId}: RESOLVE FAILED ${String(error)}`);
    continue;
  }
  const rows: string[] = [];
  for (const format of media.formats) {
    if (!format.url) continue;
    const mime = format.mimeType ?? "";
    const progressive = mime.includes('codecs="avc1');
    const whole = await probe(format.url, "bytes=0-");
    const bounded = await probe(format.url, "bytes=0-1023");
    rows.push(
      [
        `itag=${format.itag}`,
        progressive ? "muxed " : "adapt ",
        mime.split(";")[0],
        format.audioQuality ?? "-",
        `whole=${whole}`,
        `bounded=${bounded}`,
        `consumable=${whole === 200 || whole === 206}`,
      ].join(" | "),
    );
  }
  console.log(`\n=== ${videoId} (${media.title ?? "?"}) — ${rows.length} candidates`);
  for (const row of rows) console.log(`  ${row}`);
}
