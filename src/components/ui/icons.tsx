import type { CSSProperties, SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

/**
 * Applied to every icon by `base()`.
 *
 * A caller that passes its own `style` merges over these rather than replacing
 * them, so an icon can be recoloured or resized without accidentally handing it
 * back a clickable, selectable glyph.
 */
const DECORATIVE_STYLE: CSSProperties = {
  userSelect: "none",
  pointerEvents: "none",
};

/**
 * Every icon in the application is built here.
 *
 * That makes this function the single place where the app's position on
 * decorative content is enforced, rather than a property each of the ~30 icon
 * components could forget:
 *
 * - `aria-hidden` so assistive technology skips the glyph and reads the
 *   control's label instead. An icon is never the only carrier of meaning.
 * - `userSelect: "none"` so a pointer drag that starts on a glyph cannot paint
 *   a selection across the title beside it.
 * - `pointerEvents: "none"` so the glyph never intercepts a click that was
 *   aimed at the control containing it. Without this, a strict-mode double
 *   click on a button whose icon is the widest child can resolve to the `<svg>`
 *   rather than the button, and the handler silently does not run.
 *
 * Both go through `style`, not as bare attributes. React does not recognise
 * `userSelect` as a DOM prop: it warns once per component and then DROPS it, so
 * `userSelect: "none"` spread onto an `<svg>` is silently a no-op. `style` is
 * the only form that actually reaches the element, and it needs no stylesheet
 * to have loaded.
 */
function base({ size, style, ...props }: IconProps) {
  return {
    width: size ?? 20,
    height: size ?? 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    style: { ...DECORATIVE_STYLE, ...style },
    ...props,
  };
}

export function HomeIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

export function LibraryIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 4.5v15" />
      <path d="M8 4.5v15" />
      <path d="M13 5.5 18.5 3l2.5 14.5-5 2.5L13 5.5Z" />
    </svg>
  );
}

export function RadioIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="2" />
      <path d="M5 6.5a10 10 0 0 0 0 11" />
      <path d="M19 6.5a10 10 0 0 1 0 11" />
      <path d="M8 9.5a6 6 0 0 0 0 5" />
      <path d="M16 9.5a6 6 0 0 1 0 5" />
    </svg>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-3.5 3.6-5 8-5s8 1.5 8 5" />
    </svg>
  );
}

export function HeartIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 20.5C6 16 3 12.5 3 8.8 3 6 5.2 4 7.8 4c1.7 0 3.2.8 4.2 2.2C13 4.8 14.5 4 16.2 4 18.8 4 21 6 21 8.8c0 3.7-3 7.2-9 11.7Z" />
    </svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function MusicNoteIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 18V5.5l10-2V16" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </svg>
  );
}

export function XIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function LogOutIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3v6" />
      <path d="M12 15v6" />
      <path d="M3 12h6" />
      <path d="M15 12h6" />
      <path d="M5.6 5.6l4.2 4.2" />
      <path d="M14.2 14.2l4.2 4.2" />
      <path d="M18.4 5.6l-4.2 4.2" />
      <path d="M9.8 14.2l-4.2 4.2" />
    </svg>
  );
}

/**
 * Settings (Phase 53).
 *
 * A gear, and specifically not a "sliders" or "paint" glyph: those two
 * already mean two different things in this application, and the gear is the
 * one symbol that reads as "application-level" rather than "something you are
 * looking at". Drawn as a ring with eight teeth rather than a filled cog so
 * the interior hole keeps it legible at 18px in the sidebar footer.
 */
export function CogIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8" />
      <path d="M18.5 5.5 16.7 7.3M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5" />
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <svg {...base(props)} fill="currentColor" stroke="none">
      <path d="M8 5.5v13l11-6.5L8 5.5Z" />
    </svg>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <svg {...base(props)} fill="currentColor" stroke="none">
      <path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z" />
    </svg>
  );
}

export function SkipBackIcon(props: IconProps) {
  return (
    <svg {...base(props)} fill="currentColor" stroke="none">
      <path d="M17.5 5.5v13L7 12l10.5-6.5Z" />
      <path d="M6 5v14" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}

export function SkipForwardIcon(props: IconProps) {
  return (
    <svg {...base(props)} fill="currentColor" stroke="none">
      <path d="M6.5 5.5v13L17 12 6.5 5.5Z" />
      <path d="M18 5v14" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}

export function VolumeIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" stroke="none" />
      <path d="M16 8.5a4.5 4.5 0 0 1 0 7" />
      <path d="M18.5 5.8a8 8 0 0 1 0 12.4" />
    </svg>
  );
}

export function VolumeMuteIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" stroke="none" />
      <path d="m16 9.5 5 5" />
      <path d="m21 9.5-5 5" />
    </svg>
  );
}

export function QueueIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 6h16" />
      <path d="M4 12h10" />
      <path d="M4 18h10" />
      <path d="M17 16l3 3-3 3" />
      <path d="M20 19h-5" />
    </svg>
  );
}

