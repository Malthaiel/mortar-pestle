// Generic magnetic-seam resize handle for sidebars.
//
// Behaviors locked in the 2026-05-21 nav rebuild planning pass:
//   - Magnetic seam affordance: invisible until cursor enters a 6px
//     hotzone; then a 2px accent line fades in over 120ms; soft accent
//     aura while dragging.
//   - Magnetic snap to common widths (snapTargets) with an 8px pull
//     radius; brief 80ms accent flash on the seam every time the cursor
//     crosses into a new snap target (haptic-feedback analog).
//   - Live width badge follows the cursor while dragging.
//   - 1px accent ring along the rail-side edge of the seam while dragging.
//   - Rubber-band overshoot at min/max (~28px exponential decay) that
//     springs back to the boundary on release.
//   - Auto-collapse with memory: dragging below `collapseThreshold` and
//     releasing fires `onCollapse()`; parent owns the collapse projection.
//     Last expanded width is preserved (never written through during the
//     undersize drag).
//   - Width preset chips floated to the right of the seam on hover (not
//     while dragging) — click to jump.
//   - Double-click the seam → reset to `defaultWidth`.
//   - Cmd/Ctrl + `0` anywhere → reset to `defaultWidth` (suppressed when
//     focus is inside an editable target).
//   - Persistence via `storageKey` (writes the committed width on release
//     or chip-click; never during drag).
//
// Portals: the width badge and preset chips render to document.body so
// they aren't clipped by ancestor overflow:hidden (the settings drawer
// modal hides overflow to do its rounded corners).

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const HOTZONE_PX  = 6;
const SEAM_WIDTH  = 2;
const SNAP_RADIUS = 8;
const RUBBER_MAX  = 28;
const PRESET_GAP  = 12;

function rubberBand(over) {
  return RUBBER_MAX * (1 - Math.exp(-over / 50));
}

function isEditableTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export default function SidebarSeam({
  width,
  onWidthChange,
  accent,
  defaultWidth,
  minWidth,
  maxWidth,
  snapTargets = [],
  collapseThreshold = 0,
  collapsed = false,
  onCollapse,
  onUncollapse,
  onDragStart,
  onDragEnd,
  presets = [],
  storageKey,
  resetKey = '0',
  ariaLabel = 'Resize sidebar',
  edgeRingSide = 'left',
  inverted = false,
  style: outerStyle,
}) {
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [pulseTick, setPulseTick] = useState(0);
  const [pulseFlash, setPulseFlash] = useState(false);
  const [seamRect, setSeamRect] = useState(null);
  const dragStateRef = useRef(null);
  const lastSnappedRef = useRef(null);
  const seamRef = useRef(null);
  const accentColor = accent || 'var(--text)';

  const persist = useCallback((v) => {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, String(v)); } catch {}
  }, [storageKey]);

  useEffect(() => {
    if (!pulseTick) return;
    setPulseFlash(true);
    const t = setTimeout(() => setPulseFlash(false), 80);
    return () => clearTimeout(t);
  }, [pulseTick]);

  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key !== resetKey) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      onWidthChange(defaultWidth);
      persist(defaultWidth);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [defaultWidth, onWidthChange, persist, resetKey]);

  useEffect(() => {
    if (hover && seamRef.current) {
      setSeamRect(seamRef.current.getBoundingClientRect());
    }
  }, [hover]);

  const snapIfNear = useCallback((raw) => {
    for (const t of snapTargets) {
      if (Math.abs(raw - t) <= SNAP_RADIUS) return { value: t, snapped: true };
    }
    return { value: raw, snapped: false };
  }, [snapTargets]);

  const onPointerDown = useCallback((e) => {
    if (collapsed) return;
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
    lastSnappedRef.current = null;
    onDragStart?.();

    const onMove = (ev) => {
      // For a left-edge seam attached to a right-hand sidebar (`inverted`),
      // leftward cursor motion grows the sidebar — invert the delta so the
      // rest of the snap/rubberband/persist math stays direction-agnostic.
      const rawDx = ev.clientX - dragStateRef.current.startX;
      const dx = inverted ? -rawDx : rawDx;
      let raw = dragStateRef.current.startWidth + dx;
      setCursor({ x: ev.clientX, y: ev.clientY });

      if (collapseThreshold > 0 && raw < collapseThreshold) {
        const over = Math.max(0, minWidth - raw);
        raw = minWidth - rubberBand(over);
      } else if (raw < minWidth) {
        raw = minWidth - rubberBand(minWidth - raw);
      } else if (raw > maxWidth) {
        raw = maxWidth + rubberBand(raw - maxWidth);
      } else {
        const { value, snapped } = snapIfNear(raw);
        if (snapped) {
          if (lastSnappedRef.current !== value) {
            setPulseTick(k => k + 1);
            lastSnappedRef.current = value;
          }
          raw = value;
        } else {
          lastSnappedRef.current = null;
        }
      }
      onWidthChange(raw);
    };

    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragging(false);
      onDragEnd?.();

      const rawDx = ev.clientX - dragStateRef.current.startX;
      const dx = inverted ? -rawDx : rawDx;
      const raw = dragStateRef.current.startWidth + dx;

      if (collapseThreshold > 0 && raw < collapseThreshold && onCollapse) {
        // Preserve the pre-drag width; the collapse path doesn't persist
        // a new width — the next expand restores `startWidth`.
        onWidthChange(dragStateRef.current.startWidth);
        onCollapse();
        return;
      }

      let final = Math.max(minWidth, Math.min(maxWidth, raw));
      final = snapIfNear(final).value;
      onWidthChange(final);
      persist(final);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [collapsed, width, minWidth, maxWidth, snapIfNear, collapseThreshold, onCollapse, onWidthChange, persist, onDragStart, onDragEnd, inverted]);

  const onDoubleClick = useCallback(() => {
    if (collapsed) return;
    onWidthChange(defaultWidth);
    persist(defaultWidth);
  }, [collapsed, defaultWidth, onWidthChange, persist]);

  const pickPreset = useCallback((v) => {
    onWidthChange(v);
    persist(v);
  }, [onWidthChange, persist]);

  // Collapsed mode: render a thin clickable expand strip instead of the
  // drag seam. Clicking it (or pressing Enter when focused) restores the
  // sidebar to its remembered expanded width.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onUncollapse}
        aria-label="Expand sidebar"
        title="Expand sidebar"
        style={{
          width: HOTZONE_PX,
          alignSelf: 'stretch',
          flexShrink: 0,
          position: 'relative',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'e-resize',
        }}
        onMouseEnter={e => {
          const inner = e.currentTarget.querySelector('[data-seam-inner]');
          if (inner) inner.style.opacity = '1';
        }}
        onMouseLeave={e => {
          const inner = e.currentTarget.querySelector('[data-seam-inner]');
          if (inner) inner.style.opacity = '0';
        }}
      >
        <span
          aria-hidden
          data-seam-inner
          style={{
            position: 'absolute',
            top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 2, height: 24,
            background: accentColor,
            borderRadius: 1,
            opacity: 0,
            transition: 'opacity 120ms ease',
          }}
        />
      </button>
    );
  }

  const visible = hover || dragging;

  return (
    <>
      <div
        ref={seamRef}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        role="separator"
        aria-orientation="vertical"
        aria-label={ariaLabel}
        title="Drag to resize · double-click to reset"
        style={{
          width: HOTZONE_PX,
          alignSelf: 'stretch',
          flexShrink: 0,
          cursor: 'col-resize',
          position: 'relative',
          zIndex: 4,
          ...outerStyle,
        }}
      >
        <div aria-hidden style={{
          position: 'absolute',
          top: 0, bottom: 0,
          left: (HOTZONE_PX - SEAM_WIDTH) / 2,
          width: SEAM_WIDTH,
          background: accentColor,
          borderRadius: 1,
          opacity: visible ? 1 : 0,
          boxShadow: pulseFlash
            ? `0 0 0 4px color-mix(in oklch, ${accentColor} 42%, transparent)`
            : dragging
              ? `0 0 0 3px color-mix(in oklch, ${accentColor} 60%, transparent)`
              : 'none',
          transition: dragging
            ? 'box-shadow 80ms ease'
            : 'opacity 120ms ease, box-shadow 140ms ease',
        }}/>
        {dragging && (
          <div aria-hidden style={{
            position: 'absolute',
            top: 0, bottom: 0,
            [edgeRingSide]: 0,
            width: 1,
            background: accentColor,
            opacity: 0.55,
            pointerEvents: 'none',
          }}/>
        )}
      </div>

      {hover && !dragging && presets.length > 0 && seamRect && createPortal(
        <PresetChips
          seamRect={seamRect}
          presets={presets}
          accent={accentColor}
          currentWidth={Math.round(width)}
          onPick={pickPreset}
        />,
        document.body
      )}

      {dragging && createPortal(
        <WidthBadge
          x={cursor.x}
          y={cursor.y}
          value={Math.round(width)}
          accent={accentColor}
        />,
        document.body
      )}
    </>
  );
}

