import { useId } from "react";
import type { SVGProps } from "react";

/**
 * Aurora Music mark — "A + wave".
 *
 * Two arcing legs meet at the apex (the letter A); a sound-wave bar crosses
 * them at the golden-third height. The gradient runs cyan → indigo → violet,
 * the product's own aurora triad (`--p-aurora-*`).
 *
 * GEOMETRY (32-space, validated by raster preview at 16–64px):
 * legs from y=24.2 to the apex y=8.2, meeting at x=16 (single shared point,
 * so there is no notch); wave from x=10.9 to x=20.7 through y≈17–20.4.
 * Stroke widths 2.8 (legs) / 3.0 (wave) with round caps — no fills, so the
 * silhouette survives down to 16px.
 *
 * `title` renders a `<title>` for standalone/larger uses. Inside `Brand` the
 * link already names itself ("Aurora Music home") and the mark must stay
 * decorative — pass nothing, and no `<title>` is emitted.
 *
 * THE GRADIENT ID MUST BE UNIQUE PER INSTANCE. `Brand` renders twice — once in
 * the header, once in the sidebar — and `url(#id)` resolves to the FIRST
 * element with that id in the document, not to the one in the nearest subtree.
 * With a shared id the header's stroke therefore bound to the SIDEBAR's copy,
 * and the sidebar is `hidden lg:flex`, so on every phone the paint server sat
 * inside a `display: none` subtree, resolved to nothing, and the header logo
 * rendered as a bare #08070d tile with no mark on it. A fixed id looks correct
 * on desktop, where the sidebar happens to be visible and paints the gradient
 * for both.
 */
export function AuroraMark({
  title,
  ...props
}: SVGProps<SVGSVGElement> & { title?: string }) {
  const gradientId = `aurora-mark-g-${useId()}`;
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient
          id={gradientId}
          x1="6"
          y1="26"
          x2="26"
          y2="6"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#3ecce2" />
          <stop offset="0.45" stopColor="#6f7de8" />
          <stop offset="1" stopColor="#a76ef8" />
        </linearGradient>
      </defs>
      <g
        stroke={`url(#${gradientId})`}
        strokeLinecap="round"
        fill="none"
      >
        <path
          d="M 9.80 24.20 C 10.07 23.37, 10.87 20.85, 11.40 19.20 C 11.93 17.55, 12.23 16.13, 13.00 14.30 C 13.77 12.47, 15.50 9.22, 16.00 8.20"
          strokeWidth="2.8"
        />
        <path
          d="M 22.20 24.20 C 21.93 23.37, 21.13 20.85, 20.60 19.20 C 20.07 17.55, 19.77 16.13, 19.00 14.30 C 18.23 12.47, 16.50 9.22, 16.00 8.20"
          strokeWidth="2.8"
        />
        <path
          d="M 10.90 19.40 C 11.27 18.98, 12.45 17.32, 13.10 16.90 C 13.75 16.48, 14.30 16.57, 14.80 16.90 C 15.30 17.23, 15.67 18.32, 16.10 18.90 C 16.53 19.48, 16.95 20.15, 17.40 20.40 C 17.85 20.65, 18.25 20.80, 18.80 20.40 C 19.35 20.00, 20.38 18.40, 20.70 18.00"
          strokeWidth="3"
        />
      </g>
    </svg>
  );
}
