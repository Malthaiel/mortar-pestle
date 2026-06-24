// Tree render kit — the pure, presentational candy-pill primitives shared by the
// vault file tree AND every other module sidebar (Browser / Library / Skills /
// Docs). Extracted VERBATIM from VaultTree.jsx so every surface renders
// byte-identically (the migration's whole point is one shell, pixel-for-pixel).
// No vault coupling here: no routing, no IPC, no manifest. Folders + leaves are
// the one canonical candy <button> (data-shape="row"); toolbar icons live in
// TreeToolbar. The recursive renderers stay surface-side — VaultTree keeps its
// lazy/disk renderer, TreeSidebar provides the generic in-memory one.
//
// Sizing: one NAV_H min-height makes every nav button the same vertical size; one
// GAP (visible-px + the nav candy-depth slab) clears the downward candy shadow so
// buttons never overlap (the slab sits OUTSIDE layout — util/candy.js).

import { useState, useEffect, useContext, createContext } from 'react';
import { IconChevronRight } from '../icons.jsx';

// Indent guide line — kept prominent (was border@70%×transparent ≈ invisible).
export const GUIDE = 'color-mix(in oklch, var(--text-muted) 60%, transparent)';
// Vertical inset of the indent guide from the first/last child row, applied
// EQUALLY top + bottom → the guide's top gap == its bottom gap by construction.
export const GUIDE_INSET = 10;
export const MUTED = { fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', padding: '4px 12px' };

// Every nav button is this tall (face min-height; box-sizing border-box, so it
// includes the 2px frame). One value → folders + files all match.
export const NAV_H = 26;
// THE universal tree gap — EVERY vertical gap uses this: section↔section,
// header↔first-child (TreeChildren marginTop), and sibling↔sibling. 4px of visible
// separation PLUS the nav candy-depth slab (which hangs below each button, outside
// layout). Tied to the same --candy-depth-nav knob the buttons use.
export const GAP = 'calc(4px + var(--candy-depth-nav))';

// Cascade timing presets (Settings → Animations → Vault tree → Folder reveal).
// step = delay between consecutive children; dur = each child's fade/slide AND the
// per-level base of the container height slide. 'off' (dur 0) = instant.
export const REVEAL = {
  off:    { step: 0,  dur: 0   },
  fast:   { step: 18, dur: 120 },
  normal: { step: 30, dur: 180 },
  slow:   { step: 55, dur: 300 },
};
// Children past this index share the last delay so huge folders don't drag.
export const STAGGER_CAP = 10;
// Cascade timing flows to Collapsible/StaggerChild via context (no prop drilling).
export const AnimCtx = createContext(REVEAL.normal);
// Whether to show name suffixes — folders get a trailing "/", files ".md" (vault
// only, Settings → Animations → Vault tree). Other surfaces leave it false.
export const SuffixCtx = createContext(false);

export const ELLIPSIS = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };

export function Caret({ open }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 12, height: 12, flexShrink: 0,
      transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform 140ms ease',
    }}><IconChevronRight/></span>
  );
}

// Node label + optional suffix. The suffix ("/" for folders, ".md" for files)
// renders in its own span with textTransform:none so ".md" stays lowercase against
// the uppercase name, and never shrinks (the name truncates before it). With no
// suffix it's the bare ellipsis span — identical to before the setting.
export function Label({ text, suffix }) {
  if (!suffix) return <span style={ELLIPSIS}>{text}</span>;
  return (
    <span style={{ display: 'inline-flex', minWidth: 0, maxWidth: '100%' }}>
      <span style={ELLIPSIS}>{text}</span>
      <span style={{ textTransform: 'none', flexShrink: 0 }}>{suffix}</span>
    </span>
  );
}

// Smooth height:auto reveal/collapse via the CSS grid 0fr↔1fr trick. overflow is
// hidden during the slide (so it can clip to 0) but flips to visible once the
// EXPAND finishes, otherwise it clips the bottom button's downward candy slab. With
// no animation (dur 0) a 0ms transition never fires transitionend, so settle
// immediately. Caller keeps it mounted while collapsed so the first expand
// transitions from 0fr.
export function Collapsible({ open, count = 0, children }) {
  const { step, dur } = useContext(AnimCtx);
  const animate = dur > 0;
  const [settled, setSettled] = useState(open || !animate);
  useEffect(() => {
    if (!open) setSettled(false);
    else if (!animate) setSettled(true);
  }, [open, animate]);
  const total = dur + Math.min(count, STAGGER_CAP) * step;
  return (
    <div
      style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', minWidth: 0, transition: `grid-template-rows ${total}ms cubic-bezier(0, 0, 0.58, 1)` }}
      onTransitionEnd={(e) => { if (e.propertyName === 'grid-template-rows' && open) setSettled(true); }}
    >
      {/* min-width:0 on the grid + its item lets nested rows shrink below their
          (nowrap) text, so each pill caps at the sidebar width and truncates to "…".
          Without it the grid item's min-content blows the column past the rail and
          long names hard-clip, no ellipsis. */}
      <div style={{ overflow: open && settled ? 'visible' : 'hidden', minHeight: 0, minWidth: 0 }}>
        {children}
      </div>
    </div>
  );
}

