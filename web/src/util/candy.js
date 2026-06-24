// Candy controls cast a --candy-depth downward box-shadow OUTSIDE layout flow.
// Any gap in the shadow direction (row-gap of wrapped candy rows, or the gap
// directly below a candy control in a column) must add the depth so the shadow
// clears. Visible separation ≈ `base`, so keep `base` on the 4px grid. Side-by-
// side (horizontal) gaps need nothing — the shadow points down, not sideways.
//
// Prefer the `.candy-stack` / `.candy-chip-row` classes (styles.css) for whole
// containers; use this helper for inline / grid cases that can't take a class
// (e.g. the calendar grid's rowGap). See DESIGN.md § Spacing and density →
// "Candy shadow clearance".
export const candyGap = (base, small = false) =>
  `calc(${base}px + var(--candy-depth${small ? '-small' : ''}))`;

// A candy control centered (align-items:center) in a horizontal ROW among
// shorter non-candy siblings (text/labels) sits visually low: flex centers its
// border-box, but the depth lip (a downward box-shadow) hangs BELOW it outside
// layout, so the visual mass is bottom-heavy. Lift it half its OWN depth so the
// face+lip unit reads centered. Reads the button's --cbtn-depth (set by the base
// rule / shape / inline), so it AUTO-matches full/small/custom depth and every
// user depth setting — no parameter to mismatch (the old `small` boolean was the
// recurring bug). Spread onto the .candy-btn ITSELF (where --cbtn-depth is
// defined), NOT a wrapping container — the var(... , --candy-depth) fallback
// keeps a stray container case from collapsing to 0. Uses `top` (not transform)
// so the press still actuates; the lift zeroes with the depth animation via
// --candy-center-on so flat buttons aren't lifted. Prefer the `.candy-center-row`
// class (styles.css) for whole rows. Verifier (DEV): util/candyCenterAudit.js.
// See DESIGN.md § Spacing and density → "Candy shadow clearance" (3).
export const candyCenterOffset = () => ({
  position: 'relative',
  top: 'calc(var(--cbtn-depth, var(--candy-depth)) / -2 * var(--candy-center-on, 1))',
});
