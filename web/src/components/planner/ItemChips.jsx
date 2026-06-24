// Shared Planner item chips — extracted verbatim from NotesPane so the
// unified DayPane and the (retiring) Unorganized sidebar widget render
// identical items. Deltas from the NotesPane originals, all opt-in via props:
//
//   TaskChip — optional `checked` display (muted + strikethrough, check button
//   becomes an uncheck), optional `onToggled(result)` callback (the day pane's
//   celebration hook point), pointer-drag onto the calendar for unchecked
//   tasks (startPaneDrag 'task' — drops create a 25-min session), and
//   `showDate` to drop the per-chip date when a group label already carries it.
//
//   NoteChip — hides "Carry forward to today" when the note already lives in
//   today's log (a self-move), plus the same `showDate` switch.

import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../../api.js';
import { useContextMenu } from '../../context-menu/useContextMenu.js';
import IdeaPickerModal from './IdeaPickerModal.jsx';
import NewIdeaModal from './NewIdeaModal.jsx';
import { IconX, IconCheck, IconExternal } from '../icons.jsx';
import { obsidianHrefForPath } from '../../util/obsidian.js';
import { todayLocalStr } from '../../util/time.js';
import { usePlanner } from '@modules/core/planner/PlannerProvider.jsx';

export function shortDate(ds) {
  if (!ds) return '';
  const d = new Date(`${ds}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function readLS(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writeLS(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// Horizontal row holding a chip-field chip and its out-of-chip action buttons.
// align-items:center seats the (smaller) action buttons vertically against the
// chip; each button carries its own explicit height (~25% under the chip) rather
// than stretching to it, so ✓ / ROUTE / × read as peer controls, not a segmented bar.
const CHIP_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '6px', width: '100%' };

// Press-and-hold (dwell) on a chip to pick it up for a calendar drag, while a
// quick click falls through to the live input's native focus (caret where
// clicked → edit). The ~180ms timer is the click-vs-grab discriminator: release
// before it fires and it was a click; hold past it and we hand off to
// startPaneDrag — which only reads button + client coords, then attaches its own
// move/up. A fast press-drag still selects text natively; only a deliberate hold
// grabs. `draggingRef` lets the chip swallow the post-pickup click so a hold
// released in place doesn't re-focus into edit. Pointer listeners are capture-
// phase + transient (added on mousedown, torn down on the timer / release).
const HOLD_MS = 180;
function useHoldDrag({ disabled, onPickup }) {
  const draggingRef = useRef(false);
  const onMouseDown = useCallback((e) => {
    if (e.button !== 0 || disabled) return;
    draggingRef.current = false;
    let x = e.clientX, y = e.clientY;
    const track = (ev) => { x = ev.clientX; y = ev.clientY; };
    const cleanup = () => {
      window.removeEventListener('pointermove', track, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
    };
    function finish() { if (timer) { clearTimeout(timer); timer = null; } cleanup(); }
    let timer = setTimeout(() => {
      timer = null;
      draggingRef.current = true;
      cleanup();                              // startPaneDrag owns move/up from here
      onPickup({ button: 0, clientX: x, clientY: y });
    }, HOLD_MS);
    window.addEventListener('pointermove', track, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
  }, [disabled, onPickup]);
  return { onMouseDown, draggingRef };
}

// A labeled section within a pane (TASKS / NOTES / a source-date group).
// Subordinate to the pane title — smaller, muted — so groups read as one list.
// `labelColor` lets the day pane's carryover groups wear the age tint.
export function Group({ label, children, labelColor = 'var(--text-muted)' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'calc(6px + var(--candy-depth-small))' }}>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: labelColor,
      }}>{label}</div>
      {children}
    </div>
  );
}

export function Subdued({ children }) {
  return (
    <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 0' }}>
      {children}
    </div>
  );
}

// A task from a daily log, rendered as a single always-live candy field — the
// chip IS the candy button. The checkbox toggles the source line via
// vault_toggle_task (api.noteActions.toggleTask raises a 5s undo toast); a quick
// click drops the caret to edit the task text in place; press-and-hold picks an
// unchecked task up as a calendar drag (25-min session via handleTaskDrop). The
// optional date opens the source daily log in Obsidian.
export function TaskChip({ path, line, text, sourceDate, checked = false, showDate = true, onToggled }) {
  const { startPaneDrag } = usePlanner();
  const [draft, setDraft] = useState(text);
  const doneRef = useRef(false);
  const inputRef = useRef(null);

  // Keep the live field synced to external edits (watcher refresh) unless the
  // user is mid-edit in this very input.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(text);
  }, [text]);

  const onToggle = async () => {
    const r = await api.noteActions.toggleTask({ path, line, text });
    onToggled?.(r);
  };
  const openSource = () => { window.location.href = obsidianHrefForPath(path); };

  // Commit on blur / Enter; the doneRef guard (reset on focus) collapses the
  // Enter-then-blur double-fire. Esc reverts and bails via the same guard.
  const commit = async () => {
    if (doneRef.current) return; doneRef.current = true;
    const v = draft.trim();
    if (v === text) return;                                   // no change
    if (v === '') { await api.noteActions.deleteTask({ path, line, text }); return; }
    await api.noteActions.editTask({ path, line, text, newText: v });
  };
  const cancel = () => { doneRef.current = true; setDraft(text); inputRef.current?.blur(); };

  const hold = useHoldDrag({
    disabled: checked,
    onPickup: (ev) => {
      inputRef.current?.blur();
      window.getSelection?.()?.removeAllRanges?.();
      startPaneDrag('task', { taskName: text }, text, ev);
    },
  });

  return (
    <div style={CHIP_ROW_STYLE}>
      <span
        className="candy-btn"
        data-shape="chip-field"
        data-checked={checked ? 'true' : undefined}
        title={checked ? undefined : 'Click to edit · hold and drag onto the calendar to schedule'}
        onMouseDown={hold.onMouseDown}
        style={{ flex: 1 }}
      >
        <span className="candy-face">
          <input
            ref={inputRef}
            className="chip-field-input"
            value={draft}
            spellCheck={false}
            onChange={e => setDraft(e.target.value)}
            onFocus={() => { doneRef.current = false; }}
            onClick={() => { if (hold.draggingRef.current) { hold.draggingRef.current = false; inputRef.current?.blur(); } }}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); inputRef.current?.blur(); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
            }}
          />
          {showDate && (
            <span
              onClick={openSource}
              title="Open source log"
              onMouseDown={(e) => e.stopPropagation()}
              style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, cursor: 'pointer' }}
            >{shortDate(sourceDate)}</span>
          )}
        </span>
      </span>

      {/* ✓ toggle — moved out of the chip face; icon shape hovers to accent. */}
      <ChipIconBtn
        title={checked ? 'Uncheck task' : 'Check off task'}
        active={checked}
        onClick={onToggle}
      ><IconCheck size={12} /></ChipIconBtn>

      {/* ✕ delete — circle; reuses deleteTask (5s undo toast). Icon shape → accent on hover. */}
      <ChipIconBtn
        round
        title="Delete task"
        onClick={() => api.noteActions.deleteTask({ path, line, text })}
      ><IconX /></ChipIconBtn>
    </div>
  );
}

export function NoteChip({ text, sourceDate, index, showDate = true }) {
  const ds = sourceDate;
  const { openContextMenu } = useContextMenu();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newIdeaOpen, setNewIdeaOpen] = useState(false);
  const [draft, setDraft] = useState(text);
  const doneRef = useRef(false);
  const inputRef = useRef(null);
  const lastIdeaPath = readLS('planner:lastIdeaPath');
  const lastIdeaName = readLS('planner:lastIdeaName');
  const { startPaneDrag } = usePlanner();

  const onDelete = () => { api.noteActions.deleteNote({ ds, index, text }); };

  // Keep the live field synced to external edits (watcher refresh) unless the
  // user is mid-edit in this very input.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(text);
  }, [text]);

  // Commit on blur / Enter; the doneRef guard (reset on focus) collapses the
  // Enter-then-blur double-fire. Esc reverts and bails via the same guard.
  const commit = async () => {
    if (doneRef.current) return; doneRef.current = true;
    const v = draft.trim();
    if (v === text) return;                                   // no change
    if (v === '') { await api.noteActions.deleteNoteInline({ ds, index, text }); return; }
    await api.noteActions.editNote({ ds, index, text, newText: v });
  };
  const cancel = () => { doneRef.current = true; setDraft(text); inputRef.current?.blur(); };

  const hold = useHoldDrag({
    disabled: false,
    onPickup: (ev) => {
      inputRef.current?.blur();
      window.getSelection?.()?.removeAllRanges?.();
      startPaneDrag('note', { text, sourceDate, sourceAnchor: 'Quick Notes' }, text, ev);
    },
  });

  const doMove = (page) => {
    if (!page?.path) return;
    writeLS('planner:lastIdeaPath', page.path);
    writeLS('planner:lastIdeaName', page.title || page.name || '');
    api.noteActions.moveNoteToIdea({ ds, index, text, ideaPath: page.path });
  };
  const copyText = () => { try { navigator.clipboard?.writeText(text); } catch { /* ignore */ } };
  const openSourceLog = () => {
    window.location.href = obsidianHrefForPath(`Pulse/Daily Logs/${ds}.md`);
  };

  // A note already living in today's log can't be "carried forward to today".
  const isOwnToday = ds === todayLocalStr();
  const menuItems = [
    { section: true, label: 'Standard' },
    { label: 'Move to an Idea…', onClick: () => setPickerOpen(true) },
    ...(lastIdeaPath
      ? [{ label: `Re-file to ${lastIdeaName || 'last Idea'}`, onClick: () => doMove({ path: lastIdeaPath, title: lastIdeaName }) }]
      : []),
    { label: 'Copy text', onClick: copyText },
    { label: 'Open source log', onClick: openSourceLog },
    { divider: true },
    { section: true, label: 'Creative' },
    ...(isOwnToday ? [] : [{ label: 'Carry forward to today', onClick: () => api.noteActions.carryForward({ ds, index, text }) }]),
    { label: 'Convert to a task', onClick: () => api.noteActions.convertToTask({ ds, index, text }) },
    { label: 'New stub Idea…', onClick: () => setNewIdeaOpen(true) },
  ];

  return (
    <div style={CHIP_ROW_STYLE}>
      <span
        className="candy-btn"
        data-shape="chip-field"
        title="Click to edit · hold and drag onto the calendar to promote into a session"
        onMouseDown={hold.onMouseDown}
        style={{ flex: 1 }}
      >
        <span className="candy-face">
          <input
            ref={inputRef}
            className="chip-field-input"
            value={draft}
            spellCheck={false}
            onChange={e => setDraft(e.target.value)}
            onFocus={() => { doneRef.current = false; }}
            onClick={() => { if (hold.draggingRef.current) { hold.draggingRef.current = false; inputRef.current?.blur(); } }}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); inputRef.current?.blur(); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
            }}
          />
          {showDate && (
            <span
              onMouseDown={(e) => e.stopPropagation()}
              style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}
            >{shortDate(sourceDate)}</span>
          )}
        </span>
        <IdeaPickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onPick={(page) => { setPickerOpen(false); doMove(page); }}
        />
        <NewIdeaModal
          open={newIdeaOpen}
          noteText={text}
          onClose={() => setNewIdeaOpen(false)}
          onCreate={({ title, domain }) => { setNewIdeaOpen(false); api.noteActions.createStubIdea({ ds, index, text, title, domain }); }}
        />
      </span>

      {/* ROUTE + × moved out of the chip face; icon shape hovers to accent. */}
      <ChipIconBtn
        title="Route this note…"
        onClick={(e) => {
          // Anchor below the ROUTE button (a left-click trigger, not a right-click);
          // openContextMenu accepts a {x,y} point for non-event callers like this.
          const r = e.currentTarget.getBoundingClientRect();
          openContextMenu({ x: r.left, y: r.bottom + 6 }, menuItems);
        }}
      ><IconExternal size={13} /></ChipIconBtn>
      <ChipIconBtn round title="Delete note" onClick={onDelete}><IconX /></ChipIconBtn>
    </div>
  );
}

// Out-of-chip icon action button for a Planner row (✓ / ROUTE / ×). Uses
// data-shape="icon"; the icon shape's hover is neutral-brighten by design
// (styles.css:1686-1688, specificity beats the generic accent rule 2030 — the
// dock's hover-expand is the affordance, accent is the .is-active state), so
// `is-hover-accent` opts these three buttons INTO an accent fill on hover
// (styles.css override, gated :not(.is-active) so the checked ✓ keeps its
// held-accent rest state). `round` makes the delete × a circle; `active` holds
// the accent fill for the checked ✓. `data-own-press` opts out of the global
// :active scale; the mousedown stop keeps a click from starting the chip drag.
export function ChipIconBtn({ title, onClick, round, active, children }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-own-press
      className={`candy-btn is-hover-accent${active ? ' is-active' : ''}`}
      data-shape="icon"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
      style={{ flexShrink: 0, width: 23, height: 23, borderRadius: round ? '50%' : 6, '--cbtn-depth': 'var(--candy-depth-small)' }}
    ><span className="candy-face">{children}</span></button>
  );
}
