// Block editor — modal form for creating/editing a Block Library entry.
//
// Portals to document.body at z-index 1100 (above PlannerModal at 1000).
// Esc cancels (capture-phase + stopImmediatePropagation so PlannerModal's
// Esc handler does not also fire). Header includes an Open-in-Obsidian
// link so power users can edit the YAML directly.
//
// Fields:
//   - Name (required)
//   - Color (8-token OKLch swatch grid)
//   - Kind (Seg: Fixed / Variable / Floating)
//   - Duration (number, minutes)
//   - Kind-conditional:
//       fixed-recurring  → fixed_time (HH:MM) + fixed_days (M T W T F S S chips)
//       variable-recurring → cadence (text) + preferred_window (Seg)
//       floating          → preferred_window (Seg, with "any")
// IDs are derived from the name on create (kebab-case); edits preserve id.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconX, IconExternal } from '../icons.jsx';
import { IconBtn, PrimaryBtn, OutlinedBtn, Seg, TextInput, FilterChip, HeaderChip } from '../ui/index.js';

const BLOCK_LIBRARY_OBSIDIAN_URI = 'obsidian://open?vault=Pulse&file=Agentic%20OS%2FBlock%20Library.md';

export const BLOCK_COLOR_PRESETS = [
  'oklch(0.65 0.18 305)',  // purple
  'oklch(0.62 0.16 220)',  // blue
  'oklch(0.65 0.13 195)',  // teal
  'oklch(0.65 0.16 145)',  // green
  'oklch(0.72 0.13 90)',   // yellow
  'oklch(0.7 0.12 60)',    // orange
  'oklch(0.62 0.18 25)',   // red
  'oklch(0.55 0.02 250)',  // gray
];

const KIND_OPTIONS = [
  { value: 'fixed-recurring', label: 'Fixed' },
  { value: 'variable-recurring', label: 'Variable' },
  { value: 'floating', label: 'Floating' },
];

const WINDOW_OPTIONS = [
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
  { value: 'any', label: 'Any' },
];

const WEEKDAYS = [
  { value: 'mon', label: 'M' },
  { value: 'tue', label: 'T' },
  { value: 'wed', label: 'W' },
  { value: 'thu', label: 'T' },
  { value: 'fri', label: 'F' },
  { value: 'sat', label: 'S' },
  { value: 'sun', label: 'S' },
];

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function slugify(s) {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'block';
}

