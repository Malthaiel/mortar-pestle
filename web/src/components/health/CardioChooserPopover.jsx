// Cardio chooser (Health Column epic, sub-plan 5). Compact Popover (clone of
// LogMealPopover's two-tab pattern):
//   • Preset — pick a saved preset → log its sequence as N independent `## Cardio`
//              bullets (each frozen + separately checkable). Right-click → Edit /
//              Delete. Footer → New preset (the combiner).
//   • Quick  — type + minutes + optional zone → log one cardio bullet, no page.
// Each bullet stores FROZEN numbers + no reference (snapshot by construction).
import { useState } from 'react';
import { api } from '../../api.js';
import { useContextMenu } from '../../context-menu/useContextMenu.js';
import Popover from '../ui/Popover.jsx';
import { IconPlus } from '../icons.jsx';

const labelStyle = { fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' };
const inputStyle = { background: 'var(--bg-elev)', border: '1px solid var(--border-soft)', borderRadius: 8, color: 'var(--text)', padding: '7px 9px', font: 'inherit', width: '100%' };

export default function CardioChooserPopover({ open, onClose, style, accent = 'var(--accent)', presets = [], pivotDs, onLogged, onEdit, onDelete, onNew }) {
  const { openContextMenu } = useContextMenu();
  const [mode, setMode] = useState('preset');
  const [qType, setQType] = useState('');
  const [qMin, setQMin] = useState(20);
  const [qZone, setQZone] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => { setQType(''); setQMin(20); setQZone(''); onClose(); };

  const applyPreset = async (p) => {
    if (busy) return;
    setBusy(true);
    try {
      for (const seg of (p.sequence || [])) {
        await api.health.logCardio(pivotDs, { type: seg.type, minutes: seg.duration, zone: seg.zone ?? null, done: false });
      }
      onLogged?.();
      close();
    } finally {
      setBusy(false);
    }
  };
  const logQuick = async () => {
    if (busy || !qType.trim()) return;
    setBusy(true);
    try {
      await api.health.logCardio(pivotDs, { type: qType.trim(), minutes: Number(qMin) || 0, zone: qZone.trim() || null, done: false });
      onLogged?.();
      close();
    } finally {
      setBusy(false);
    }
  };
  const presetMenu = (e, p) => openContextMenu(e, [
    { label: 'Edit…', onClick: () => { onEdit(p); close(); } },
    { label: 'Delete', danger: true, onClick: () => onDelete(p.file) },
  ], { accent });

  const rowBtn = { display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid var(--border-soft)', color: 'var(--text)', padding: '8px 10px', cursor: 'pointer', font: 'inherit', fontSize: 12.5 };
  const TabBtn = ({ id, children }) => (
    <button type="button" className={`candy-btn${mode === id ? ' is-active' : ''}`} data-shape="chip" onClick={() => setMode(id)}>
      <span className="candy-face">{children}</span>
    </button>
  );

  return (
    <Popover open={open} onClose={close} accent={accent} ariaLabel="Cardio" style={style} bodyStyle={{ padding: 12 }} outsideExempt=".health-cardio-trigger">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 300 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <TabBtn id="preset">Preset</TabBtn>
          <TabBtn id="quick">Quick</TabBtn>
        </div>

        {mode === 'preset' && (
          <>
            <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 8 }}>
              {presets.length === 0 && <div style={{ padding: 10, ...labelStyle }}>No presets yet — build one below.</div>}
              {presets.map((p) => {
                const mins = (p.sequence || []).reduce((a, s) => a + (Number(s.duration) || 0), 0);
                return (
                  <button key={p.id} type="button" disabled={busy} style={rowBtn} onClick={() => applyPreset(p)} onContextMenu={(e) => presetMenu(e, p)} title="Apply to today">
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                    <span style={labelStyle}>{p.sequence?.length || 0} seg · {mins}m</span>
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
              <button type="button" data-own-press className="candy-btn" data-shape="chip" onClick={() => { onNew(); close(); }}>
                <span className="candy-face"><IconPlus size={11} /> New preset</span>
              </button>
            </div>
          </>
        )}

        {mode === 'quick' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input style={inputStyle} value={qType} onChange={(e) => setQType(e.target.value)} placeholder="Type (Treadmill, Bike…)" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="number" min="0" value={qMin} onChange={(e) => setQMin(e.target.value)} style={{ ...inputStyle, width: 80, textAlign: 'right' }} />
              <span style={labelStyle}>min</span>
              <input style={{ ...inputStyle, flex: 1 }} value={qZone} onChange={(e) => setQZone(e.target.value)} placeholder="zone (opt)" />
            </div>
            <button type="button" className="candy-btn" data-shape="chip" disabled={busy || !qType.trim()} onClick={logQuick} style={{ alignSelf: 'flex-end', ...(qType.trim() ? {} : { opacity: 0.5 }) }}>
              <span className="candy-face">Log</span>
            </button>
          </div>
        )}
      </div>
    </Popover>
  );
}
