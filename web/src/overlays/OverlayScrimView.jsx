// Overlay B — the persistent live scrim-notes panel, rendered in the always-on-top
// `overlay-scrim` window (hash #/overlay/scrim). Shown by the ScrimViewer's "Go
// Live" button (Rust `overlay_go_live` → window.show + `overlay-live-target`),
// it captures timestamped, classified notes straight into the active scrim's `.md`
// — typed or push-to-talk dictated — so they're waiting when the coach later
// reviews in the ScrimViewer.
//
// Standalone, transparent, over-the-game webview: no app chrome / theme context,
// so it's self-contained inline-styled (legibility over arbitrary game pixels).
// It REUSES the shared scrim LOGIC (scrimSchema / noteCompile / useStopwatch /
// classColors) — only the presentation differs from the candy-styled ScrimViewer.
// Writes go through the SAME save discipline (read-fresh → mergeScrim → savePage
// with a CONFLICT retry-once), so the overlay and the main window share the file
// safely via the mtime guard.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { api } from '../api.js';
import { parseScrim, serializeScrim, mergeScrim, getNotes } from '@modules/core/game-wiki/scrimSchema.js';
import { parseTimedNote, formatTimedBullet, sortByTimeAsc, CLASSIFICATIONS } from '@modules/core/game-wiki/noteCompile.js';
import { clock } from '@modules/core/game-wiki/matchData.js';
import { useStopwatch } from '@modules/core/game-wiki/useStopwatch.js';
import { classColor } from '@modules/core/game-wiki/classColors.js';

const SAVE_DEBOUNCE_MS = 600;
const ACCENT = '#6fa8d9';

function useTransparentRoot() {
  useEffect(() => {
    const html = document.documentElement, body = document.body;
    const prev = [html.style.background, body.style.background];
    html.style.background = 'transparent';
    body.style.background = 'transparent';
    return () => { html.style.background = prev[0]; body.style.background = prev[1]; };
  }, []);
}

// Replace the coached team's notes bullets on match `n` (creating the notes
// subsection before the first opaque section if absent) — mirrors ScrimViewer's
// team-keyed setNotes so one team's notes never clone onto the other.
function setTeamNotes(scrim, n, team, bullets) {
  return {
    ...scrim,
    matches: (scrim.matches || []).map((m) => {
      if (m.n !== n) return m;
      if ((m.subsections || []).some((s) => s.kind === 'notes' && s.team === team)) {
        return { ...m, subsections: m.subsections.map((s) => (s.kind === 'notes' && s.team === team ? { ...s, bullets } : s)) };
      }
      const subs = [...(m.subsections || [])];
      const firstOpaque = subs.findIndex((s) => s.kind === 'opaque');
      const note = { kind: 'notes', team, bullets };
      if (firstOpaque === -1) subs.push(note); else subs.splice(firstOpaque, 0, note);
      return { ...m, subsections: subs };
    }),
  };
}

