// New Event popup — schedules an event onto a day's daily log (creating the
// log if missing). Portaled above the Planner (z 1100). Fields: day (mini
// month picker), event type (with in-place custom-type creation), start/end
// time, title, notes, reminder lead-time, and an optional linked vault page.
// On save, writes via api.events.add and fires a confirmation notification.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api.js';
import { useEventTypes } from '../../hooks/useEventTypes.js';
import { MIN_REMINDERS, DAY_REMINDERS, reminderLabel, keyForDate } from '../../util/events.js';
import { candyGap } from '../../util/candy.js';
import { AccentGrid } from '../ui/AccentPicker.jsx';
import { IconX, IconLink } from '../icons.jsx';
import MiniMonthPicker from './MiniMonthPicker.jsx';
import { PrimaryBtn, OutlinedBtn } from '../ui/index.js';

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'type';
}

export default function NewEventModal({ open, onClose, onCreated, accent = 'var(--accent)', initialDs = null, initialStart = null }) {
  const { types, addType, removeType } = useEventTypes();
  const [ds, setDs] = useState(() => initialDs || keyForDate(new Date()));
  const [typeId, setTypeId] = useState(null);
  const [start, setStart] = useState(initialStart || '09:00');
  const [end, setEnd] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [reminderLead, setReminderLead] = useState(null);
  const [minIdx, setMinIdx] = useState(0);
  const [dayIdx, setDayIdx] = useState(0);
  const [link, setLink] = useState(null);
  const [linkQuery, setLinkQuery] = useState('');
  const [linkResults, setLinkResults] = useState([]);
  const [showNewType, setShowNewType] = useState(false);
  const [editTypes, setEditTypes] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [newTypeName, setNewTypeName] = useState('');
  const [newTypeColor, setNewTypeColor] = useState('#5d3a4a');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Seed selected type once types are available.
  useEffect(() => {
    if (typeId == null && types.length) setTypeId(types[0].id);
  }, [types, typeId]);

  // Reset transient fields each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setDs(initialDs || keyForDate(new Date()));
    setStart(initialStart || '09:00'); setEnd(''); setAllDay(false); setTitle(''); setNote('');
    setReminderLead(null); setMinIdx(0); setDayIdx(0);
    setLink(null); setLinkQuery(''); setLinkResults([]);
    setShowNewType(false); setEditTypes(false); setConfirmDeleteId(null); setNewTypeName(''); setErr(null); setBusy(false);
  }, [open]);

  // Capture-phase Esc so it closes this popup without bubbling to the Planner's
  // own Esc handler (which would close the whole Planner).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!busy) onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, busy, onClose]);

  // Debounced link search.
  useEffect(() => {
    if (!open || link || !linkQuery.trim()) { setLinkResults([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.searchAllPages(linkQuery.trim(), 8)
        .then(res => { if (!cancelled) setLinkResults(res?.results || []); })
        .catch(() => { if (!cancelled) setLinkResults([]); });
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [linkQuery, link, open]);

  if (!open) return null;

  const createType = async () => {
    const name = newTypeName.trim();
    if (!name) return;
    const id = slugify(name);
    try {
      await addType({ id, name, color: newTypeColor });
      setTypeId(id);
      setShowNewType(false);
      setNewTypeName('');
    } catch {
      setErr('Could not save the new type.');
    }
  };

  const deleteType = async (id) => {
    setConfirmDeleteId(null);
    try {
      await removeType(id);
      if (typeId === id) setTypeId(types.find(t => t.id !== id)?.id ?? null);
    } catch {
      setErr('Could not delete the type.');
    }
  };

  const submit = async () => {
    if (!title.trim() || !ds || (!allDay && !start)) {
      setErr(allDay ? 'Pick a day and a title.' : 'Pick a day, a start time, and a title.');
      return;
    }
    setBusy(true); setErr(null);
    try {
      const typeName = types.find(t => t.id === typeId)?.name || null;
      const r = await api.events.add(ds, {
        start: allDay ? null : start,
        end: allDay ? null : (end || null),
        allDay,
        typeName,
        title: title.trim(),
        reminderLead: allDay ? null : reminderLead,
        link: link || null,
        note: note.trim() || null,
      });
      window.dispatchEvent(new CustomEvent('agentic:notify', { detail: {
        type: 'info',
        title: r?.created ? 'Event scheduled (new day created)' : 'Event scheduled',
        message: `${typeName ? typeName + ': ' : ''}${title.trim()}`,
        iconKey: 'bell',
        duration: 4000,
      } }));
      onCreated?.();
      onClose();
    } catch (e) {
      setErr(e?.code === 'CONFLICT'
        ? 'That day’s log changed externally — close and retry.'
        : (e?.message || 'Failed to save the event.'));
      setBusy(false);
    }
  };

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div onClick={() => { if (!busy) onClose(); }} className="candy-backdrop"/>
      <div
        className="candy-modal"
        role="dialog" aria-modal="true" aria-label="New Event"
        onClick={e => e.stopPropagation()}
        style={{
          position: 'relative', width: 'min(620px, 94vw)', maxHeight: '88vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          animation: 'plannerModalIn 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px 12px', borderBottom: '1px solid var(--border-soft)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
        }}>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text)' }}>New Event</div>
          <button type="button" data-own-press className="candy-btn" data-shape="chip" onClick={() => { if (!busy) onClose(); }}
            aria-label="Close"><span className="candy-face" style={{ padding: 5 }}><IconX/></span></button>
        </div>

        {/* Body */}
        <div style={{ display: 'flex', gap: 18, padding: 18, overflowY: 'auto', minHeight: 0 }}>
          {/* Left — day picker */}
          <div style={{ width: 248, flexShrink: 0 }}>
            <MiniMonthPicker value={ds} onSelect={setDs} accent={accent}/>
          </div>

          {/* Right — fields */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 13 }}>
            <Field label="Type" action={
              <button type="button" data-own-press className={`candy-btn${editTypes ? ' is-active' : ''}`} data-shape="chip"
                onClick={() => { setEditTypes(e => !e); setShowNewType(false); setConfirmDeleteId(null); }}
                style={{ '--accent': accent }}>
                <span className="candy-face" style={{ fontSize: 10, padding: '3px 9px' }}>{editTypes ? 'Done' : 'Edit'}</span>
              </button>
            }>
              <div className="candy-chip-row" style={{ '--candy-gap': '8px' }}>
                {types.map(t => (
                  <TypePill key={t.id} type={t} active={t.id === typeId} accent={accent}
                    editing={editTypes}
                    confirming={confirmDeleteId === t.id}
                    onClick={() => { setTypeId(t.id); setShowNewType(false); setConfirmDeleteId(null); }}
                    onAskDelete={() => setConfirmDeleteId(t.id)}
                    onCancelDelete={() => setConfirmDeleteId(null)}
                    onConfirmDelete={() => deleteType(t.id)}/>
                ))}
                {editTypes && (
                  <button type="button" data-own-press className="candy-btn" data-shape="chip"
                    onClick={() => setShowNewType(s => !s)}>
                    <span className="candy-face" style={{ fontSize: 10, padding: '4px 10px' }}>＋ New</span>
                  </button>
                )}
              </div>
              {showNewType && (
                <div style={{
                  marginTop: 8, padding: 10, borderRadius: 'var(--radius-md)',
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  display: 'flex', flexDirection: 'column', gap: 8,
                }}>
                  <input className="candy-input" value={newTypeName} autoFocus
                    onChange={e => setNewTypeName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); createType(); } }}
                    placeholder="Type name" style={inputStyle}/>
                  <AccentGrid value={newTypeColor} onChange={setNewTypeColor}/>
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button type="button" data-own-press className="candy-btn" data-shape="chip" onClick={() => setShowNewType(false)}>
                      <span className="candy-face" style={{ fontSize: 10, padding: '4px 10px' }}>Cancel</span></button>
                    <button type="button" data-own-press onClick={createType} className="candy-btn is-active" data-shape="chip"
                      style={{ '--accent': accent }}><span className="candy-face" style={{ fontSize: 10, padding: '4px 10px' }}>Add type</span></button>
                  </div>
                </div>
              )}
            </Field>

            <Field label="Time">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="time" className="candy-input" value={start} disabled={allDay}
                  onChange={e => setStart(e.target.value)}
                  style={{ ...inputStyle, width: 96, opacity: allDay ? 0.4 : 1 }}/>
                <span style={{ color: 'var(--text-faint)', opacity: allDay ? 0.4 : 1 }}>–</span>
                <input type="time" className="candy-input" value={end} disabled={allDay}
                  onChange={e => setEnd(e.target.value)}
                  style={{ ...inputStyle, width: 96, opacity: allDay ? 0.4 : 1 }}/>
                <button type="button" data-own-press className={`candy-btn${allDay ? ' is-active' : ''}`} data-shape="chip"
                  onClick={() => { const nv = !allDay; setAllDay(nv); if (nv) setReminderLead(null); }}
                  style={{ '--accent': accent, marginLeft: 'auto', flexShrink: 0 }}>
                  <span className="candy-face" style={{ fontSize: 10, padding: '4px 12px', whiteSpace: 'nowrap' }}>All Day</span>
                </button>
              </div>
            </Field>

            <Field label="Title">
              <input className="candy-input" value={title} onChange={e => setTitle(e.target.value)}
                placeholder="What's happening?" style={inputStyle}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}/>
            </Field>

            <Field label="Notes">
              <textarea className="candy-input" value={note} onChange={e => setNote(e.target.value)}
                rows={2} placeholder="Optional details…"
                style={{ ...inputStyle, resize: 'vertical', minHeight: 38, fontFamily: 'inherit' }}/>
            </Field>

            <Field label="Reminder">
              <div className="candy-chip-row" style={{
                '--candy-gap': '8px',
                opacity: allDay ? 0.4 : 1, pointerEvents: allDay ? 'none' : 'auto',
              }}>
                <ReminderChip label="None" active={reminderLead == null} accent={accent}
                  onClick={() => setReminderLead(null)}/>
                <ReminderChip label={reminderLabel(MIN_REMINDERS[minIdx])} accent={accent}
                  active={MIN_REMINDERS.includes(reminderLead)}
                  onClick={() => {
                    if (MIN_REMINDERS.includes(reminderLead)) {
                      const next = (minIdx + 1) % MIN_REMINDERS.length;
                      setMinIdx(next); setReminderLead(MIN_REMINDERS[next]);
                    } else { setReminderLead(MIN_REMINDERS[minIdx]); }
                  }}/>
                <ReminderChip label={reminderLabel(DAY_REMINDERS[dayIdx])} accent={accent}
                  active={DAY_REMINDERS.includes(reminderLead)}
                  onClick={() => {
                    if (DAY_REMINDERS.includes(reminderLead)) {
                      const next = (dayIdx + 1) % DAY_REMINDERS.length;
                      setDayIdx(next); setReminderLead(DAY_REMINDERS[next]);
                    } else { setReminderLead(DAY_REMINDERS[dayIdx]); }
                  }}/>
              </div>
            </Field>

            <Field label="Linked page">
              {link ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
                    padding: '4px 10px', borderRadius: 999, fontSize: 11,
                    background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)',
                  }}>
                    <IconLink size={12}/>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{link}</span>
                  </span>
                  <button type="button" data-own-press className="candy-btn" data-shape="chip" onClick={() => { setLink(null); setLinkQuery(''); }}>
                    <span className="candy-face" style={{ fontSize: 10, padding: '3px 8px' }}>Clear</span></button>
                </div>
              ) : (
                <div style={{ position: 'relative' }}>
                  <input className="candy-input" value={linkQuery} onChange={e => setLinkQuery(e.target.value)}
                    placeholder="Search a vault page…" style={inputStyle}/>
                  {linkResults.length > 0 && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, marginTop: 4,
                      maxHeight: 168, overflowY: 'auto', borderRadius: 'var(--radius-md)',
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      boxShadow: 'var(--shadow-card)',
                    }}>
                      {linkResults.map(r => (
                        <button key={r.path} type="button"
                          onClick={() => { setLink(r.path.replace(/\.md$/, '')); setLinkResults([]); }}
                          style={{
                            display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            color: 'var(--text)', fontSize: 11,
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                          <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                          <div style={{ fontSize: 9, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.path}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Field>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '20px 18px', borderTop: '1px solid var(--border-soft)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexShrink: 0,
        }}>
          <div style={{ fontSize: 11, color: err ? '#e07b7b' : 'var(--text-faint)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {err || `Scheduling for ${ds}`}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <OutlinedBtn small onClick={() => { if (!busy) onClose(); }}>Cancel</OutlinedBtn>
            <PrimaryBtn small onClick={submit} disabled={busy} accent={accent}>
              {busy ? 'Saving…' : 'Create event'}
            </PrimaryBtn>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const inputStyle = {
  width: '100%', padding: '6px 10px', borderRadius: 'var(--radius-sm)',
  fontSize: 12, color: 'var(--text)', outline: 'none',
};

function Field({ label, action, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: action ? candyGap(4) : 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 22 }}>
        <div style={{
          fontSize: 12.5, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
          textTransform: 'uppercase', color: 'var(--text)', fontWeight: 700,
        }}>{label}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

function ReminderChip({ label, active, accent, onClick }) {
  return (
    <button type="button" data-own-press onClick={onClick} className="candy-btn" data-shape="chip">
      <span className="candy-face" style={{
        fontSize: 10, padding: '4px 10px',
        ...(active ? { borderColor: accent, color: accent, background: `color-mix(in oklch, ${accent} 14%, var(--surface))` } : null),
      }}>{label}</span></button>
  );
}

function TypePill({ type, active, accent, editing, confirming, onClick, onAskDelete, onCancelDelete, onConfirmDelete }) {
  if (confirming) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 8px',
        borderRadius: 999, border: '2px solid color-mix(in oklch, var(--surface), black 22%)',
        background: 'var(--surface-3)', color: 'var(--text)',
      }}>
        Delete {type.name}?
        <button type="button" data-own-press className="candy-btn is-danger" data-shape="chip" onClick={onConfirmDelete}
          title="Delete type"><span className="candy-face" style={{ fontSize: 10, padding: '2px 7px' }}>✓</span></button>
        <button type="button" data-own-press className="candy-btn" data-shape="chip" onClick={onCancelDelete}
          title="Keep type"><span className="candy-face" style={{ fontSize: 10, padding: '2px 7px' }}>✕</span></button>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <button type="button" data-own-press onClick={onClick} className="candy-btn" data-shape="chip">
        <span className="candy-face" style={{
          gap: 6, fontSize: 11, padding: '4px 10px',
          ...(active ? { borderColor: accent, color: 'var(--text)', background: `color-mix(in oklch, ${accent} 12%, var(--surface))` } : null),
        }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: type.color || 'var(--text-faint)', flexShrink: 0 }}/>
          {type.name}
        </span>
      </button>
      {editing && (
        <button type="button" data-own-press className="candy-btn is-danger" data-shape="chip" onClick={onAskDelete}
          aria-label={`Delete ${type.name}`} title={`Delete ${type.name}`}>
          <span className="candy-face" style={{ fontSize: 10, padding: '2px 6px', lineHeight: 1 }}>×</span></button>
      )}
    </span>
  );
}
