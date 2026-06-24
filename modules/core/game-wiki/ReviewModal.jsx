// Merge review (sub-plan 5). After a Classify run the AI returns one combined item per
// moment — the coach's notes folded in (conflicts flagged) plus every unmatched note
// echoed — and the coach edits / accepts / drops here. Save replaces the team's Notes
// with the kept items; dropped items are an explicit choice (still retained in the
// .autoclass provenance sidecar). Built on the shared AppWindow chrome. Rendered only
// while a review is active, so it mounts fresh per run (working copy seeded from items).
import { useState } from 'react';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { IconCheckCircle } from '@host/components/icons.jsx';
import { sortByTimeAsc } from './noteCompile.js';
import RetagButton from './RetagButton.jsx';

const initialText = (it) => (it.acceptedText != null ? it.acceptedText : `${it.subject ? it.subject + ' — ' : ''}${it.rationale || ''}`);
const buildWork = (items) => {
  const w = {};
  for (const it of items || []) w[it.momentId] = { label: it.userLabel || it.classification || null, text: initialText(it), dropped: !!it.dropped, accepted: it.review === 'accepted' };
  return w;
};

export default function ReviewModal({ accent, teamName, items, onSave, onClose }) {
  const [work, setWork] = useState(() => buildWork(items));
  const set = (id, patch) => setWork((w) => ({ ...w, [id]: { ...w[id], ...patch } }));
  const acceptAll = () => setWork((w) => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, { ...v, accepted: true, dropped: false }])));
  const ordered = sortByTimeAsc(items || [], (i) => i.atSec).ordered;
  const keptCount = (items || []).filter((it) => !work[it.momentId]?.dropped).length;

  const save = () => {
    const kept = [], dropped = [];
    for (const it of items || []) {
      const w = work[it.momentId] || {};
      if (w.dropped) dropped.push({ ...it, review: 'rejected', dropped: true });
      else kept.push({ ...it, userLabel: w.label ?? null, acceptedText: w.text ?? '', review: 'accepted', dropped: false });
    }
    onSave(kept, dropped);
  };

  return (
    <AppWindow open onClose={onClose} title={`Review & merge — ${teamName}`} icon={<IconCheckCircle size={18} />}
      accent={accent} width={760} height="min(82vh, 760px)"
      headerContent={<span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{keptCount} of {(items || []).length} kept</span>}
      footer={<>
        <button type="button" className="candy-btn" data-shape="chip" onClick={acceptAll}><span className="candy-face">Accept all</span></button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="candy-btn" data-shape="chip" onClick={onClose}><span className="candy-face">Cancel</span></button>
          <button type="button" className="candy-btn is-primary" data-shape="chip" onClick={save}><span className="candy-face">Save &amp; close</span></button>
        </div>
      </>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {ordered.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No moments or notes to review.</div>}
        {ordered.map((it) => {
          const w = work[it.momentId] || {};
          const dropped = !!w.dropped;
          return (
            <div key={it.momentId} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 10, border: '1px solid color-mix(in oklch, var(--text) 10%, transparent)', background: w.accepted && !dropped ? 'color-mix(in oklch, var(--accent) 9%, transparent)' : 'transparent', opacity: dropped ? 0.5 : 1 }}>
              <div style={{ width: 44, flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', paddingTop: 7 }}>{it.at || '—'}</div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <RetagButton label={w.label} onPick={(c) => set(it.momentId, { label: c })} allowClear />
                  {it.conflict && <span title={`AI said ${it.classification} · your note said ${it.noteClassification}`} style={{ fontSize: 10, color: 'var(--error)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700 }}>conflict</span>}
                  <span style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{it.source}</span>
                </div>
                <div className="candy-btn" data-shape="field" style={{ width: '100%' }}>
                  <input className="candy-face" value={w.text || ''} disabled={dropped} onChange={(e) => set(it.momentId, { text: e.target.value })} style={{ textDecoration: dropped ? 'line-through' : 'none' }} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0, paddingTop: 3 }}>
                <button type="button" className={`candy-btn${w.accepted && !dropped ? ' is-active' : ''}`} data-shape="chip" disabled={dropped}
                  onClick={() => set(it.momentId, { accepted: true, dropped: false })} title="Keep"><span className="candy-face">✓</span></button>
                <button type="button" className="candy-btn" data-shape="chip"
                  onClick={() => set(it.momentId, { dropped: !dropped, accepted: false })} title={dropped ? 'Restore' : 'Drop'}><span className="candy-face">{dropped ? '↩' : '✕'}</span></button>
              </div>
            </div>
          );
        })}
      </div>
    </AppWindow>
  );
}