export default function BlockEditorModal({ open, block, accent, onSave, onCancel }) {
  const modalRef = useRef(null);
  const lastFocusRef = useRef(null);
  const isEdit = !!block;

  const [name, setName] = useState(block?.name || '');
  const [color, setColor] = useState(block?.color || BLOCK_COLOR_PRESETS[0]);
  const [kind, setKind] = useState(block?.kind || 'floating');
  const [duration, setDuration] = useState(String(block?.default_duration ?? 60));
  const [fixedTime, setFixedTime] = useState(block?.fixed_time || '09:00');
  const [fixedDays, setFixedDays] = useState(block?.fixed_days || ['mon', 'tue', 'wed', 'thu', 'fri']);
  const [cadence, setCadence] = useState(block?.cadence || '~daily');
  const [preferredWindow, setPreferredWindow] = useState(block?.preferred_window || 'any');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    lastFocusRef.current = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.stopImmediatePropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const t = setTimeout(() => modalRef.current?.focus(), 0);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(t);
      if (lastFocusRef.current && typeof lastFocusRef.current.focus === 'function') {
        try { lastFocusRef.current.focus(); } catch {}
      }
    };
  }, [open, onCancel]);

  if (!open) return null;

  const durationN = parseInt(duration, 10);
  const nameOk = name.trim().length > 0;
  const durationOk = Number.isInteger(durationN) && durationN > 0 && durationN <= 600;
  const fixedTimeOk = kind !== 'fixed-recurring' || TIME_RE.test(fixedTime);
  const fixedDaysOk = kind !== 'fixed-recurring' || fixedDays.length > 0;
  const canSave = nameOk && durationOk && fixedTimeOk && fixedDaysOk && !saving;

  const handleSubmit = async () => {
    if (!canSave) return;
    setSaving(true);
    const next = {
      id: isEdit ? block.id : slugify(name),
      name: name.trim(),
      color,
      kind,
      default_duration: durationN,
    };
    if (kind === 'fixed-recurring') {
      next.fixed_time = fixedTime;
      next.fixed_days = fixedDays;
    } else if (kind === 'variable-recurring') {
      next.cadence = cadence.trim();
      next.preferred_window = preferredWindow;
    } else {
      next.preferred_window = preferredWindow;
    }
    try {
      await onSave(next);
    } catch (e) {
      console.error('Block save failed', e);
      setSaving(false);
    }
  };

  const toggleDay = (day) => {
    setFixedDays(prev => prev.includes(day)
      ? prev.filter(d => d !== day)
      : [...prev, day]);
  };

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div onClick={onCancel} style={{
        position: 'absolute', inset: 0,
        background: 'rgba(0,0,0,0.32)',
        animation: 'backdropIn 0.18s ease',
      }}/>
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit block' : 'New block'}
        style={{
          position: 'relative',
          width: 'min(520px, 95vw)',
          maxHeight: 'min(640px, 92vh)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-card)',
          overflow: 'hidden',
          outline: 'none',
          animation: 'plannerModalIn 0.24s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 18px 12px',
          borderBottom: '1px solid var(--border-soft)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div style={{
            fontSize: 14, fontWeight: 600,
            letterSpacing: '-0.005em', color: 'var(--text)',
          }}>{isEdit ? 'Edit Block' : 'New Block'}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <HeaderChip href={BLOCK_LIBRARY_OBSIDIAN_URI} title="Open Block Library.md in Obsidian">
              Obsidian<IconExternal size={11}/>
            </HeaderChip>
            <IconBtn onClick={onCancel} title="Close" size={28}><IconX/></IconBtn>
          </div>
        </div>

        {/* Body */}
        <div className="candy-stack" style={{
          flex: 1, minHeight: 0,
          padding: '16px 18px',
          overflowY: 'auto',
          '--candy-gap': '8px',
        }}>
          <Field label="Name">
            <TextInput
              value={name}
              onChange={setName}
              placeholder="Twitch Stream"
              accent={accent}
              autoFocus={!isEdit}
              invalid={name !== '' && !nameOk}
              style={{ width: '100%' }}
            />
          </Field>

          <Field label="Color">
            <ColorGrid value={color} onChange={setColor}/>
          </Field>

          <Field label="Kind">
            <Seg options={KIND_OPTIONS} value={kind} onChange={setKind} accent={accent}/>
          </Field>

          <Field label="Default duration">
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <TextInput
                value={duration}
                onChange={setDuration}
                accent={accent}
                invalid={duration !== '' && !durationOk}
                style={{ width: 80, fontFamily: 'var(--font-mono)', textAlign: 'right' }}
              />
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>minutes</span>
            </div>
          </Field>

          {kind === 'fixed-recurring' && (
            <>
              <Field label="Time">
                <TextInput
                  value={fixedTime}
                  onChange={setFixedTime}
                  placeholder="09:00"
                  accent={accent}
                  invalid={fixedTime !== '' && !fixedTimeOk}
                  style={{ width: 100, fontFamily: 'var(--font-mono)', textAlign: 'center' }}
                />
              </Field>
              <Field label="Days">
                <div className="candy-chip-row" style={{ '--candy-gap': '4px' }}>
                  {WEEKDAYS.map(d => (
                    <FilterChip
                      key={d.value}
                      active={fixedDays.includes(d.value)}
                      accent={accent}
                      onClick={() => toggleDay(d.value)}
                    >{d.label}</FilterChip>
                  ))}
                </div>
              </Field>
            </>
          )}

          {kind === 'variable-recurring' && (
            <>
              <Field label="Cadence">
                <TextInput
                  value={cadence}
                  onChange={setCadence}
                  placeholder="~daily"
                  accent={accent}
                  style={{ width: 160 }}
                />
              </Field>
              <Field label="Preferred window">
                <Seg options={WINDOW_OPTIONS} value={preferredWindow} onChange={setPreferredWindow} accent={accent}/>
              </Field>
            </>
          )}

          {kind === 'floating' && (
            <Field label="Preferred window">
              <Seg options={WINDOW_OPTIONS} value={preferredWindow} onChange={setPreferredWindow} accent={accent}/>
            </Field>
          )}
        </div>

        {/* Footer */}
        <div className="candy-chip-row" style={{
          padding: '12px 18px',
          borderTop: '1px solid var(--border-soft)',
          justifyContent: 'flex-end', '--candy-gap': '8px',
          flexShrink: 0,
        }}>
          <OutlinedBtn onClick={onCancel}>Cancel</OutlinedBtn>
          <PrimaryBtn onClick={handleSubmit} disabled={!canSave} accent={accent}>
            {saving ? 'Saving…' : (isEdit ? 'Save' : 'Create')}
          </PrimaryBtn>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{
        color: 'var(--text-faint)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
      }}>{label}</div>
      {children}
    </div>
  );
}

function ColorGrid({ value, onChange }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(8, 28px)', gap: 8,
    }}>
      {BLOCK_COLOR_PRESETS.map(c => {
        const active = value === c;
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            title={c}
            style={{
              width: 28, height: 28,
              borderRadius: 'var(--radius-md)',
              background: c,
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              position: 'relative',
              boxShadow: active
                ? `0 0 0 2px var(--surface), 0 0 0 3.5px ${c}`
                : 'inset 0 0 0 1px rgba(0,0,0,0.06)',
              transform: active ? 'scale(1.04)' : 'scale(1)',
              transition: 'transform 100ms ease, box-shadow 120ms ease',
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.transform = 'scale(1.06)'; }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.transform = 'scale(1)'; }}
          />
        );
      })}
    </div>
  );
}
