// Split chooser (Health Column epic, sub-plan 4). Compact Popover (clone of
// LogMealPopover + BlockLibraryPopover's right-click menu): list seed + custom
// splits, pick one to ACTIVATE — which first prompts "which cycle day are you on
// today?" to pin the anchor (locked: prompt-at-activation, avoids a wrong first
// day). Right-click → Edit / Delete. Footer → New split. The useWorkoutSplits
// instance is owned by FitnessSection and its callbacks passed down (single load).
// No "Open in Obsidian": the Library vault is app-managed, not an Obsidian vault.
import { useState } from 'react';
import { todayLocalStr } from '../../util/time.js';
import { useContextMenu } from '../../context-menu/useContextMenu.js';
import Popover from '../ui/Popover.jsx';
import { IconPlus, IconCheck } from '../icons.jsx';

const labelStyle = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' };

export default function SplitChooserPopover({ open, onClose, style, accent = 'var(--accent)', splits = [], onActivate, onEdit, onDelete, onNew }) {
  const { openContextMenu } = useContextMenu();
  const [pickFor, setPickFor] = useState(null); // split awaiting a "today is" pick

  const close = () => { setPickFor(null); onClose(); };
  const rowMenu = (e, s) => openContextMenu(e, [
    { label: 'Edit…', onClick: () => { onEdit(s); close(); } },
    { label: 'Delete', danger: true, onClick: () => onDelete(s.file) },
  ], { accent });
  const activate = (s, idx) => { onActivate(s.id, { anchorDate: todayLocalStr(), anchorIndex: idx }); close(); };

  const rowBtn = (active) => ({ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', background: active ? `color-mix(in oklch, ${accent} 16%, transparent)` : 'none', border: 'none', borderBottom: '1px solid var(--border-soft)', color: 'var(--text)', padding: '8px 10px', cursor: 'pointer', font: 'inherit', fontSize: 12.5 });

  return (
    <Popover open={open} onClose={close} accent={accent} ariaLabel="Workout splits" style={style} bodyStyle={{ padding: 12 }} outsideExempt=".health-split-trigger">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 300 }}>
        {pickFor ? (
          <>
            <span style={labelStyle}>Which day are you on today? — {pickFor.name}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {pickFor.cycle.map((label, idx) => (
                <button key={`${label}:${idx}`} type="button" className="candy-btn" data-shape="chip" onClick={() => activate(pickFor, idx)}>
                  <span className="candy-face">{label}{(pickFor.days?.[label] || []).length === 0 ? ' (rest)' : ''}</span>
                </button>
              ))}
            </div>
            <button type="button" className="candy-btn" data-shape="chip" onClick={() => setPickFor(null)} style={{ alignSelf: 'flex-start' }}>
              <span className="candy-face">Back</span>
            </button>
          </>
        ) : (
          <>
            <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 8 }}>
              {splits.length === 0 && <div style={{ padding: 10, ...labelStyle }}>No splits yet — make one with “New split”.</div>}
              {splits.map((s) => (
                <button key={s.id} type="button" style={rowBtn(s.active)} onClick={() => setPickFor(s)} onContextMenu={(e) => rowMenu(e, s)} title={s.active ? 'Active — click to re-pick today' : 'Activate'}>
                  {s.active ? <IconCheck size={12} /> : <span style={{ width: 12, flexShrink: 0 }} />}
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                  <span style={labelStyle}>{s.cycle.length}d</span>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
              <button type="button" data-own-press className="candy-btn" data-shape="chip" onClick={() => { onNew(); close(); }}>
                <span className="candy-face"><IconPlus size={11} /> New split</span>
              </button>
            </div>
          </>
        )}
      </div>
    </Popover>
  );
}
