// Live scrim-notes overlay logic — extracted from the former standalone
// OverlayScrimView so the candy ScrimOverlayPanel (a draggable host panel) is a
// pure view. Everything here is cross-window-safe Tauri invoke/listen + the shared
// scrim schema/logic; nothing is React-context-bound, so it runs in the provider-
// less overlay host. Writes go through the SAME read-fresh -> mergeScrim -> savePage
// discipline (CONFLICT retry-once) the ScrimViewer uses, so the overlay and the
// main window share the scrim .md safely via the mtime guard.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { api } from '../api.js';
import { parseScrim, serializeScrim, mergeScrim, getNotes } from '@modules/core/game-wiki/scrimSchema.js';
import { parseTimedNote, formatTimedBullet, sortByTimeAsc } from '@modules/core/game-wiki/noteCompile.js';
import { clock } from '@modules/core/game-wiki/matchData.js';
import { useStopwatch } from '@modules/core/game-wiki/useStopwatch.js';

const SAVE_DEBOUNCE_MS = 600;

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

export function useScrimOverlay() {
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

  // ── Derived rows + row handlers (edits map back to the ORIGINAL bullet index) ──
  const rows = sortByTimeAsc(bullets.map((b, i) => ({ ...parseTimedNote(b), _i: i })), (x) => x.atSec).ordered;

  const onText = (row, raw) => {
    const m = /^\[(\d{1,2}):([0-5]\d)\]\s*/.exec(raw);
    const atSec = m ? Number(m[1]) * 60 + Number(m[2]) : row.atSec;
    const text = m ? raw.slice(m[0].length) : raw;
    writeBullets(bullets.map((b, j) => (j === row._i ? formatTimedBullet({ atSec, classification: row.classification, text }) : b)));
  };
  const onRetag = (row, c) => writeBullets(bullets.map((b, j) => (j === row._i ? formatTimedBullet({ atSec: row.atSec, classification: c || null, text: row.text }) : b)));
  const onDelete = (row) => writeBullets(bullets.filter((_, j) => j !== row._i));

  // Switch the live match: update local + Rust target (re-fires overlay_go_live,
  // which is a no-op re-show while the host is already visible — see state.rs).
  const selectMatch = (n) => {
    setMatchN(n); matchRef.current = n;
    const t = targetRef.current;
    if (t) invoke('overlay_go_live', { target: { scrimPath: t.scrimPath, matchN: n, coachedTeam: t.coachedTeam } }).catch(() => {});
  };
  const goOffline = () => invoke('overlay_go_offline').catch(() => {});

  return {
    target, matches: scrim?.matches || [], matchN, selectMatch, coachedTeam, goOffline,
    sw, rows, notesCount: bullets.length,
    dictating, liveText, draft, setDraft, addNote,
    onText, onRetag, onDelete, flash,
  };
}
