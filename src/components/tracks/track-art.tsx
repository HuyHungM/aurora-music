import Image from "next/image";
import { MusicNoteIcon } from "@/components/ui/icons";

export function TrackArt({
  src,
  alt,
  size = 48,
  className = "",
}: {
  src?: string | null;
  alt: string;
  size?: number;
  className?: string;
}) {
  const rounded = "rounded-md";
  if (!src) {
    return (
      <span
        aria-hidden="true"
        className={`grid shrink-0 place-items-center bg-gradient-aurora/25 text-text-secondary ${rounded} ${className}`}
        style={{ width: size, height: size }}
      >
        <MusicNoteIcon size={size * 0.45} />
      </span>
    );
  }
  return (
    <Image
      src={src}
      alt={alt}
      width={size}
      height={size}
      unoptimized
      className={`shrink-0 object-cover ${rounded} ${className}`}
    />
  );
}