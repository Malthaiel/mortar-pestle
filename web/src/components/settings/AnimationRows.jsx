// Shared animation-toggle rows + hover-preview kit.
//
// Extracted from the retired Animations settings tab so the per-animation
// toggles keep their rich hover-preview demo cards wherever they now live
// (Appearance / Navigation / the Planner module tab). The single source of truth
// for each animation's label, description, and live demo visual.
//
// <AnimationField keys={[...]} settings setSetting accent /> renders one Row per
// key (enum → Seg, boolean → EnableToggle), all sharing one cursor-trailing
// portal preview popup. The popup's trailing-drag honors settings.previewFollowDrag
// gated on the master animations toggle (mirrors the old AnimationsTab behavior).
// Toggle writes go through to settings.animations in focus_settings; useSettings.js
// pushes the matching body[data-anim-<key>] attribute that CSS / JS gating reads.

import { useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import EnableToggle from '../ui/EnableToggle.jsx';
import { Seg } from '../ui/Pill.jsx';
import { ANIMATION_KEYS, ANIMATION_KEY_CONFIG } from '../../hooks/useSettings.js';

const ROWS = [
  { key: 'clock-ambient',          label: 'Clock breath + aura',     description: 'Accent glow aura on the Planner dial arcs while a session is running.' },
  { key: 'spring-press',           label: 'Spring press',            description: 'Scales every button down to 0.97 on mousedown and springs back on release. The single largest "tactile" lever in the product.' },
  { key: 'page-transitions',       label: 'Page transitions',        description: 'Animate route changes (forward and backward) with the candy lift. Without this, the new route appears instantly.' },
  { key: 'drawer-modal',           label: 'Drawer + modal slides',   description: 'Slide-in for the settings drawer, scale-shrink for modals, backdrop and content fade. Without this, overlays snap in.' },
  { key: 'flyout',                 label: 'Flyout pop-in/out',       description: 'Spring snap-open for collapsed-sidebar hover flyouts; snap-closed on leave.' },
  { key: 'section-accordion',      label: 'Section accordion',       description: 'Expand/collapse settle for sidebar sections and the chevron flip rotation that accompanies it.' },
  { key: 'pulse-indicators',       label: 'Pulse indicators',        description: 'Active-pill left-bar pulse, "new" badge pulse, conflict-toast spring.' },
  { key: 'drag-tile-follow',       label: 'Drag tile follow',        description: 'Clone motion during sidebar module reorder. Off: parks at origin. Cursor: tile stays at its rail position on pickup and translates by the cursor delta as you drag — the grab point stays under your cursor with no snap-to-center. Slot snap: snaps to current drop slot in 160ms with a subtle scale settle and soft snap thock.' },
  { key: 'drag-tile-smoothness',   label: 'Drag tile smoothness',    description: 'Lag / drag applied to the cursor-following clone during a sidebar module reorder (cursor mode only). None: instant 1:1 with the cursor. Light: subtle settle. Medium: balanced weighty feel (default). Heavy: significant drag — the tile noticeably trails the cursor and coasts to catch up when you stop.' },
  { key: 'drag-drop-glide',        label: 'Drop release glide',      description: 'How fast the picked-up tile glides into its new slot when you let go. The press-release animation also rides this duration. Off: tile snaps to slot instantly with no glide. 25%–100% scales the duration (lower = slower / longer; 100% is the snappiest). Default: 75%.' },
  { key: 'theme-transition',       label: 'Theme color transition',  description: 'Smooth 120ms color cross-fade when switching between light and dark themes. Without this, the theme switch is instant.' },
  { key: 'planner-day-slide',      label: 'Planner day slide',       description: 'Directional slide when the Planner day pane changes day — past days enter from the left, future days from the right.' },
  { key: 'counter-tick',           label: 'Section counter tick',    description: 'The Planner day pane’s section counters (events / tasks / notes) count up to new values instead of snapping.' },
  { key: 'task-celebration',       label: 'Task celebration',        description: 'Confetti burst and a short chime when you check off the last open task of today in the Planner.' },
  { key: 'copy-day-pop',           label: 'Copy day pop',           description: 'Checked weekday rows pop in sequence when you confirm a day-frame copy in the Planner.' },
  { key: 'frame-reset-restore',    label: 'Frame reset spin-restore', description: 'The reset circle spins 360° while recently-deleted frames scale back in with a soft stagger.' },
];

const ROW_BY_KEY = Object.fromEntries(ROWS.map(r => [r.key, r]));

// Per-frame catch-up factor for the cursor-following hover popup: 1 = snap,
// lower = more drag / longer trail.
const FOLLOW_LERP = { none: 1, light: 0.32, medium: 0.18, heavy: 0.09 };

// Renders the animation toggle rows for `keys`, all sharing one cursor-trailing
// preview popup. Hover tracking is hoisted to the rows container so a single
// preview card glides continuously across rows (and the inter-row gaps) instead
// of remounting per row.
export function AnimationField({ keys, settings, setSetting, accent }) {
  const animations = settings.animations || {};
  const accentColor = accent || 'var(--text)';
  const [hover, setHover] = useState(null); // { key, x, y } — x,y seed the popup at the entry cursor

  const isRowOn = (k) => {
    const v = animations[k];
    return ANIMATION_KEY_CONFIG[k] ? v !== 'off' : v !== false;
  };
  const masterOn = ANIMATION_KEYS.some(isRowOn);
  const followDrag = settings.previewFollowDrag || 'light';
  const followLerp = masterOn ? (FOLLOW_LERP[followDrag] ?? FOLLOW_LERP.light) : 1;

  const rows = keys.map(k => ROW_BY_KEY[k]).filter(Boolean);
  const hoveredRow = hover ? ROW_BY_KEY[hover.key] : null;

  const setRow = (key, val) => setSetting('animations', { [key]: val });

  const handleRowsMove = (e) => {
    const rowEl = e.target.closest && e.target.closest('[data-anim-key]');
    const key = rowEl && rowEl.getAttribute('data-anim-key');
    if (key) setHover(prev => (prev && prev.key === key ? prev : { key, x: e.clientX, y: e.clientY }));
  };

  return (
    <>
      <div
        onMouseMove={handleRowsMove}
        onMouseLeave={() => setHover(null)}
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        {rows.map(row => (
          <Row
            key={row.key}
            row={row}
            value={animations[row.key]}
            bucketConfig={ANIMATION_KEY_CONFIG[row.key]}
            accent={accentColor}
            onChange={(v) => setRow(row.key, v)}
          />
        ))}
      </div>

      {hover && hoveredRow && (
        <AnimHoverPopup
          seedX={hover.x}
          seedY={hover.y}
          lerp={followLerp}
          row={hoveredRow}
          value={animations[hover.key]}
          accent={accentColor}
        />
      )}
    </>
  );
}

function Row({ row, value, bucketConfig, accent, onChange }) {
  return (
    <div
      data-anim-key={row.key}
      data-search-anchor={`set-anim-${row.key}`}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '8px 12px',
        borderRadius: 'var(--radius-md)',
        background: 'transparent',
        transition: 'background 80ms ease',
        cursor: 'default',
      }}
      onMouseOver={(e) => e.currentTarget.style.background = 'var(--hover)'}
      onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
    >
      <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)', minWidth: 0 }}>{row.label}</span>
      {bucketConfig ? (
        <Seg
          value={value ?? bucketConfig.default}
          options={bucketConfig.values.map(v => ({ value: v, label: labelForEnum(v, row.key) }))}
          onChange={onChange}
          accent={accent}
        />
      ) : (
        <EnableToggle
          enabled={value !== false}
          accent={accent}
          onChange={() => onChange(value === false ? true : false)}
          title={row.label}
        />
      )}
    </div>
  );
}

