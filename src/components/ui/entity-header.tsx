import type { ReactNode } from "react";
import { Artwork, type ArtworkSize } from "@/components/ui/artwork";

/**
 * Shared editorial header for album / artist / track / playlist
 * (Phase 36). One composition: artwork, eyebrow, title, meta,
 * primary + secondary actions. Pages differ by content, not by
 * competing header implementations.
 */
export function EntityHeader({
  artwork,
  artworkAlt,
  artworkSize = "hero",
  eyebrow,
  title,
  meta,
  description,
  actions,
  secondary,
}: {
  artwork?: string | null;
  artworkAlt: string;
  artworkSize?: ArtworkSize;
  eyebrow: string;
  title: ReactNode;
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    // The card does NOT clip. `actions` is a row of real controls and one of
    // them is a menu trigger; a menu is deliberately bigger than the row that
    // opened it, so `overflow-hidden` here cut every action menu in half — the
    // track, album, artist and playlist headers all open their menus from
    // inside this box. The corners never needed it: `rounded-2xl` already
    // clips this element's own background and border, and the only child that
    // could have poked out of them is the decorative wash, which now rounds
    // itself.
    <div className="relative rounded-2xl border border-border-subtle bg-surface-1">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br from-accent/[0.13] via-transparent to-aurora-cyan/[0.07]"
      />
      <div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-end sm:gap-6 sm:p-7">
        <Artwork
          src={artwork}
          alt={artworkAlt}
          size={artworkSize}
          rounded="rounded-xl"
          eager
          className="shadow-lg"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="t-eyebrow">{eyebrow}</p>
          <h1 className="t-display min-w-0 break-words">{title}</h1>
          {meta ? <div className="t-metadata">{meta}</div> : null}
          {description ? (
            <div className="max-w-2xl text-sm leading-relaxed text-text-secondary">
              {description}
            </div>
          ) : null}
          {actions ? <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {secondary ? <div className="flex shrink-0 items-center gap-2">{secondary}</div> : null}
      </div>
    </div>
  );
}
