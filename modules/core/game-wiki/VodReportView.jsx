// VodReportView — the VOD Review Report popup (Deadlock Scrim Coaching, sub-plan 11). Mirrors
// MatchViewPopup's chrome exactly: AppWindow + a left rail of text-only candy-btn rows + a content
// pane, only the active section shown. Reads the .vodreport sidecar (the report object is the source
// of truth), renders each section, and persists the coach's done/pending checkbox toggles straight
// back to the sidecar (app-owned, single-writer → null-mtime overwrite). Degrades: missing sidecar →
// "generate first" prompt; bad JSON → error. New component approved 2026-07-09 (reuses AppWindow +
// candy-btn + native checkboxes — no new primitive).
//
// VOD Report Sections rework (2026-07-13): the 'tldr' tab id is the full Report page (TL;DR itself retired 2026-07-19) —
// dynamic AI-invented sections rendered as GFM markdown (react-markdown + remark-gfm + .gamewiki-md,
// the GameWikiPage pattern). [m:ss] tokens everywhere (sections, Action Items, Q&A) render as
// clickable TimeChips that jump to the Segments tab, scroll the moment into view, and flash it with
// the shared .settings-search-flash class (SettingsDrawer jump mechanic). Rail gains Regenerate +
// Add Notes actions (handlers owned by ScrimViewer).
//
// Analyst v2 (2026-07-13, Moves 12-13): schema-v2 layered tabs (Player Cards / Macro / Comms Grade,
// per-card expanders), a meta.warnings bar, inline verify-pass flags, and per-item correction
// controls (Wrong / Edit / Note — text labels only, no glyphs) writing append-only to the
// .vodfeedback sidecar. AI text is never overwritten — coach corrections render BESIDE it, and
// entries whose ref no longer resolves after a regenerate surface in an "Unmatched corrections"
// drawer, never silently dropped. Header gains "Ask Analyst" (AppWindow headerActions) opening the
// Analyst chat pointed at this scrim. Old v1 sidecars render via coerceReport defaults.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, invoke } from '@host/api.js';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { candyGap } from '@host/util/candy.js';
import { IconFileText } from '@host/components/icons.jsx';
import TreeSidebar from '@host/components/vault-tree/TreeSidebar.jsx';
import { useTreeExpansion } from '@host/components/vault-tree/useTreeExpansion.js';
import { parseSegments } from './commsCompile.js';
import { speakerColor } from './diarize.js';
import Popover from '@host/components/ui/Popover.jsx';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import { coerceReport, slugId, transcriptHash, applyCorrections, mmss } from './vodReport.js';
import { openAnalyst } from '@host/agents/analyst/AnalystProvider.jsx';

const muted = { color: 'var(--text-muted)', fontSize: 13 };
const macroBtnCluster = { flexShrink: 0, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center' };

function RailButton({ active, accent, onClick, disabled, children, ...rest }) {
  return (
    <button type="button" onClick={onClick} data-own-press disabled={disabled}
      className={`candy-btn${active ? ' is-active' : ''}`} data-shape="row"
      style={accent ? { '--accent': accent } : undefined} {...rest}>
      <span className="candy-face"><span style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>{children}</span></span>
    </button>
  );
}

// m:ss stamp as a clickable candy chip — click jumps to the Segments tab and flashes the moment.
// One behavior for every stamp in the popup (sections, Action Items, Q&A).
function TimeChip({ t, onJump }) {
  if (!t) return null;
  return (
    <button type="button" data-own-press className="candy-btn" data-shape="chip"
      title={`Jump to ${t} in Segments`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onJump?.(t); }}
      style={{ verticalAlign: 'baseline', marginRight: 4, '--cbtn-depth': 'calc(var(--candy-depth-small) * 0.9375)' }}>
      <span className="candy-face" style={{ fontSize: 11, fontFamily: 'var(--font-mono)', padding: '1px 5px', lineHeight: 1.25 }}>{t}</span>
    </button>
  );
}

// Turn literal [m:ss] / [h:mm:ss] tokens into markdown links (#seg-<t>) so react-markdown's `a`
// override can render them as TimeChips. Fence-aware (mirror GameWikiPage.transformWikilinks): code
// spans/blocks pass through untouched. `(?!\()` leaves real markdown links like [1:15](url) alone.
// The optional third group matches the hour form mmss() emits past 1:00:00; older sidecars stored
// bare `60:44` for the same moment and still match the two-part form.
export function linkTimeTokens(md) {
  return String(md ?? '')
    .split(/(```[\s\S]*?```|`[^`]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/\[(\d+:\d{2}(?::\d{2})?)\](?!\()/g, '[$1](#seg-$1)')))
    .join('');
}

function Empty({ children }) { return <div style={muted}>{children}</div>; }

// Stable content-derived refs for per-item corrections (Move 13) — the same discipline as
// reconcileReport's stable action-item ids, so a regenerate that keeps the content keeps the ref.
// Entries whose ref stops resolving surface in the Unmatched-corrections drawer, never dropped.
const REF = {
  action: (it) => `action:${it.id}`,
  pcField: (c, f) => `pc:${c.hero || c.player}:${f}`,
  death: (c, d) => `pc:${c.hero || c.player}:death:${d.t}`,
  drill: (c, text) => `pc:${c.hero || c.player}:drill:${slugId(text)}`,
  tempoRead: 'macro:tempoRead',
  laneMap: 'macro:laneMap',
  objective: (w) => `macro:objective:${w.t}`,
  swing: (s) => `macro:swing:${s.t}`,
  overall: 'comms:overall',
  callout: (c) => `comms:callout:${c.t}:${c.who}`,
  missed: (text) => `comms:missed:${slugId(text)}`,
};