function labelForEnum(v, key) {
  // Per-key label overrides. The drop-release glide's "off | 25 | 50 | 75
  // | 100" values read as "Off | 25% speed | …" to the user, so the bucket
  // dropdown shows speed-as-percentage rather than a bare integer.
  if (key === 'drag-drop-glide') {
    if (v === 'off') return 'Off';
    return `${v}% speed`;
  }
  return v.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
}

// Portal popup that follows the cursor while you hover the animation rows: demo +
// label + description, offset to the lower-right of the pointer (flipping near
// the viewport edges). Mounts once when the cursor enters the rows container and
// persists across row changes — its content swaps via props while a single rAF
// loop keeps gliding, so the momentum trail never resets between rows. `lerp` is
// the per-frame catch-up factor (1 = snap, lower = more drag). Position is owned
// imperatively via `transform`, which React never resets. Non-interactive.
function AnimHoverPopup({ seedX, seedY, lerp, row, value, accent }) {
  const ref = useRef(null);
  const seed = useRef({ x: seedX, y: seedY }); // entry point, frozen for this popup's life
  const lerpRef = useRef(lerp);
  useLayoutEffect(() => { lerpRef.current = lerp; }, [lerp]); // live lerp, no position reset

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const computeTarget = (cx, cy) => {
      const pw = el.offsetWidth, ph = el.offsetHeight;
      const vw = window.innerWidth, vh = window.innerHeight;
      const OFF = 16, PAD = 12;
      let left = cx + OFF;
      if (left + pw + PAD > vw) left = cx - OFF - pw; // flip left of cursor
      left = Math.max(PAD, Math.min(left, vw - pw - PAD));
      let top = cy + OFF;
      if (top + ph + PAD > vh) top = cy - OFF - ph;   // flip above cursor
      top = Math.max(PAD, Math.min(top, vh - ph - PAD));
      return { left, top };
    };

    // Seed at the entry cursor (corrected pre-paint), then trail toward the
    // global cursor target. cur/target are effect-local — the effect runs once.
    const t0 = computeTarget(seed.current.x, seed.current.y);
    const cur = { ...t0 };
    const target = { ...t0 };
    el.style.transform = `translate(${cur.left}px, ${cur.top}px)`;

    const onMove = (e) => { const n = computeTarget(e.clientX, e.clientY); target.left = n.left; target.top = n.top; };
    window.addEventListener('mousemove', onMove);

    let raf = 0;
    const tick = () => {
      const k = lerpRef.current >= 1 ? 1 : lerpRef.current;
      cur.left += (target.left - cur.left) * k;
      cur.top += (target.top - cur.top) * k;
      if (Math.abs(target.left - cur.left) < 0.5) cur.left = target.left; // settle, no sub-px jitter
      if (Math.abs(target.top - cur.top) < 0.5) cur.top = target.top;
      el.style.transform = `translate(${cur.left}px, ${cur.top}px)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      style={{
        position: 'fixed', left: 0, top: 0, willChange: 'transform',
        width: 230,
        pointerEvents: 'none', zIndex: 1200,
        background: 'var(--surface-2)',
        border: `1px solid ${accent}`,
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 16px 36px rgba(0,0,0,0.22)',
        padding: 14,
        display: 'flex', flexDirection: 'column', gap: 10,
        animation: 'fadeIn 0.14s ease',
      }}
    >
      <div style={{
        height: 72, borderRadius: 'var(--radius-sm)',
        background: 'var(--surface)', border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative', overflow: 'hidden',
      }}>
        <AnimVisual animKey={row.key} value={value} accent={accent}/>
      </div>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)',
      }}>{row.label}</div>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5,
      }}>{row.description}</div>
    </div>,
    document.body
  );
}

function AnimVisual({ animKey, value, accent }) {
  const a = accent;
  if (!animKey) {
    return <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--border-2)' }}/>;
  }
  switch (animKey) {
    case 'clock-ambient':
      return <div style={{
        width: 36, height: 36, borderRadius: '50%',
        background: `color-mix(in oklch, ${a} 28%, transparent)`,
        border: `1px solid ${a}`,
        animation: 'preview-breath 3.4s ease-in-out infinite',
      }}/>;
    case 'spring-press':
      return <div style={{
        width: 40, height: 28,
        borderRadius: 'var(--radius-md)',
        background: a,
        animation: 'preview-press 1.4s cubic-bezier(0.16, 1, 0.3, 1) infinite',
      }}/>;
    case 'page-transitions':
      return <div style={{
        width: 36, height: 36,
        background: `color-mix(in oklch, ${a} 40%, transparent)`,
        border: `1px solid ${a}`,
        borderRadius: 'var(--radius-sm)',
        animation: 'preview-slideX 1.8s ease-in-out infinite',
      }}/>;
    case 'drawer-modal':
      return <div style={{
        width: 22, height: 40,
        background: `color-mix(in oklch, ${a} 40%, transparent)`,
        border: `1px solid ${a}`,
        borderRadius: 2,
        animation: 'preview-slideX 1.8s ease-in-out infinite',
      }}/>;
    case 'flyout':
      return <div style={{
        width: 36, height: 28,
        background: `color-mix(in oklch, ${a} 35%, transparent)`,
        border: `1px solid ${a}`,
        borderRadius: 'var(--radius-sm)',
        transformOrigin: 'left center',
        animation: 'preview-flyout 1.8s cubic-bezier(0.16, 1, 0.3, 1) infinite',
      }}/>;
    case 'section-accordion':
      return <div style={{
        width: 40, height: 32,
        background: `color-mix(in oklch, ${a} 35%, transparent)`,
        border: `1px solid ${a}`,
        borderRadius: 'var(--radius-sm)',
        animation: 'preview-expand 1.8s ease-in-out infinite',
      }}/>;
    case 'pulse-indicators':
      return <div style={{
        width: 14, height: 14, borderRadius: '50%',
        background: a,
        boxShadow: `0 0 0 4px color-mix(in oklch, ${a} 30%, transparent)`,
        animation: 'preview-pulse 1.4s ease-in-out infinite',
      }}/>;
    case 'drag-tile-follow': {
      const mode = value ?? 'slot-snap';
      const baseStyle = {
        width: 36, height: 18, borderRadius: 4,
        background: `color-mix(in oklch, ${a} 40%, transparent)`,
        border: `1px solid ${a}`,
      };
      if (mode === 'off') {
        return <div style={baseStyle}/>;
      }
      if (mode === 'slot-snap') {
        return <div style={{
          ...baseStyle,
          animation: 'preview-drag-tile-slot-snap 1.8s cubic-bezier(0.32, 0.72, 0, 1) infinite',
        }}/>;
      }
      // 'cursor' (or v0.18.0 legacy true)
      return <div style={{
        ...baseStyle,
        animation: 'preview-drag 1.8s ease-in-out infinite',
      }}/>;
    }
    case 'drag-tile-smoothness':
      return <div style={{
        width: 36, height: 18, borderRadius: 4,
        background: `color-mix(in oklch, ${a} 40%, transparent)`,
        border: `1px solid ${a}`,
        animation: 'preview-smoothness 1.8s ease-in-out infinite',
      }}/>;
    case 'drag-drop-glide':
      return (
        <div style={{
          position: 'relative', width: 44, height: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            position: 'absolute', inset: 0,
            border: `1px dashed color-mix(in oklch, ${a} 55%, transparent)`,
            borderRadius: 4,
          }}/>
          <div style={{
            width: 36, height: 16, borderRadius: 4,
            background: `color-mix(in oklch, ${a} 40%, transparent)`,
            border: `1px solid ${a}`,
            animation: 'preview-glide 1.8s cubic-bezier(0.16, 1, 0.3, 1) infinite',
          }}/>
        </div>
      );
    case 'theme-transition':
      return <div style={{
        width: 36, height: 36,
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${a}`,
        animation: 'preview-theme 2s ease-in-out infinite',
      }}/>;
    case 'planner-day-slide':
      return <div style={{
        width: 36, height: 36,
        background: `color-mix(in oklch, ${a} 40%, transparent)`,
        border: `1px solid ${a}`,
        borderRadius: 'var(--radius-sm)',
        animation: 'preview-slideX 1.8s ease-in-out infinite',
      }}/>;
    case 'counter-tick':
      return <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color: a,
        animation: 'preview-pulse 1.4s ease-in-out infinite',
      }}>2/5</div>;
    case 'task-celebration':
      return (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              width: 10, height: 10, borderRadius: '50%',
              background: i === 1 ? a : `color-mix(in oklch, ${a} 45%, transparent)`,
              animation: `preview-pulse 1.2s ease-in-out ${i * 0.18}s infinite`,
            }}/>
          ))}
        </div>
      );
    case 'copy-day-pop':
      return <div style={{
        width: 30, height: 24, borderRadius: 'var(--radius-sm)',
        background: `color-mix(in oklch, ${a} 40%, transparent)`,
        border: `1px solid ${a}`,
        animation: 'preview-pulse 1.4s ease-in-out infinite',
      }}/>;
    case 'frame-reset-restore':
      return <div style={{
        width: 30, height: 30, borderRadius: '50%',
        background: `color-mix(in oklch, ${a} 35%, transparent)`,
        border: `1px solid ${a}`,
        animation: 'ftvSpin 1.6s linear infinite',
      }}/>;
    default:
      return null;
  }
}