export default function OverlayScrimView() {
  useTransparentRoot();

  const [target, setTarget] = useState(null); // { scrimPath, matchN, coachedTeam }
  const [scrim, setScrim] = useState(null);
  const [matchN, setMatchN] = useState(null);
  const [dictating, setDictating] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [draft, setDraft] = useState('');
  const [flash, setFlash] = useState(null);

  const scrimRef = useRef(null);
  const lastSavedRef = useRef(null);
  const saveTimer = useRef(null);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  const targetRef = useRef(null);
  const matchRef = useRef(null);
  const flashTimer = useRef(null);

  const showFlash = (m) => { setFlash(m); clearTimeout(flashTimer.current); flashTimer.current = setTimeout(() => setFlash(null), 2000); };

  // ── Save discipline (mirrors ScrimViewer.doSave) ──────────────────────────
  const doSave = useCallback(async () => {
    const local = scrimRef.current;
    const t = targetRef.current;
    if (!local || !t) return;
    if (savingRef.current) { pendingRef.current = true; return; }
    savingRef.current = true;
    try {
      let fresh = local, freshMtime = null;
      try { const r = await api.getRawFileMeta(t.scrimPath, 'gamewiki'); fresh = parseScrim(r.content); freshMtime = r.mtime ?? null; } catch { /* missing — write as-is */ }
      const content = serializeScrim(mergeScrim(local, fresh));
      if (content === lastSavedRef.current) { /* nothing changed */ }
      else {
        try {
          await api.savePage(t.scrimPath, content, freshMtime, 'gamewiki');
          lastSavedRef.current = content;
        } catch (e) {
          if (e?.code === 'CONFLICT') {
            const r2 = await api.getRawFileMeta(t.scrimPath, 'gamewiki');
            const content2 = serializeScrim(mergeScrim(scrimRef.current, parseScrim(r2.content)));
            await api.savePage(t.scrimPath, content2, r2.mtime ?? null, 'gamewiki');
            lastSavedRef.current = content2;
          } else throw e;
        }
      }
    } catch { showFlash('Save failed'); }
    finally { savingRef.current = false; if (pendingRef.current) { pendingRef.current = false; doSave(); } }
  }, []);

  const scheduleSave = useCallback(() => { clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => doSave(), SAVE_DEBOUNCE_MS); }, [doSave]);
  const applyEdit = useCallback((mutator) => {
    const next = mutator(scrimRef.current);
    scrimRef.current = next; setScrim(next); scheduleSave();
  }, [scheduleSave]);

  // ── Live-target binding: pull on mount (covers the show-before-listen race) +
  //    subscribe to updates. ──────────────────────────────────────────────────
  useEffect(() => {
    let un = null, cancelled = false;
    const apply = (t) => {
      if (cancelled) return;
      setTarget(t || null); targetRef.current = t || null;
      if (t) { setMatchN(t.matchN); matchRef.current = t.matchN; }
    };
    invoke('overlay_get_live_target').then(apply).catch(() => {});
    listen('overlay-live-target', (e) => apply(e.payload)).then((u) => { un = u; }).catch(() => {});
    return () => { cancelled = true; if (un) un(); };
  }, []);

  // Load the scrim file whenever the target path changes (flush the outgoing one).
  useEffect(() => {
    if (!target?.scrimPath) { setScrim(null); scrimRef.current = null; lastSavedRef.current = null; return undefined; }
    let cancelled = false;
    api.getRawFileMeta(target.scrimPath, 'gamewiki')
      .then((r) => {
        if (cancelled) return;
        const parsed = parseScrim(r.content);
        scrimRef.current = parsed; lastSavedRef.current = serializeScrim(parsed); setScrim(parsed);
      })
      .catch(() => { if (!cancelled) showFlash('Couldn’t open scrim'); });
    return () => { cancelled = true; clearTimeout(saveTimer.current); if (scrimRef.current && serializeScrim(scrimRef.current) !== lastSavedRef.current) doSave(); };
  }, [target?.scrimPath, doSave]);

  // Derived active-match context.
  const fm = scrim?.frontmatter || {};
  const coachedTeam = target?.coachedTeam || fm['Coached Team'] || fm['Team 1'] || '';
  const activeMatch = (scrim?.matches || []).find((m) => m.n === matchN) || null;
  const bullets = getNotes(activeMatch, coachedTeam)?.bullets || [];

  const sw = useStopwatch(`gw-overlay-sw:${target?.scrimPath || '_'}:m${matchN ?? 0}`);
  const swRef = useRef(sw); swRef.current = sw;

  // ── Note mutations ────────────────────────────────────────────────────────
  const writeBullets = useCallback((next) => {
    const t = targetRef.current, mn = matchRef.current;
    if (!t || mn == null) return;
    const team = t.coachedTeam || scrimRef.current?.frontmatter?.['Coached Team'] || scrimRef.current?.frontmatter?.['Team 1'] || '';
    applyEdit((p) => setTeamNotes(p, mn, team, next));
  }, [applyEdit]);

  const addNote = useCallback((text) => {
    const t = (text || '').trim(); if (!t) return;
    const w = swRef.current;
    const stamped = w.running ? `[${clock(w.elapsedRef.current)}] ${t}` : t;
    const cur = getNotes(scrimRef.current?.matches?.find((m) => m.n === matchRef.current), targetRef.current?.coachedTeam || scrimRef.current?.frontmatter?.['Coached Team'] || scrimRef.current?.frontmatter?.['Team 1'] || '')?.bullets || [];
    writeBullets([...cur, stamped]);
  }, [writeBullets]);

  // ── Dictation: while a scrim is live, the host reroutes the hotkey transcript
  //    here (overlay-dictation-committed) instead of Quick Notes. Segments give a
  //    best-effort live preview; the committed text is the authoritative note. ──
  useEffect(() => {
    const unsubs = [];
    listen('stt-dictation-started', () => { setDictating(true); setLiveText(''); }).then((u) => unsubs.push(u)).catch(() => {});
    listen('stt-segment', (e) => { const txt = e.payload?.text; if (typeof txt === 'string') setLiveText(txt); }).then((u) => unsubs.push(u)).catch(() => {});
    listen('overlay-dictation-committed', (e) => {
      const txt = e.payload?.text;
      setDictating(false); setLiveText('');
      if (txt && txt.trim()) { addNote(txt); showFlash('🎙 note added'); }
    }).then((u) => unsubs.push(u)).catch(() => {});
    return () => unsubs.forEach((u) => u && u());
  }, [addNote]);

  // ── Scoreboard coupling: a screenshot taken while live auto-fills the active
  //    match's Scoreboard field IF it's empty (non-empty is left untouched). ────
  useEffect(() => {
    let un = null;
    listen('capture-screenshot-saved', (e) => {
      const path = e.payload?.path; if (!path) return;
      const mn = matchRef.current; const m = scrimRef.current?.matches?.find((x) => x.n === mn);
      if (!m) return;
      if (String(m.fields?.['Scoreboard'] || '').trim()) return; // already set — don't clobber
      applyEdit((p) => ({ ...p, matches: p.matches.map((x) => (x.n === mn ? { ...x, fields: { ...x.fields, Scoreboard: path } } : x)) }));
      showFlash('🖼 scoreboard set');
    }).then((u) => { un = u; }).catch(() => {});
    return () => { if (un) un(); };
  }, [applyEdit]);

  useEffect(() => () => { clearTimeout(saveTimer.current); clearTimeout(flashTimer.current); }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  const panel = {
    position: 'fixed', inset: 0, padding: 8, display: 'flex', flexDirection: 'column',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: '#eef2f6',
  };
  const box = {
    flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
    background: 'rgba(16,20,26,0.84)', border: `1px solid ${ACCENT}55`, borderRadius: 14,
    padding: 12, backdropFilter: 'blur(7px)', boxShadow: '0 12px 34px rgba(0,0,0,0.55)',
  };
  const inputStyle = {
    width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)', color: '#eef2f6',
    border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '6px 8px',
    font: '13px/1.3 var(--font-mono, ui-monospace, monospace)', outline: 'none',
  };

  if (!target) {
    return (
      <div style={panel}><div style={box}>
        <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: 0.5, color: ACCENT }}>▣ SCRIM</div>
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>Not live. Open a scrim and click <b>Go Live</b> on a match.</div>
      </div></div>
    );
  }

  const ordered = sortByTimeAsc(bullets.map((b, i) => ({ ...parseTimedNote(b), _i: i })), (x) => x.atSec).ordered;
  const matches = scrim?.matches || [];

  const onText = (row, raw) => {
    const m = /^\[(\d{1,2}):([0-5]\d)\]\s*/.exec(raw);
    const atSec = m ? Number(m[1]) * 60 + Number(m[2]) : row.atSec;
    const text = m ? raw.slice(m[0].length) : raw;
    writeBullets(bullets.map((b, j) => (j === row._i ? formatTimedBullet({ atSec, classification: row.classification, text }) : b)));
  };
  const onRetag = (row, c) => writeBullets(bullets.map((b, j) => (j === row._i ? formatTimedBullet({ atSec: row.atSec, classification: c || null, text: row.text }) : b)));
  const onDelete = (row) => writeBullets(bullets.filter((_, j) => j !== row._i));

  return (
    <div style={panel}><div style={box}>
      {/* Header: title · match selector · go offline */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: 0.5, color: ACCENT }}>▣ SCRIM</span>
        <select
          value={matchN ?? ''}
          onChange={(e) => {
            const n = Number(e.target.value);
            setMatchN(n); matchRef.current = n;
            const t = targetRef.current;
            if (t) invoke('overlay_go_live', { target: { scrimPath: t.scrimPath, matchN: n, coachedTeam: t.coachedTeam } }).catch(() => {});
          }}
          style={{ ...inputStyle, width: 'auto', padding: '3px 6px', cursor: 'pointer' }}
        >
          {matches.map((m) => <option key={m.n} value={m.n}>Match {m.n}</option>)}
        </select>
        <span style={{ flex: 1, fontSize: 11, color: 'rgba(255,255,255,0.6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{coachedTeam}</span>
        <button onClick={() => invoke('overlay_go_offline').catch(() => {})} title="Go offline (hide overlay)"
          style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', color: '#eef2f6', borderRadius: 6, cursor: 'pointer', padding: '2px 7px', fontSize: 12 }}>✕</button>
      </div>

      {/* Timer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <button onClick={sw.toggle} title={sw.running ? 'Pause' : 'Start'}
          style={{ background: sw.running ? `${ACCENT}33` : 'rgba(255,255,255,0.08)', border: `1px solid ${ACCENT}66`, color: '#eef2f6', borderRadius: 8, cursor: 'pointer', padding: '4px 10px', fontSize: 12, fontWeight: 600 }}>
          {sw.running ? '⏸' : '▶'}
        </button>
        <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 18, fontWeight: 700, color: sw.running ? ACCENT : 'rgba(255,255,255,0.6)', minWidth: 58, textAlign: 'center' }}>{clock(sw.elapsedSec)}</span>
        <button onClick={sw.reset} title="Reset timer"
          style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)', color: '#eef2f6', borderRadius: 8, cursor: 'pointer', padding: '4px 10px', fontSize: 12 }}>↺</button>
        <span style={{ flex: 1, textAlign: 'right', fontSize: 11, color: dictating ? ACCENT : 'rgba(255,255,255,0.45)' }}>
          {dictating ? '🎙 listening…' : (flash || `${bullets.length} note${bullets.length === 1 ? '' : 's'}`)}
        </span>
      </div>

      {/* Notes list */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {ordered.map((row) => (
          <div key={row._i} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', minWidth: 38, fontVariantNumeric: 'tabular-nums' }}>{row.at || '—'}</span>
            <select value={row.classification || ''} onChange={(e) => onRetag(row, e.target.value)} title="Classification"
              style={{ ...inputStyle, width: 'auto', padding: '3px 4px', color: row.classification ? classColor(row.classification) : 'rgba(255,255,255,0.5)', cursor: 'pointer' }}>
              <option value="">tag</option>
              {CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <input style={{ ...inputStyle, flex: 1, minWidth: 0 }} value={row.text}
              onChange={(e) => onText(row, e.target.value)} placeholder="note…" />
            <button onClick={() => onDelete(row)} title="Remove"
              style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>×</button>
          </div>
        ))}
        {ordered.length === 0 && !dictating && (
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', padding: '8px 2px' }}>No notes yet — type below or hold your dictation key.</div>
        )}
      </div>

      {/* Note input (shows the live transcript while dictating) */}
      <input
        style={{ ...inputStyle, marginTop: 8, opacity: dictating ? 0.8 : 1 }}
        value={dictating ? liveText : draft}
        readOnly={dictating}
        placeholder={dictating ? 'listening…' : (sw.running ? `Add a note…  (stamped @ ${clock(sw.elapsedSec)})` : 'Add a note…')}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !dictating) { e.preventDefault(); addNote(draft); setDraft(''); } }}
      />
    </div></div>
  );
}