// Every ref the current report can render — feedback entries outside this set are "unmatched".
function collectRefs(r) {
  const s = new Set([REF.tempoRead, REF.laneMap, REF.overall]);
  for (const it of r.actionItems || []) s.add(REF.action(it));
  for (const c of r.playerCards || []) {
    for (const f of ['laneVerdict', 'soulsCurveRead', 'itemCritique', 'coaching']) s.add(REF.pcField(c, f));
    for (const d of c.deathAnalysis || []) s.add(REF.death(c, d));
    for (const t of c.drills || []) s.add(REF.drill(c, t));
  }
  for (const w of r.macro?.objectiveWindows || []) s.add(REF.objective(w));
  for (const x of r.macro?.swings || []) s.add(REF.swing(x));
  for (const c of r.commsGrade?.callouts || []) s.add(REF.callout(c));
  for (const m of r.commsGrade?.missed || []) s.add(REF.missed(m));
  return s;
}

const KIND_LABEL = { wrong: 'Marked wrong', edit: 'Coach edit', note: 'Note' };

// tweak 4 (redesigned 2026-07-13): per-item correction collapsed to ONE "Mark" chip placed left of
// the text — row order is [timestamp] Mark text (single-value sections read "Mark  TEMPO"). Click opens
// a popover (Wrong toggle + Edit + Note + Save/Clear); the chip carries the mark state (Mark / Wrong=red
// / Edit / Note=accent). The edit/note text renders as a single muted line under the row (MarkLine);
// Wrong has no line — the red chip IS the indicator. One edit + one note per ref (Save replaces). The
// .vodfeedback schema, REF.*, and collectRefs are unchanged, so the Unmatched-corrections drawer still
// works; preventDefault/stopPropagation mirrors TimeChip (these can render inside the action-item label).
function MarkChip({ refId, aiText, entries, accent, onOpen, active }) {
  const mine = (entries || []).filter((e) => e.ref === refId);
  const wrong = mine.some((e) => e.kind === 'wrong');
  const hasEdit = mine.some((e) => e.kind === 'edit');
  const hasNote = mine.some((e) => e.kind === 'note');
  const label = wrong ? 'Wrong' : hasEdit ? 'Edit' : hasNote ? 'Note' : 'Mark';
  const color = wrong ? 'var(--error)' : (hasEdit || hasNote) ? (accent || 'var(--accent)') : 'var(--text-muted)';
  return (
    <button type="button" data-own-press data-mark-trigger className={`candy-btn${active ? ' is-active' : ''}`} data-shape="chip"
      title="Mark this item: Wrong / Edit / Note"
      style={{ verticalAlign: 'baseline', marginRight: 8, '--cbtn-depth': 'calc(var(--candy-depth-small) * 0.9375)' }}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpen(refId, aiText, e); }}>
      <span className="candy-face" style={{ fontSize: 11, padding: '1px 5px', lineHeight: 1.25, color }}>{label}</span>
    </button>
  );
}

// The coach's edit/note text for one ref, as muted lines under the row. Wrong has no line (chip is it).
function MarkLine({ refId, entries }) {
  const mine = (entries || []).filter((e) => e.ref === refId);
  const edit = mine.find((e) => e.kind === 'edit');
  const note = mine.find((e) => e.kind === 'note');
  if (!edit && !note) return null;
  return (
    <div style={{ marginTop: 3 }}>
      {edit && <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2, borderLeft: '2px solid var(--accent)', paddingLeft: 6 }}>edit: {edit.userText}</div>}
      {note && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, borderLeft: '2px solid var(--border)', paddingLeft: 6 }}>note: {note.userText}</div>}
    </div>
  );
}

// The Mark popover body: a Wrong toggle chip + an Edit textarea + a Note textarea + Save/Clear. Save
// writes one-of-each for the ref (replaces); Clear wipes all marks for the ref. Remounted per ref via key.
function MarkPopoverBody({ refId, aiText, entries, accent, onSave, onClose }) {
  const mine = (entries || []).filter((e) => e.ref === refId);
  const [wrong, setWrong] = useState(mine.some((e) => e.kind === 'wrong'));
  const [edit, setEdit] = useState(mine.find((e) => e.kind === 'edit')?.userText ?? String(aiText ?? ''));
  const [note, setNote] = useState(mine.find((e) => e.kind === 'note')?.userText ?? '');
  const inputStyle = { width: '100%', fontSize: 12, fontFamily: 'inherit', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', resize: 'vertical' };
  const commit = (v) => { onSave(v); onClose(); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button type="button" data-own-press className={`candy-btn${wrong ? ' is-active' : ''}`} data-shape="chip"
        onClick={() => setWrong((w) => !w)}
        style={{ '--cbtn-depth': 'calc(var(--candy-depth-small) * 0.75)', ...(wrong ? { '--accent': 'var(--error)' } : {}) }}>
        <span className="candy-face" style={{ fontSize: 11, padding: '1px 5px', lineHeight: 1.25, color: wrong ? 'var(--error)' : 'var(--text-2)' }}>Wrong{wrong ? ' (on)' : ''}</span>
      </button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>Edit</span>
        <textarea value={edit} onChange={(e) => setEdit(e.target.value)} rows={2} style={inputStyle} placeholder="Corrected text (kept beside the AI text)" />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>Note</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} style={inputStyle} placeholder="Attach a note" />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 2 }}>
        <OutlinedBtn small onClick={() => commit({ wrong: false, edit: '', note: '' })}>Clear</OutlinedBtn>
        <PrimaryBtn small accent={accent} onClick={() => commit({ wrong, edit: edit.trim(), note: note.trim() })}>Save</PrimaryBtn>
      </div>
    </div>
  );
}