/**
 * Shuffle: randomize playback order.
 *
 * The glyph is two lines that CROSS, each ending in an arrowhead on the right.
 * The crossing is the whole meaning — it is what separates shuffle from every
 * other transport control, and the previous version of this icon did not have
 * one. It drew `m20 2-4 4` and `m16 6 4-4`, which are the same segment in both
 * directions and therefore a single line rather than a chevron, so the shape
 * read as a stray diagonal tick beside two parallel strokes. It also carried
 * both of those paths twice, and its first line stopped at x=15 while the
 * second began at x=18, so nothing met at the bottom-right corner. A visitor
 * could not have named that control from its shape.
 *
 * Each line now terminates exactly on the vertex of its own arrowhead, so both
 * ends of both lines are closed and the silhouette is unambiguous at 18px.
 *
 * Kept deliberately distinct from its neighbours, since all three are transport
 * controls and get mistaken for each other:
 * - `RepeatIcon` / `RepeatOneIcon`: two horizontal lines closing a rectangle
 *   loop, chevrons top-right and bottom-LEFT. No crossing.
 * - `AutoContinueIcon`: two horizontal lines of different lengths and a single
 *   chevron. No crossing, no second arrowhead.
 * `__tests__/autoplay-control.test.tsx` and `__tests__/shuffle-control.test.tsx`
 * both assert the path data does not overlap, so a future edit cannot quietly
 * collapse one control into another.
 */
export function ShuffleIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      {/* Lower-left origin, rising to the top-right arrowhead. */}
      <path d="M2 18h1.5a3 3 0 0 0 2.6-1.5l6-9A3 3 0 0 1 14.7 6H22" />
      {/* Upper-left origin, falling to the bottom-right arrowhead. */}
      <path d="M2 6h1.5a3 3 0 0 1 2.6 1.5l6 9A3 3 0 0 0 14.7 18H22" />
      <path d="m18 2 4 4-4 4" />
      <path d="m18 14 4 4-4 4" />
    </svg>
  );
}

export function RepeatIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

export function RepeatOneIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
      <path d="M12 14.5v-5l2 2.5-2 2.5" />
    </svg>
  );
}

export function AlertCircleIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function ListMusicIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M21 15V6" />
      <path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
      <path d="M12 12H3" />
      <path d="M16 6H3" />
      <path d="M12 18H3" />
    </svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m18 15-6-6-6 6" />
    </svg>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

/** Phase 47: share link affordance. */
export function LinkIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

/** Phase 47: custom playlist artwork affordance. */
export function ImageIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
    </svg>
  );
}

/**
 * The clipboard half of a share control.
 *
 * Distinct from `LinkIcon` on purpose: `LinkIcon` is the identity of a link
 * (it is the toolbar affordance that OPENS this dialog), while this is the
 * action that PUTS one on the clipboard. Using the same glyph for both would
 * leave the copy button looking like the thing that opened the dialog.
 */
export function CopyIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/**
 * The OS share sheet: three nodes leaving a box.
 *
 * Only rendered where `navigator.share` exists, so its presence is itself the
 * statement that the platform will handle the handoff.
 */
export function ShareIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="m8.6 13.5 6.8 4" />
      <path d="m15.4 6.5-6.8 4" />
    </svg>
  );
}

/**
 * Public access: a globe.
 *
 * Paired with `LockIcon` so the two sharing states differ by SHAPE as well as
 * by colour. A state conveyed by colour alone is a state a reader who cannot
 * distinguish those colours has no way to perceive, and this one is the whole
 * point of the dialog.
 */
export function GlobeIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20Z" />
    </svg>
  );
}

/** Private access: the counterpart to `GlobeIcon`. */
export function LockIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/** A link was placed on the clipboard. Sits beside the "Copied" label. */
export function ClipboardCheckIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="m9 14 2 2 4-4" />
    </svg>
  );
}

/**
 * Autoplay / infinite listening — "the queue, and it goes on".
 *
 * Two queue lines; the lower one runs off the end of the list and finishes in
 * a one-way arrowhead. The DIRECTION carries the meaning, and it is what
 * separates this mark from every other transport glyph in the app:
 *
 *   - `RepeatIcon` / `RepeatOneIcon` are CLOSED rings with an arrowhead at both
 *     ends. This one is OPEN: the strand leaves and never comes back, so it
 *     cannot be read as "play these again".
 *   - `QueueIcon` ends in an arrow that hooks back into the list — "go back
 *     into what is queued". This arrow runs away from the list instead: "and
 *     on it goes".
 *   - `ShuffleIcon` crosses two paths; there is no crossing here.
 *   - `RadioIcon` is a centre dot with symmetric arcs. This is an asymmetric,
 *     directional flow.
 *
 * It is deliberately NOT an infinity sign. A lemniscate is a closed loop, and
 * the one that shipped in Phase 47 sat one button away from `RepeatIcon`, where
 * it read as a third repeat mode. The component was named after the shape, which
 * is how the shape came to mean the wrong thing; the name now follows the
 * meaning instead.
 */
export function AutoContinueIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 8.5h7.5" />
      <path d="M3 15h11.5" />
      <path d="m14.75 11.25 4.25 3.75-4.25 3.75" />
    </svg>
  );
}