function PresetChips({ seamRect, presets, accent, currentWidth, onPick }) {
  const midY = seamRect.top + seamRect.height / 2;
  const left = seamRect.right + PRESET_GAP;
  return (
    <div
      onMouseDown={e => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: midY,
        left,
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        zIndex: 1300,
        animation: 'fadeIn 0.18s ease',
      }}
    >
      {presets.map(p => (
        <PresetChip
          key={p.value}
          chip={p}
          accent={accent}
          active={currentWidth === p.value}
          onClick={() => onPick(p.value)}
        />
      ))}
    </div>
  );
}

function PresetChip({ chip, accent, active, onClick }) {
  const [hover, setHover] = useState(false);
  const bg = hover || active
    ? `color-mix(in oklch, ${accent} 18%, var(--surface))`
    : 'var(--surface)';
  return (
    <button
      type="button"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        background: bg,
        color: active ? accent : 'var(--text)',
        border: `1px solid ${active ? accent : 'var(--border-2)'}`,
        boxShadow: hover
          ? `0 4px 14px color-mix(in oklch, ${accent} 22%, transparent)`
          : 'var(--shadow-card)',
        borderRadius: 999,
        padding: '4px 12px',
        fontSize: 10.5,
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.04em',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        whiteSpace: 'nowrap',
        transform: hover ? 'translateX(2px)' : 'translateX(0)',
        transition: 'background 120ms ease, color 120ms ease, box-shadow 140ms ease, transform 160ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <span style={{ fontWeight: 600 }}>{chip.label}</span>
      <span style={{
        fontSize: 9, opacity: 0.7,
        color: active ? accent : 'var(--text-faint)',
      }}>{chip.value}</span>
    </button>
  );
}

function WidthBadge({ x, y, value, accent }) {
  return (
    <div aria-hidden style={{
      position: 'fixed',
      top: y - 30,
      left: x + 14,
      padding: '3px 9px',
      borderRadius: 999,
      background: accent,
      color: 'white',
      fontSize: 10.5,
      fontFamily: 'var(--font-mono)',
      letterSpacing: '0.04em',
      pointerEvents: 'none',
      zIndex: 1400,
      whiteSpace: 'nowrap',
      fontWeight: 700,
    }}>{value}px</div>
  );
}