// One row of the cascade: fades + slides in with a per-index delay on open, and
// reverses (bottom-first) on collapse. Driven by `open` (already gated on the
// group's deferred "entered" flag, so the first frame is hidden → it transitions
// instead of snapping).
export function StaggerChild({ index, count, open, children }) {
  const { step, dur } = useContext(AnimCtx);
  const delay = (open ? Math.min(index, STAGGER_CAP) : Math.min(count - 1 - index, STAGGER_CAP)) * step;
  return (
    <div style={{
      opacity: open ? 1 : 0,
      transform: open ? 'translateY(0)' : 'translateY(-6px)',
      transition: `opacity ${dur}ms ease ${delay}ms, transform ${dur}ms ease ${delay}ms`,
    }}>{children}</div>
  );
}

// Shared candy-face for both folder headers and leaf rows — the inline overrides
// (mono / uppercase / 10.5px / radius 999) keep the tree's compact pill geometry.
const FACE = {
  justifyContent: 'flex-start', gap: 6, minWidth: 0,
  minHeight: NAV_H, boxSizing: 'border-box', padding: '0 11px',
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
};

// Pill toggle for EVERY folder (section roots + nested folders, identical). Uses
// the SAME recipe as the Settings drawer rail tabs: candy-btn + data-shape="row",
// is-active driven by `open` → grey at rest, SOLID accent fill on hover AND when
// active. `leadIcon`/`trailing` are optional adornments (a tab-group count, etc.);
// both default undefined so the vault renders exactly as before. `suffix` overrides
// the SuffixCtx-derived "/" when a surface wants explicit control.
export function CandyHeader({ label, open, onToggle, accent, onContextMenu, leadIcon, trailing, suffix }) {
  const showSuffix = useContext(SuffixCtx);
  const sfx = suffix != null ? suffix : (showSuffix ? '/' : '');
  return (
    <button
      type="button" data-own-press onClick={onToggle} onContextMenu={onContextMenu}
      className={`candy-btn${open ? ' is-active' : ''}`}
      data-shape="row"
      style={{
        '--cbtn-depth': 'var(--candy-depth-nav)',
        ...(accent ? { '--accent': accent } : {}),
        borderRadius: 999,
        // Hug content: each pill is only as wide as its text + caret, capped at the
        // sidebar width (override data-shape="row"'s width:100%).
        alignSelf: 'flex-start', width: 'fit-content', maxWidth: '100%',
      }}
    >
      <span className="candy-face" style={FACE}>
        <Caret open={open}/>
        {leadIcon}
        <Label text={label} suffix={sfx}/>
        {trailing}
      </span>
    </button>
  );
}

// Leaf pill — same data-shape="row" recipe as a folder, minus the caret. Accepts
// either a vault `node` (reads node.title || node.name) or an explicit `label`.
// `selected` holds the same solid accent fill an expanded folder gets, and tags the
// row data-current-file for the Reveal-current scroll. `leadIcon` (favicon),
// `trailing` (count / running-dot), and `suffix` are optional; all default
// undefined so the vault renders exactly as before.
export function TreeRow({ node, label, selected, accent, onClick, onContextMenu, noSuffix, suffix, leadIcon, trailing }) {
  const showSuffix = useContext(SuffixCtx);
  const text = label != null ? label : (node?.title || node?.name);
  const sfx = suffix != null ? suffix : ((showSuffix && !noSuffix) ? '.md' : '');
  return (
    <button
      type="button" data-own-press onClick={onClick} onContextMenu={onContextMenu}
      data-current-file={selected ? 'true' : undefined}
      className={`candy-btn${selected ? ' is-active' : ''}`}
      data-shape="row"
      style={{
        '--cbtn-depth': 'var(--candy-depth-nav)',
        ...(accent ? { '--accent': accent } : {}),
        borderRadius: 999,
        alignSelf: 'flex-start', width: 'fit-content', maxWidth: '100%',
      }}
    >
      <span className="candy-face" style={FACE}>
        {leadIcon}
        <Label text={text} suffix={sfx}/>
        {trailing}
      </span>
    </button>
  );
}

// Indented child group with a vertical guide. marginTop = GAP so the
// header↔first-child gap is the SAME universal gap as everything else. The guide is
// an absolutely-positioned hairline (NOT a border-left) so its top/bottom inset is
// controllable: GUIDE_INSET pulls it down from the first row and up from the last by
// the same amount → even top/bottom gap. position:absolute → out of flex flow.
export function TreeChildren({ children }) {
  return (
    <div style={{
      position: 'relative',
      marginLeft: 14, paddingLeft: 8, marginTop: GAP,
      display: 'flex', flexDirection: 'column', gap: GAP,
    }}>
      <div aria-hidden style={{
        position: 'absolute', left: 0, top: GUIDE_INSET, bottom: GUIDE_INSET,
        width: 1, background: GUIDE,
      }}/>
      {children}
    </div>
  );
}
