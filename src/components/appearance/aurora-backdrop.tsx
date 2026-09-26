/**
 * The aurora background layer (Phase 53, §12, §13, §14, §49, §66, §67, §68).
 *
 * Three absolutely-positioned layers inside one fixed, inert container, in
 * front-to-back order:
 *
 *   image     the chosen picture, or nothing
 *   ambient   the aurora wash and the artwork reaction
 *   scrim     the contrast floor the image is read through
 *
 * Split into three elements rather than three `background-image` entries on
 * one, and that is not for the visuals - it is so each layer can be switched
 * off independently with `display: none`. An image the user never chose must
 * cost no composited layer and no gradient paint, and "two fully transparent
 * gradients" is not the same as none.
 *
 * The whole thing is `aria-hidden` and `pointer-events: none`. It is
 * decoration that happens to be a full-viewport element, and both of those
 * facts have to be invisible to assistive technology and to the pointer, not
 * merely usually so. §68 falls out of `position: fixed` with no scroll
 * listener anywhere: the layer does not move because the document does not
 * move it, and there is no code that could make it.
 *
 * Rendering nothing at all is not an option: this element IS the canvas. It
 * paints `--canvas-base` and the shell root is transparent, which is what lets
 * a background image show through the content area rather than only in the
 * margins. `body` still paints the same colour, so the pre-hydration frame
 * and any area outside the shell are correct too.
 */
export function AuroraBackdrop() {
  return (
    <div className="aurora-backdrop" aria-hidden="true" data-testid="aurora-backdrop">
      <div className="aurora-backdrop-image" />
      <div className="aurora-backdrop-ambient" />
      <div className="aurora-backdrop-scrim" />
    </div>
  );
}
