import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "subtle";

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-foreground hover:bg-accent-hover active:bg-accent-hover",
  // Phase 54: the three non-primary variants had NO `:active` rule at all,
  // so on a touch device - where there is no hover to fall back on - tapping
  // a ghost or secondary button produced no acknowledgement whatsoever.
  // `:active` is the touch equivalent of `:hover` and is what makes a tap
  // feel like it landed.
  secondary:
    "bg-surface-3 text-text-primary border border-border-strong hover:border-accent/50 hover:text-accent active:border-accent active:text-accent",
  ghost:
    "text-text-secondary hover:text-text-primary hover:bg-surface-2 active:bg-surface-2 active:text-text-primary",
  subtle: "text-text-muted hover:text-text-secondary active:text-text-secondary",
};

const sizeClasses = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  icon: "h-11 w-11 inline-flex items-center justify-center",
} as const;

type Size = keyof typeof sizeClasses;

interface SharedProps {
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}

/**
 * What the two primitives share, and nothing else: the box, the type, the
 * colour transition, and the press feedback. `aurora-press` lives here
 * rather than at each call site because a button without press feedback is
 * the defect, not the exception - and it is motion-safe by construction
 * (declared inside the stylesheet's `no-preference` block, so reduced-motion
 * visitors never see the scale, only the instant colour change).
 *
 * The two things that used to live here alongside those - `select-none` and the
 * absence of any cursor - are exactly the things that differ between an action
 * and a navigation, so they moved out of this string and into the two per-
 * primitive strings below. That split is what lets `Button` and `ButtonLink`
 * stop being the same component with a different tag: a `<button>` is a
 * command, an `<a href>` is a place, and those two answer the "can I select
 * this?" question differently.
 */
const baseClasses =
  "aurora-touch inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors aurora-press";

/**
 * `interaction` is the per-primitive half - cursor and selection - and is
 * required rather than defaulted, because a caller that forgets it would
 * silently ship a control with no affordance and no test would notice.
 */
function classes(
  interaction: string,
  variant: Variant,
  size: Size,
  className?: string,
): string {
  return [baseClasses, interaction, variantClasses[variant], sizeClasses[size], className]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: SharedProps & Omit<ComponentProps<"button">, keyof SharedProps>) {
  return (
    <button
      // A command. The label is part of the control, not text the user came to
      // read, so it is unselectable: a pointer drag that starts on "Play" and
      // crosses the row should not paint "Play" into the selection. The cursor
      // classes are redundant with the semantic default in `globals.css` and
      // are stated here anyway, because a component that can be rendered
      // outside that stylesheet - a test, a storybook, an embedded widget -
      // should not silently lose the one affordance that says "this is a
      // button". `disabled:` is the other half: a control that refuses the
      // interaction must not keep claiming it, so the cursor goes flat and
      // the whole control dims to 60% - still glass, just muted.
      className={classes(
        "cursor-pointer select-none disabled:cursor-not-allowed disabled:opacity-60",
        variant,
        size,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: SharedProps & Omit<ComponentProps<typeof Link>, keyof SharedProps> & { href: string }) {
  return (
    <Link
      href={href}
      // Navigation, so `select-text` where `Button` has `select-none`. This was
      // the one genuine contradiction in the primitive: `ButtonLink` rendered an
      // `<a href>` and therefore inherited the same "the text is part of the
      // control" rule that applies to a command, even though the rule's own
      // reasoning does not reach a link. The user clicks a destination and then
      // still wants to drag-select the label to paste it elsewhere, and a
      // `<button>` dressed as a link is not a way to make that impossible - it
      // is just a way to lose the middle-click, the open-in-new-tab, and the
      // status-bar destination preview that a real link gives for free.
      className={classes("cursor-pointer select-text", variant, size, className)}
      {...props}
    >
      {children}
    </Link>
  );
}