// Inline verify-pass flags (Move 12): Pass-2 findings whose ref targets this report path.
function FindingList({ findings, path }) {
  const hits = (findings || []).filter((f) => f.ref === path || f.ref.startsWith(`${path}.`) || f.ref.startsWith(`${path}[`));
  return hits.map((f, i) => (
    <div key={i} style={{ fontSize: 11.5, color: 'var(--error)', marginTop: 2 }}>
      Verify flag: "{f.issue}"{f.fix ? ` should be "${f.fix}"` : ''}{f.evidence ? ` (${f.evidence})` : ''}
    </div>
  ));
}

// A candy card for one macro body (Tempo / Lane map / one objective window / one swing). Rides the
// right-sidebar music player's EXACT shell — the same `.candy-btn.music-tile[data-shape="tile"]` +
// container-type wrapper + candy-face setup as MusicPlayerWidget.jsx — with report prose as the
// content. Deviations forced by the content: height auto (prose cards, not the fixed 200·tile-px
// player) and an inline accent face when the card's mark is active (the tile shape's rest face
// out-ranks the generic .is-active fill). The whole card is the Mark trigger — inner TimeChip keeps
// its own jump action via stopPropagation + the music-tile pointer-events whitelist.
function MacroCard({ refId, aiText, active, onOpen, style, children }) {
  return (
    <div style={{ containerType: 'inline-size', width: '100%' }}>
      <div className={`candy-btn music-tile${active ? ' is-active' : ''}`} data-shape="tile" role="button" tabIndex={0}
        style={{ height: 'auto', ...style }}
        title="Mark this item: Wrong / Edit / Note"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.preventDefault(); onOpen(refId, aiText, e); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(refId, aiText, e); } }}>
        <div className="candy-face" style={{
          display: 'flex', flexDirection: 'column',
          width: '100%', height: '100%',
          padding: 'calc(12 * var(--tile-px))', gap: 'calc(10 * var(--tile-px))',
          boxSizing: 'border-box', textAlign: 'left',
          // Prose, not a button label: the face's 11px label default would shrink
          // the report text (the tile shape resets family/weight/case but not size).
          fontSize: 'inherit', fontWeight: 400,
          ...(active ? { background: 'var(--accent)' } : null),
        }}>{children}</div>
      </div>
    </div>
  );
}

function Labeled({ label, mark, children }) {
  // Header unified to the report section-header size (tweak 3): same fontSize/weight as .gamewiki-md h2.
  // tweak 4 (redesigned): the Mark chip renders inline BEFORE the label (row order [timestamp] Mark text,
  // so a single-value section reads "Mark  TEMPO"). Inline flow + vertical-align baseline (the TimeChip
  // pattern) — not a flex row — so the chip's shadow band clears the header text without centering drift.
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 16, fontWeight: 650, lineHeight: 1.3, color: 'var(--text)' }}>{mark}{label}</div>
      <div style={{ fontSize: 13.5, marginTop: 4 }}>{children}</div>
    </div>
  );
}

// ReportArtifactTree — the artifact file tree, built on the shared TreeSidebar default
// (feed it nodes + controller + buttons; the shell owns the toolbar band, scroll body,
// cascade, and candy pills). Two folder groups (Report / Coaching) drive the tab state;
// three reveal-leaves (Scrim page / Comms transcript / Feedback sidecar) call
// coaching_reveal_path. Was a ~55-line hand-rolled clone of the shell — now a config.
function ReportArtifactTree({ tabs, tab, onTab, accent, reveal }) {
  const exp = useTreeExpansion('vodreport:tree', ['report']); // Report open, Coaching collapsed
  const controller = { ...exp, expandAll: () => exp.expandAll(['report', 'coaching']) };
  const revealPath = (p) => p && invoke('coaching_reveal_path', { path: p })
    .catch((e) => console.error('coaching_reveal_path failed:', e));
  const group = (id, label, ids) => ({
    id, label, isFolder: true,
    children: tabs.filter((t) => ids.includes(t.id)).map((t) => ({
      id: t.id, label: t.label, active: tab === t.id, onActivate: () => onTab(t.id),
    })),
  });
  const leaf = (id, label, path) => ({
    id, label, leadIcon: <IconFileText size={18} />, onActivate: () => revealPath(path),
  });
  const nodes = [
    group('report', 'Report', ['tldr', 'players', 'macro', 'comms']),
    group('coaching', 'Coaching', ['actions', 'qa', 'keep', 'debates', 'followups', 'segments']),
    leaf('scrim', 'Scrim page', reveal.mdPath),
    leaf('comms', 'Comms transcript', reveal.commsPath),
    leaf('feedback', 'Feedback sidecar', reveal.feedbackPath),
  ];
  const buttons = {
    collapse: { show: true },
    revealInFiles: { show: !!reveal.mdPath, title: 'Reveal scrim file', onClick: () => revealPath(reveal.mdPath) },
  };
  return <TreeSidebar nodes={nodes} controller={controller} buttons={buttons} accent={accent} />;
}

