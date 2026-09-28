import Image from "next/image";
import { MusicNoteIcon } from "@/components/ui/icons";

/**
 * Canonical artwork primitive (Phase 36).
 * Deliberate sizes: thumbnail 40 / small 48 / medium 80 /
 * large 160 / hero 192 / player 56. One fallback, one radius
 * language, no giant downloads for tiny UI.
 */
export type ArtworkSize = "thumbnail" | "small" | "medium" | "large" | "hero" | "player";

const SIZE_PX: Record<ArtworkSize, number> = {
  thumbnail: 40,
  small: 48,
  medium: 80,
  large: 160,
  hero: 192,
  player: 56,
};

export function Artwork({
  src,
  alt,
  size = "small",
  pixelSize,
  rounded = "rounded-lg",
  className = "",
  eager = false,
  fill = false,
}: {
  src?: string | null;
  alt: string;
  size?: ArtworkSize;
  pixelSize?: number;
  rounded?: string;
  className?: string;
  eager?: boolean;
  /**
   * Fill the nearest positioned ancestor instead of reserving a `px` square.
   * Use when CSS (not the intrinsic `px`) defines the box: the caller supplies
   * a `relative` wrapper with an explicit size and the image is cropped with
   * `object-cover`. This keeps a deliberately non-square box from tripping
   * next/image's single-axis width/height-modified warning when one CSS axis
   * happens to equal the intrinsic `px`.
   */
  fill?: boolean;
}) {
  const px = pixelSize ?? SIZE_PX[size];
  if (!src) {
    return (
      <span
        aria-hidden="true"
        data-slot="artwork-fallback"
        className={`relative grid shrink-0 place-items-center overflow-hidden bg-surface-3 text-text-muted ${rounded} ${className}`}
        style={{ width: px, height: px }}
      >
        <span
          aria-hidden="true"
          className="aurora-fill absolute inset-0 opacity-20"
        />
        <MusicNoteIcon size={Math.round(px * 0.42)} className="relative" />
      </span>
    );
  }
  if (fill) {
    return (
      <Image
        src={src}
        alt={alt}
        fill
        unoptimized
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        className={`bg-surface-3 object-cover ${rounded} ${className}`}
      />
    );
  }
  return (
    <Image
      src={src}
      alt={alt}
      width={px}
      height={px}
      unoptimized
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      // `aspect-square` is load-bearing, not decoration. Tailwind's preflight
      // sets `img { height: auto }`, which beats the `height` attribute, so the
      // browser derives the rendered height from the source image's intrinsic
      // aspect ratio (Visually: a 44x44 square came back 44x25 for a 16:9
      // video thumbnail). The CSS `aspect-ratio` re-establishes the intended
      // square and silences next/image's single-axis-modified warning. Callers
      // that size the box themselves (`w-full`, `max-w-*`, `h-auto`) still
      // win: they set both axes, and `aspect-square` is idempotent with the
      // card pattern already used in `album-card`/`artist-card`.
      className={`aspect-square shrink-0 bg-surface-3 object-cover ${rounded} ${className}`}
    />
  );
}
