// ScrimListLanding — the Coaching landing (Option C). Reached by clicking the
// Deadlock/Coaching/Scrim folder in the tree: lists every scrim, opens one on
// click, and creates a new scrim from a Team 1 / Team 2 form (writes the SF2
// skeleton via serializeScrim, then opens it in the ScrimViewer).

import { useCallback, useEffect, useState } from 'react';
import { api } from '@host/api.js';
import { navigate } from '@host/router.js';
import { encodePagePath } from '@host/components/SidebarBrowser.jsx';
import { IconPlus } from '@host/components/icons.jsx';
import { candyGap } from '@host/util/candy.js';
import { emptyScrim, serializeScrim } from './scrimSchema.js';

const SCRIM_DIR = 'Deadlock/Coaching/Scrim';

const wrap = { flex: 1, minHeight: 0, overflowY: 'auto' };
const inner = { maxWidth: 720, margin: '0 auto', padding: '20px 28px 64px', fontFamily: 'var(--font-mono)' };
const cardBox = {
  border: '1px solid color-mix(in oklch, var(--text) 12%, transparent)',
  background: 'color-mix(in oklch, var(--text) 4%, transparent)',
  borderRadius: 12, padding: 14, marginBottom: 16,
};

// Browser runtime — new Date() is available here (unlike the workflow sandbox).
function todayParts() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return { iso: `${yyyy}-${mm}-${dd}`, short: `${mm}-${dd}-${String(yyyy).slice(2)}` };
}

const sanitize = (name) => name.replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();

// "(06-16-26) Reliquary VS The Mafia" -> { date, title }
function parseTitle(base) {
  const m = base.match(/^\((\d{2}-\d{2}-\d{2})\)\s*(.*)$/);
  return m ? { date: m[1], title: m[2] } : { date: '', title: base };
}

export default function ScrimListLanding({ accent }) {
  const [scrims, setScrims] = useState(null);
  const [err, setErr] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [t1, setT1] = useState('');
  const [t2, setT2] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setErr(null);
    api.getVaultFolder('Deadlock', 'Coaching/Scrim', 'gamewiki')
      .then((res) => {
        const pages = (res?.pages || [])
          .map((p) => { const full = (p.path || '').replace(/^\/+/, '').replace(/\.md$/, ''); return { path: full, base: full.split('/').pop() }; })
          .sort((a, b) => b.base.localeCompare(a.base)); // date-prefixed → newest first
        setScrims(pages);
      })
      .catch((e) => { setErr(String(e?.message || e)); setScrims([]); });
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (busy) return;
    const team1 = sanitize(t1) || 'Team 1';
    const team2 = sanitize(t2) || 'Team 2';
    const { iso, short } = todayParts();
    let base = `(${short}) ${team1} VS ${team2}`;
    const existing = new Set((scrims || []).map((s) => s.base));
    if (existing.has(base)) { let n = 2; while (existing.has(`${base} (${n})`)) n++; base = `${base} (${n})`; }
    const path = `${SCRIM_DIR}/${base}.md`;
    const content = serializeScrim(emptyScrim({ team1, team2, coachedTeam: team1, date: iso }));
    setBusy(true);
    try {
      await api.savePage(path, content, 0, 'gamewiki');
      navigate('/game-wiki/' + encodePagePath(path.replace(/\.md$/, '')));
    } catch (e) {
      setErr(String(e?.message || e));
      setBusy(false);
    }
  };

  return (
    <div style={wrap}>
      <div style={{ ...inner, '--accent': accent }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>Coaching · Scrims</div>
          <button className="candy-btn" data-shape="chip" onClick={() => setShowForm((v) => !v)} title="New scrim">
            <span className="candy-face" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><IconPlus size={14} /> New Scrim</span>
          </button>
        </div>

        {showForm && (
          <div style={cardBox}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: candyGap(6, true) }}>
              <div className="candy-btn" data-shape="field">
                <input className="candy-face" autoFocus placeholder="Team 1 (coached)" value={t1}
                  onChange={(e) => setT1(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
              </div>
              <div className="candy-btn" data-shape="field">
                <input className="candy-face" placeholder="Team 2" value={t2}
                  onChange={(e) => setT2(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
              </div>
            </div>
            <button className="candy-btn" data-shape="chip" disabled={busy} onClick={create}>
              <span className="candy-face">{busy ? 'Creating…' : 'Create scrim'}</span>
            </button>
          </div>
        )}

        {err && <p style={{ color: 'var(--error)' }}>{err}</p>}
        {scrims == null && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}
        {scrims != null && scrims.length === 0 && !err && (
          <p style={{ color: 'var(--text-muted)' }}>No scrims yet — click <strong>+ New Scrim</strong> to start one.</p>
        )}
        {scrims != null && scrims.map((s) => {
          const { date, title } = parseTitle(s.base);
          return (
            <button key={s.path} className="candy-btn" data-shape="row"
              onClick={() => navigate('/game-wiki/' + encodePagePath(s.path))}
              style={{ width: '100%', marginBottom: 8 }}>
              <span className="candy-face">{title}{date ? `   ·   ${date}` : ''}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
