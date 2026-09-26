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
}: {
  src?: string | null;
  alt: string;
  size?: ArtworkSize;
  pixelSize?: number;
  rounded?: string;
  className?: string;
  eager?: boolean;
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
  return (
    <Image
      src={src}
      alt={alt}
      width={px}
      height={px}
      unoptimized
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className={`shrink-0 bg-surface-3 object-cover ${rounded} ${className}`}
    />
  );
}