export default function VodReportView({ sidecarPath, commsPath, normPath, feedbackPath, mdPath, accent, onClose, onRegenerate, onAddNotes, inline = false, tab: tabProp, onTabChange, onTabsChange }) {
  const [state, setState] = useState({ status: 'loading' });
  const [report, setReport] = useState(null);
  const [segments, setSegments] = useState(null); // null = loading, [] = none/unavailable
  const [tab, setTabInternal] = useState('tldr');
  // Inline mode (embedded in ScrimViewer's tree): the parent owns the active tab.
  // Sync from the parent's `tab` prop, and echo internal switches (e.g. a segment
  // jump) back up. Popup mode ignores the prop and self-manages.
  const setTab = useCallback((t) => { setTabInternal(t); if (inline) onTabChange?.(t); }, [inline, onTabChange]);
  useEffect(() => { if (inline && tabProp && tabProp !== tab) setTabInternal(tabProp); }, [inline, tabProp, tab]);
  const [reloadKey, setReloadKey] = useState(0); // bumped after a Regenerate to re-read the sidecar
  const [busy, setBusy] = useState(''); // '' | 'regen' | 'notes'
  const paneRef = useRef(null); // content pane — jump target lookup root
  const pendingJumpRef = useRef(null); // m:ss awaiting the Segments tab to be visible
  // Per-item corrections (.vodfeedback sidecar, append-only) + the Player-Cards expander set.
  const [feedback, setFeedback] = useState({ entries: [] });
  const [openCards, setOpenCards] = useState(() => new Set());
  // Mark popover (tweak 4 redesign): one popover for the whole popup, anchored to the clicked chip.
  const [markTarget, setMarkTarget] = useState(null); // { refId, aiText } the open popover edits
  const [markAnchor, setMarkAnchor] = useState(null); // chip bounding rect
  const [markOpen, setMarkOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api.getRawFileMeta(sidecarPath, 'gamewiki')
      .then((r) => {
        if (cancelled) return;
        let raw;
        try { raw = JSON.parse(r.content); } catch { setState({ status: 'parse-error' }); return; }
        setReport(coerceReport(raw)); // v1 sidecars gain safe v2 defaults — no undefined-access
        setState({ status: 'ready' });
      })
      .catch(() => { if (!cancelled) setState({ status: 'missing' }); });
    return () => { cancelled = true; };
  }, [sidecarPath, reloadKey]);

  // Diarized segments the report was built from (.vodcomms sidecar) — read-only here;
  // relabeling lives in ScrimViewer's CommsTranscriptView. Missing/bad → [] (degrades to a gap).
  // Pass 0's proper-noun corrections (.vodnorm) are overlaid at render time so the Segments tab
  // and TimeChip jumps show canonical hero/item names — non-destructive, the raw .vodcomms is
  // never rewritten. Hash-gated: stale corrections (transcript re-extracted) are ignored, not applied.
  useEffect(() => {
    if (!commsPath) { setSegments([]); return undefined; }
    let cancelled = false;
    setSegments(null);
    (async () => {
      let segs;
      try { segs = parseSegments((await api.getRawFileMeta(commsPath, 'gamewiki')).content); }
      catch { if (!cancelled) setSegments([]); return; }
      if (normPath) {
        try {
          const c = JSON.parse((await api.getRawFileMeta(normPath, 'gamewiki')).content);
          if (c.hash === transcriptHash(segs) && Array.isArray(c.corrections)) segs = applyCorrections(segs, c.corrections).segments;
        } catch { /* no norm cache → show raw */ }
      }
      if (!cancelled) setSegments(segs);
    })();
    return () => { cancelled = true; };
  }, [commsPath, normPath]);

  // Load the .vodfeedback sidecar (missing → empty). Writes are whole-file JSON like .vodreport.
  useEffect(() => {
    if (!feedbackPath) return undefined;
    let cancelled = false;
    api.getRawFileMeta(feedbackPath, 'gamewiki')
      .then((r) => {
        if (cancelled) return;
        try { const j = JSON.parse(r.content); setFeedback({ entries: Array.isArray(j.entries) ? j.entries : [] }); } catch { /* unreadable → start fresh */ }
      })
      .catch(() => { /* first correction creates it */ });
    return () => { cancelled = true; };
  }, [feedbackPath]);

  // tweak 4 (redesigned): one Mark chip per item opens a single shared popover. Clicking the same
  // chip again closes it; clicking a different chip re-anchors and remounts the body (keyed by refId).
  const isActive = (id) => markOpen && markTarget?.refId === id;
  const openMark = (refId, aiText, e) => {
    if (markOpen && markTarget?.refId === refId) { setMarkOpen(false); return; }
    setMarkTarget({ refId, aiText });
    setMarkAnchor(e.currentTarget.getBoundingClientRect());
    setMarkOpen(true);
  };
  // Save replaces all marks for this ref with one-of-each (wrong / edit / note). Clear = all empty.
  // Keeps the {ref,kind,aiText,userText,ts} schema, so collectRefs + the Unmatched drawer are unaffected.
  const saveMark = (refId, aiText, { wrong, edit, note }) => {
    const ts = new Date().toISOString();
    const kept = feedback.entries.filter((e) => e.ref !== refId);
    const made = [];
    if (wrong) made.push({ ref: refId, kind: 'wrong', aiText: String(aiText ?? ''), userText: '', ts });
    if (edit) made.push({ ref: refId, kind: 'edit', aiText: String(aiText ?? ''), userText: edit, ts });
    if (note) made.push({ ref: refId, kind: 'note', aiText: String(aiText ?? ''), userText: note, ts });
    const next = { entries: [...kept, ...made] };
    setFeedback(next); // optimistic
    if (feedbackPath) api.savePage(feedbackPath, JSON.stringify(next), null, 'gamewiki').catch(() => {});
  };

  // Feedback whose ref no longer resolves in the current report (item changed in a regenerate).
  const unmatched = useMemo(() => {
    if (state.status !== 'ready' || !report) return [];
    const known = collectRefs(report);
    return feedback.entries.filter((e) => !known.has(e.ref));
  }, [state.status, report, feedback]);

  const toggleItem = async (id) => {
    if (!report) return;
    const next = { ...report, actionItems: (report.actionItems || []).map((it) => it.id === id ? { ...it, status: it.status === 'done' ? 'pending' : 'done' } : it) };
    setReport(next); // optimistic
    try { await api.savePage(sidecarPath, JSON.stringify(next), null, 'gamewiki'); } catch { /* keep UI state; a failed write just isn't persisted */ }
  };

  // Jump to a transcript moment: switch to Segments, then (post-render) scroll + flash the row.
  // Target = the segment whose whole-second start matches the stamp, else the first at/after it,
  // else the last row. Flash reuses the shared .settings-search-flash keyframe (SettingsDrawer:308
  // mechanic: double-rAF + one 150ms retry for the tab-switch render).
  const jumpToSegment = useCallback((t) => {
    pendingJumpRef.current = t;
    setTab('segments');
  }, [setTab]);

  useEffect(() => {
    const t = pendingJumpRef.current;
    if (tab !== 'segments' || !t || !Array.isArray(segments) || !segments.length) return;
    pendingJumpRef.current = null;
    // Fold any number of colon-separated parts, so h:mm:ss and m:ss both resolve (a two-part
    // destructure read "1:07:25" as 67 seconds and jumped a chip to the wrong end of the VOD).
    const tSec = t.split(':').map(Number).reduce((acc, n) => acc * 60 + (Number.isFinite(n) ? n : 0), 0);
    let idx = segments.findIndex((seg) => Math.floor((Number(seg.t0Ms) || 0) / 1000) === tSec);
    if (idx === -1) idx = segments.findIndex((seg) => (Number(seg.t0Ms) || 0) >= tSec * 1000);
    if (idx === -1) idx = segments.length - 1;
    const tryFlash = () => {
      const el = paneRef.current?.querySelector(`[data-seg-idx="${idx}"]`);
      if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('settings-search-flash');
      setTimeout(() => el.classList.remove('settings-search-flash'), 1200);
      return true;
    };
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!tryFlash()) setTimeout(tryFlash, 150);
    }));
  }, [tab, segments]);

  // react-markdown overrides: #seg- links (from linkTimeTokens) render as TimeChips; external
  // links open in a new window; everything else inherits .gamewiki-md typography.
  const mdComponents = {
    a: ({ href, children, ...rest }) => {
      const h = href || '';
      if (h.startsWith('#seg-')) return <TimeChip t={h.slice(5)} onJump={jumpToSegment} />;
      if (/^https?:\/\//i.test(h)) return <a href={h} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
      return <a href={h} {...rest}>{children}</a>;
    },
  };

  const runRail = async (kind, fn) => {
    if (!fn || busy) return;
    setBusy(kind);
    try {
      await fn();
      if (kind === 'regen') setReloadKey((k) => k + 1); // fresh sidecar on disk → re-read
    } finally { setBusy(''); }
  };

  const { status } = state;
  const r = report || {};
  const sections = r.sections || [];
  const followUps = r.followUps || [];
  const TABS = [
    { id: 'tldr', label: 'Report' },
    { id: 'players', label: `Player Cards${(r.playerCards || []).length ? ` (${r.playerCards.length})` : ''}` },
    { id: 'macro', label: 'Macro' },
    { id: 'comms', label: 'Comms Grade' },
    { id: 'actions', label: `Action Items${(r.actionItems || []).length ? ` (${r.actionItems.length})` : ''}` },
    { id: 'qa', label: `Q&A${(r.qa || []).length ? ` (${r.qa.length})` : ''}` },
    { id: 'keep', label: 'Keep Doing' },
    { id: 'debates', label: 'Debates' },
    ...(followUps.length ? [{ id: 'followups', label: `Follow-ups (${followUps.length})` }] : []),
    { id: 'segments', label: `Segments${(segments || []).length ? ` (${segments.length})` : ''}` },
  ];

  // Publish the tab list to the parent tree (inline mode) so it can build the
  // Report/Coaching folder leaves + counts from the same source of truth.
  useEffect(() => {
    if (inline) onTabsChange?.(TABS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, onTabsChange, JSON.stringify(TABS.map((t) => [t.id, t.label]))]);

  const body = (
    <>
      {/* Content pane */}
      <div ref={paneRef} style={{ flex: 1, minWidth: 0, padding: '20px 24px', overflowY: 'auto' }}>
        {/* meta.warnings bar + unmatched-corrections drawer (Move 12/13) — every tab but Segments */}
        {status === 'ready' && tab !== 'segments' && ((r.meta?.warnings || []).length > 0 || unmatched.length > 0) && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', marginBottom: 14, background: 'var(--surface-2)' }}>
            {(r.meta?.warnings || []).map((w, i) => (
              <div key={i} style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{w}</div>
            ))}
            {unmatched.length > 0 && (
              <details style={{ marginTop: (r.meta?.warnings || []).length ? 6 : 0 }}>
                <summary style={{ fontSize: 11.5, color: 'var(--text-2)', cursor: 'pointer' }}>
                  Unmatched corrections ({unmatched.length}) — saved feedback whose item changed in a regenerate
                </summary>
                {unmatched.map((e, i) => (
                  <div key={i} style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3, paddingLeft: 10 }}>
                    [{KIND_LABEL[e.kind] || e.kind}] {e.aiText ? `"${e.aiText}"` : ''}{e.userText ? `${e.aiText ? ' ' : ''}${e.userText}` : ''}
                  </div>
                ))}
              </details>
            )}
          </div>
        )}
        {tab !== 'segments' && status === 'loading' && <Empty>Loading report…</Empty>}
        {tab !== 'segments' && status === 'missing' && <Empty>No report yet — click Generate Report on the scrim first.</Empty>}
        {tab !== 'segments' && status === 'parse-error' && <div style={{ color: 'var(--error)', fontSize: 13 }}>Couldn’t parse the stored report.</div>}
        {tab === 'segments' && (
          segments === null ? <Empty>Loading segments…</Empty>
            : segments.length === 0 ? <Empty>Transcript unavailable — re-run Extract VOD Comms on the scrim.</Empty>
            : (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.55 }}>
                {segments.map((s, i) => (
                  <div key={i} data-seg-idx={i} style={{ display: 'flex', gap: 8, marginBottom: 3, alignItems: 'baseline' }}>
                    <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{mmss((Number(s.t0Ms) || 0) / 1000)}</span>
                    <span style={{ flexShrink: 0, minWidth: 64, fontWeight: 600, color: speakerColor(s.speaker) }}>{s.speaker || '—'}</span>
                    <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{s.text || '·'}</span>
                  </div>
                ))}
              </div>
            )
        )}
        {status === 'ready' && (
          <>
            {tab === 'tldr' && (
              <div className="gamewiki-md">
                {sections.map((sec, si) => (
                  <div key={sec.id}>
                    <h2 style={si === 0 ? { marginTop: 0 } : undefined}>{sec.heading}</h2>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{linkTimeTokens(sec.md)}</ReactMarkdown>
                  </div>
                ))}
                {!sections.length && (
                  <div style={{ ...muted, marginTop: 16 }}>No topic sections in this report — Regenerate to build them.</div>
                )}
              </div>
            )}

            {tab === 'players' && ((r.playerCards || []).length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: candyGap(8) }}>
                {r.playerCards.map((c, i) => {
                  const isOpen = openCards.has(i);
                  const name = `${c.hero || c.player}${c.player && c.player !== c.hero ? ` (${c.player})` : ''}`;
                  return (
                    <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: isOpen ? '6px 6px 12px' : 6 }}>
                      <RailButton active={isOpen} accent={accent}
                        onClick={() => setOpenCards((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>
                        {name}{c.lane ? ` — ${c.lane}` : ''}
                      </RailButton>
                      {isOpen && (
                        <div style={{ padding: '0 8px' }}>
                          <Labeled label="Lane verdict" mark={<MarkChip refId={REF.pcField(c, 'laneVerdict')} aiText={c.laneVerdict} entries={feedback.entries} accent={accent} onOpen={openMark} active={isActive(REF.pcField(c, 'laneVerdict'))} />}>
                            {c.laneVerdict || 'Not analyzed.'}
                            <FindingList findings={r.meta.findings} path={`playerCards[${i}].laneVerdict`} />
                            <MarkLine refId={REF.pcField(c, 'laneVerdict')} entries={feedback.entries} />
                          </Labeled>
                          <Labeled label="Souls curve" mark={<MarkChip refId={REF.pcField(c, 'soulsCurveRead')} aiText={c.soulsCurveRead} entries={feedback.entries} accent={accent} onOpen={openMark} active={isActive(REF.pcField(c, 'soulsCurveRead'))} />}>
                            {c.soulsCurveRead || 'Not analyzed.'}
                            <FindingList findings={r.meta.findings} path={`playerCards[${i}].soulsCurveRead`} />
                            <MarkLine refId={REF.pcField(c, 'soulsCurveRead')} entries={feedback.entries} />
                          </Labeled>
                          <Labeled label="Items" mark={<MarkChip refId={REF.pcField(c, 'itemCritique')} aiText={c.itemCritique} entries={feedback.entries} accent={accent} onOpen={openMark} active={isActive(REF.pcField(c, 'itemCritique'))} />}>
                            {c.itemCritique || 'Not analyzed.'}
                            <FindingList findings={r.meta.findings} path={`playerCards[${i}].itemCritique`} />
                            <MarkLine refId={REF.pcField(c, 'itemCritique')} entries={feedback.entries} />
                          </Labeled>
                          {c.coaching && (
                            <Labeled label="Coaching" mark={<MarkChip refId={REF.pcField(c, 'coaching')} aiText={c.coaching} entries={feedback.entries} accent={accent} onOpen={openMark} active={isActive(REF.pcField(c, 'coaching'))} />}>
                              <div className="gamewiki-md">
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{linkTimeTokens(c.coaching)}</ReactMarkdown>
                              </div>
                              <FindingList findings={r.meta.findings} path={`playerCards[${i}].coaching`} />
                              <MarkLine refId={REF.pcField(c, 'coaching')} entries={feedback.entries} />
                            </Labeled>
                          )}
                          {(c.deathAnalysis || []).length > 0 && (
                            <Labeled label="Deaths">
                              {c.deathAnalysis.map((d, j) => (
                                <div key={j} style={{ marginTop: j ? 8 : 0 }}>
                                  <div style={{ lineHeight: 1.5 }}>
                                    <TimeChip t={d.t} onJump={jumpToSegment} />
                                    <MarkChip refId={REF.death(c, d)} aiText={d.what} entries={feedback.entries} accent={accent} onOpen={openMark} active={isActive(REF.death(c, d))} />
                                    <span>{d.what}</span>
                                  </div>
                                  {d.why && <div style={{ color: 'var(--text-2)', marginTop: 2 }}>{d.why}</div>}
                                  {d.lesson && <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>Lesson: {d.lesson}</div>}
                                  <FindingList findings={r.meta.findings} path={`playerCards[${i}].deathAnalysis[${j}]`} />
                                  <MarkLine refId={REF.death(c, d)} entries={feedback.entries} />
                                </div>
                              ))}
                            </Labeled>
                          )}
                          {(c.drills || []).length > 0 && (
                            <Labeled label="Drills">
                              {c.drills.map((t, j) => (
                                <div key={j} style={{ marginTop: j ? 6 : 0 }}>
                                  <div style={{ lineHeight: 1.5 }}>
                                    <MarkChip refId={REF.drill(c, t)} aiText={t} entries={feedback.entries} accent={accent} onOpen={openMark} active={isActive(REF.drill(c, t))} />
                                    <span>{t}</span>
                                  </div>
                                  <MarkLine refId={REF.drill(c, t)} entries={feedback.entries} />
                                </div>
                              ))}
                            </Labeled>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : <Empty>Not in this report — Regenerate to build player cards.</Empty>)}

            {tab === 'macro' && (r.macro?.tempoRead || r.macro?.laneMap || (r.macro?.objectiveWindows || []).length || (r.macro?.swings || []).length ? (
              <div className="vod-half-frame">
                <Labeled label="Tempo">
                  <MacroCard refId={REF.tempoRead} aiText={r.macro.tempoRead} active={isActive(REF.tempoRead)} onOpen={openMark}>
                    <div>{r.macro.tempoRead || 'Not analyzed.'}</div>
                    <FindingList findings={r.meta.findings} path="macro.tempoRead" />
                    <MarkLine refId={REF.tempoRead} entries={feedback.entries} />
                  </MacroCard>
                </Labeled>
                <Labeled label="Lane map">
                  <MacroCard refId={REF.laneMap} aiText={r.macro.laneMap} active={isActive(REF.laneMap)} onOpen={openMark}>
                    <div>{r.macro.laneMap || 'Not analyzed.'}</div>
                    <FindingList findings={r.meta.findings} path="macro.laneMap" />
                    <MarkLine refId={REF.laneMap} entries={feedback.entries} />
                  </MacroCard>
                </Labeled>
                {(r.macro.objectiveWindows || []).length > 0 && (
                  <Labeled label="Objective windows">
                    {r.macro.objectiveWindows.map((w, i) => (
                      <MacroCard key={i} refId={REF.objective(w)} aiText={`${w.event} ${w.verdict}`} active={isActive(REF.objective(w))} onOpen={openMark}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                          <div style={{ lineHeight: 1.4 }}>
                            <div style={{ fontSize: 15, fontWeight: 650 }}>{w.event}</div>
                            {w.verdict && <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2 }}>— {w.verdict}</div>}
                          </div>
                          <span style={macroBtnCluster}>
                            <TimeChip t={w.t} onJump={jumpToSegment} />
                          </span>
                        </div>
                        {w.why && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 8, color: 'var(--text-2)' }}>
                            <span style={{ flexShrink: 0, width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
                            <span>{w.why}</span>
                          </div>
                        )}
                        <FindingList findings={r.meta.findings} path={`macro.objectiveWindows[${i}]`} />
                        <MarkLine refId={REF.objective(w)} entries={feedback.entries} />
                      </MacroCard>
                    ))}
                  </Labeled>
                )}
                {(r.macro.swings || []).length > 0 && (
                  <Labeled label="Tempo swings">
                    {r.macro.swings.map((s, i) => (
                      <MacroCard key={i} refId={REF.swing(s)} aiText={`${s.direction} ${s.cause}`} active={isActive(REF.swing(s))} onOpen={openMark}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, lineHeight: 1.5 }}>
                          <span>{s.direction}{s.cause ? ` — ${s.cause}` : ''}</span>
                          <span style={macroBtnCluster}>
                            <TimeChip t={s.t} onJump={jumpToSegment} />
                          </span>
                        </div>
                        <FindingList findings={r.meta.findings} path={`macro.swings[${i}]`} />
                        <MarkLine refId={REF.swing(s)} entries={feedback.entries} />
                      </MacroCard>
                    ))}
                  </Labeled>
                )}
              </div>
            ) : <Empty>Not in this report — Regenerate to build the macro analysis.</Empty>)}

            {tab === 'comms' && (r.commsGrade?.overall || (r.commsGrade?.callouts || []).length || (r.commsGrade?.missed || []).length ? (
              <div>
                <Labeled label="Overall" mark={<MarkChip refId={REF.overall} aiText={r.commsGrade.overall} entries={feedback.entries} accent={accent} onOpen={openMark} active={isActive(REF.overall)} />}>
                  <b>{r.commsGrade.overall || 'Not graded.'}</b>
                  <FindingList findings={r.meta.findings} path="commsGrade.overall" />
                  <MarkLine refId={REF.overall} entries={feedback.entries} />
                </Labeled>
                {(r.commsGrade.callouts || []).length > 0 && (
                  <Labeled label="Callouts">
                    {r.commsGrade.callouts.map((c, i) => (
                      <div key={i} style={{ marginTop: i ? 12 : 0 }}>
                        <div style={{ lineHeight: 1.5 }}>
                          <TimeChip t={c.t} onJump={jumpToSegment} />
                          <MarkChip refId={REF.callout(c)} aiText={c.call} entries={feedback.entries} accent={accent} onOpen={openMark} active={isActive(REF.callout(c))} />
                          <span><b>{c.who}:</b> {c.call}</span>
                        </div>
                        {(c.verdict || c.evidence) && <div style={{ color: 'var(--text-2)', marginTop: 2 }}>{c.verdict}{c.evidence ? ` — ${c.evidence}` : ''}</div>}
                        <FindingList findings={r.meta.findings} path={`commsGrade.callouts[${i}]`} />
                        <MarkLine refId={REF.callout(c)} entries={feedback.entries} />
                      </div>
                    ))}
                  </Labeled>
                )}
                {(r.commsGrade.missed || []).length > 0 && (
                  <Labeled label="Missed calls">
                    {r.commsGrade.missed.map((m, i) => (
                      <div key={i} style={{ marginTop: i ? 6 : 0 }}>
                        <div style={{ lineHeight: 1.5 }}>
                          <MarkChip refId={REF.missed(m)} aiText={m} entries={feedback.entries} accent={accent} onOpen={openMark} active={isActive(REF.missed(m))} />
                          <span>{m}</span>
                        </div>
                        <FindingList findings={r.meta.findings} path={`commsGrade.missed[${i}]`} />
                        <MarkLine refId={REF.missed(m)} entries={feedback.entries} />
                      </div>
                    ))}
                  </Labeled>
                )}
              </div>
            ) : <Empty>Not in this report — Regenerate to build the comms grade.</Empty>)}

            {tab === 'actions' && ((r.actionItems || []).length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {r.actionItems.map((it) => (
                  <label key={it.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                    <input type="checkbox" checked={it.status === 'done'} onChange={() => toggleItem(it.id)} style={{ marginTop: 3, flexShrink: 0 }} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 13.5, color: it.status === 'done' ? 'var(--text-muted)' : 'var(--text)', textDecoration: it.status === 'done' ? 'line-through' : 'none' }}>
                        {it.text}
                        {it.count > 1 && <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 6 }}>×{it.count}</span>}
                        {it.player && <span style={{ fontSize: 11.5, color: 'var(--accent)', marginLeft: 6 }}>@{it.player}</span>}
                      </span>
                      <span style={{ display: 'block', marginTop: 3 }}>
                        {(it.timestamps || []).map((t, i) => <TimeChip key={i} t={t} onJump={jumpToSegment} />)}
                        <MarkChip refId={REF.action(it)} aiText={it.text} entries={feedback.entries} accent={accent} onOpen={openMark} active={isActive(REF.action(it))} />
                      </span>
                      <FindingList findings={r.meta.findings} path={`actionItems[${(r.actionItems || []).indexOf(it)}]`} />
                      <MarkLine refId={REF.action(it)} entries={feedback.entries} />
                    </span>
                  </label>
                ))}
              </div>
            ) : <Empty>No action items.</Empty>)}

            {tab === 'qa' && ((r.qa || []).length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {r.qa.map((x, i) => (
                  <div key={i}>
                    <div style={{ fontSize: 13.5 }}><TimeChip t={x.t} onJump={jumpToSegment} /><b>{x.askedBy || 'Q'}:</b> {x.q}</div>
                    <div style={{ fontSize: 13.5, color: 'var(--text-2)', marginTop: 3, paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>{x.a}</div>
                  </div>
                ))}
              </div>
            ) : <Empty>No questions raised.</Empty>)}

            {tab === 'keep' && ((r.keepDoing || []).length ? (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>{r.keepDoing.map((x, i) => <li key={i}>{x}</li>)}</ul>
            ) : <Empty>Nothing flagged.</Empty>)}

            {tab === 'debates' && ((r.debates || []).length ? (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>{r.debates.map((x, i) => <li key={i}>{x}</li>)}</ul>
            ) : <Empty>No unresolved debates.</Empty>)}

            {tab === 'followups' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {followUps.map((f, i) => (
                  <div key={i} style={{ fontSize: 13.5 }}>
                    <span style={{ color: f.verdict === 'resolved' ? 'var(--ok, #4caf50)' : f.verdict === 'persisting' ? 'var(--error)' : 'var(--text-muted)', fontWeight: 600, marginRight: 6 }}>{f.verdict}</span>
                    {f.priorItem}
                    {f.evidence && <div style={{ color: 'var(--text-muted)', marginTop: 2, paddingLeft: 10 }}>{f.evidence}</div>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Mark popover (tweak 4 redesign) — one shared popover anchored to the clicked Mark chip. */}
      <Popover
        open={markOpen}
        onClose={() => setMarkOpen(false)}
        outsideExempt="[data-mark-trigger]"
        accent={accent}
        showClose
        title="Mark"
        style={markAnchor ? { position: 'fixed', left: Math.min(markAnchor.left, window.innerWidth - 280), top: Math.min(markAnchor.bottom + 6, window.innerHeight - 260), width: 260, zIndex: 100000 } : { display: 'none' }}
        bodyStyle={{ padding: 12 }}
      >
        {markOpen && markTarget && (
          <MarkPopoverBody key={markTarget.refId} refId={markTarget.refId} aiText={markTarget.aiText} entries={feedback.entries} accent={accent}
            onSave={(v) => saveMark(markTarget.refId, markTarget.aiText, v)} onClose={() => setMarkOpen(false)} />
        )}
      </Popover>

    </>
  );

  if (inline) {
    return <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative' }}>{body}</div>;
  }

  return (
    <AppWindow open onClose={onClose} title="VOD Review Report" accent={accent}
      width="min(920px, 92vw)" height="min(720px, 88vh)"
      headerActions={mdPath ? (
        <button type="button" data-own-press className="candy-btn" data-shape="chip"
          title="Open the Analyst chat pointed at this scrim — free-text corrections, teaching, and report regeneration live there"
          onClick={() => openAnalyst({ scrimPath: mdPath })}>
          <span className="candy-face">Ask Analyst</span>
        </button>
      ) : undefined}
      bodyStyle={{ padding: 0, overflowY: 'hidden', display: 'flex' }}>
      <div style={{ width: 186, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', background: 'var(--surface-2)' }}>
        <ReportArtifactTree
          tabs={TABS}
          tab={tab}
          onTab={setTab}
          accent={accent}
          reveal={{ mdPath, commsPath, feedbackPath }}
        />
      </div>
      {body}
    </AppWindow>
  );
}
