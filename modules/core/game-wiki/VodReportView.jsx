// VodReportView — the VOD Review Report popup (Deadlock Scrim Coaching, sub-plan 11). Mirrors
// MatchViewPopup's chrome exactly: AppWindow + a left rail of text-only candy-btn rows + a content
// pane, only the active section shown. Reads the .vodreport sidecar (the report object is the source
// of truth), renders each section, and persists the coach's done/pending checkbox toggles straight
// back to the sidecar (app-owned, single-writer → null-mtime overwrite). Degrades: missing sidecar →
// "generate first" prompt; bad JSON → error. New component approved 2026-07-09 (reuses AppWindow +
// candy-btn + native checkboxes — no new primitive).
//
// VOD Report Sections rework (2026-07-13): the TL;DR tab is the full Report page — TL;DR header +
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
import { IconFolder } from '@host/components/icons.jsx';
import { parseSegments } from './commsCompile.js';
import { speakerColor } from './diarize.js';
import { save } from '@tauri-apps/plugin-dialog';
import Popover from '@host/components/ui/Popover.jsx';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import { serializeReportMarkdown, coerceReport, slugId } from './vodReport.js';
import { openAnalyst } from '@host/agents/analyst/AnalystProvider.jsx';

const muted = { color: 'var(--text-muted)', fontSize: 13 };

// Milliseconds → m:ss (raw-segment timestamp). "0:00" for missing/NaN. Mirrors CommsTranscriptView.
function mmss(ms) {
  const v = Number.isFinite(Number(ms)) ? Math.max(0, Math.floor(Number(ms) / 1000)) : 0;
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

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
      style={{ verticalAlign: 'baseline', marginRight: 4 }}>
      <span className="candy-face" style={{ fontSize: 11, fontFamily: 'var(--font-mono)', padding: '1px 7px' }}>{t}</span>
    </button>
  );
}

// Turn literal [m:ss] tokens into markdown links (#seg-m:ss) so react-markdown's `a` override can
// render them as TimeChips. Fence-aware (mirror GameWikiPage.transformWikilinks): code spans/blocks
// pass through untouched. `(?!\()` leaves real markdown links like [1:15](url) alone.
export function linkTimeTokens(md) {
  return String(md ?? '')
    .split(/(```[\s\S]*?```|`[^`]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/\[(\d+:\d{2})\](?!\()/g, '[$1](#seg-$1)')))
    .join('');
}

// Sections offered by the Export popover, in emit order (matches serializeReportMarkdown).
const EXPORT_SECTIONS = [
  { id: 'report', label: 'Report + TL;DR' },
  { id: 'actions', label: 'Action Items' },
  { id: 'qa', label: 'Q&A' },
  { id: 'keep', label: 'Keep Doing' },
  { id: 'debates', label: 'Debates' },
  { id: 'followups', label: 'Follow-ups' },
  { id: 'segments', label: 'Segments (transcript)' },
];

// Leaf filename without extension — the export H1 + default save name derive from it.
function baseName(p) {
  const s = String(p ?? '');
  const leaf = s.split(/[\\/]/).pop() || s;
  return leaf.replace(/\.[^.]+$/, '') || 'VOD Review';
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
    for (const f of ['laneVerdict', 'soulsCurveRead', 'itemCritique']) s.add(REF.pcField(c, f));
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

// Per-item correction controls: Wrong appends immediately; Edit / Note open a small inline input.
// Coach text renders BESIDE the AI text (kind-labeled lines) — the AI original is never overwritten.
function ItemControls({ refId, aiText, entries, onAdd }) {
  const [mode, setMode] = useState(''); // '' | 'edit' | 'note'
  const [text, setText] = useState('');
  const mine = (entries || []).filter((e) => e.ref === refId);
  const wrongMarked = mine.some((e) => e.kind === 'wrong');
  const start = (m) => { setMode(m); setText(m === 'edit' ? String(aiText ?? '') : ''); };
  const save = () => { onAdd({ ref: refId, kind: mode, aiText: String(aiText ?? ''), userText: text.trim() }); setMode(''); setText(''); };
  // preventDefault/stopPropagation mirrors TimeChip — these render inside the action-item <label>.
  const chip = (label, onClick, title) => (
    <button key={label} type="button" data-own-press className="candy-btn" data-shape="chip" title={title}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}>
      <span className="candy-face" style={{ fontSize: 11, padding: '1px 7px' }}>{label}</span>
    </button>
  );
  return (
    <div style={{ marginTop: 3 }}>
      {mine.map((e, i) => (
        <div key={i} style={{ fontSize: 12, paddingLeft: 8, borderLeft: '2px solid var(--accent)', marginTop: 2, color: e.kind === 'wrong' ? 'var(--error)' : 'var(--text-2)' }}>
          {KIND_LABEL[e.kind] || e.kind}{e.userText ? `: ${e.userText}` : ''}
        </div>
      ))}
      {mode ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 4 }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
            style={{ flex: 1, fontSize: 12, fontFamily: 'inherit', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', resize: 'vertical' }} />
          {chip('Save', save, mode === 'edit' ? 'Save the corrected text beside the AI text' : 'Save the note')}
          {chip('Cancel', () => setMode(''), 'Discard')}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, marginTop: mine.length ? 4 : 2 }}>
          {chip(wrongMarked ? 'Unmark' : 'Wrong', () => onAdd({ ref: refId, kind: 'wrong', aiText: String(aiText ?? ''), userText: '' }), wrongMarked ? 'Remove the wrong mark' : 'Mark this item wrong')}
          {chip('Edit', () => start('edit'), 'Write the corrected text (kept beside the AI text)')}
          {chip('Note', () => start('note'), 'Attach a note')}
        </div>
      )}
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

// tweak 4: chips split from the marks display so Wrong/Edit/Note sit inline on a header/item row's
// right (no overlap with the header text), while the "Marked wrong"/"Coach edit"/"Note" lines stay
// below the row. Chip size matches TimeChip (fontSize 11, padding 1px 7px) so the controls read as
// one set with the timestamp chips. The edit/note input opens under the chips (right-aligned).
function ItemChips({ refId, aiText, entries, onAdd }) {
  const [mode, setMode] = useState('');
  const [text, setText] = useState('');
  const wrongMarked = (entries || []).some((e) => e.ref === refId && e.kind === 'wrong');
  const start = (m) => { setMode(m); setText(m === 'edit' ? String(aiText ?? '') : ''); };
  const save = () => { onAdd({ ref: refId, kind: mode, aiText: String(aiText ?? ''), userText: text.trim() }); setMode(''); setText(''); };
  const chip = (label, onClick, title) => (
    <button key={label} type="button" data-own-press className="candy-btn" data-shape="chip" title={title}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}>
      <span className="candy-face" style={{ fontSize: 11, padding: '1px 7px' }}>{label}</span>
    </button>
  );
  if (mode) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {chip('Save', save, mode === 'edit' ? 'Save the corrected text beside the AI text' : 'Save the note')}
          {chip('Cancel', () => setMode(''), 'Discard')}
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
          style={{ width: 240, fontSize: 12, fontFamily: 'inherit', background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', resize: 'vertical' }} />
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {chip(wrongMarked ? 'Unmark' : 'Wrong', () => onAdd({ ref: refId, kind: 'wrong', aiText: String(aiText ?? ''), userText: '' }), wrongMarked ? 'Remove the wrong mark' : 'Mark this item wrong')}
      {chip('Edit', () => start('edit'), 'Write the corrected text (kept beside the AI text)')}
      {chip('Note', () => start('note'), 'Attach a note')}
    </div>
  );
}

function ItemMarks({ refId, entries }) {
  const mine = (entries || []).filter((e) => e.ref === refId);
  if (!mine.length) return null;
  return (
    <div style={{ marginTop: 3 }}>
      {mine.map((e, i) => (
        <div key={i} style={{ fontSize: 12, paddingLeft: 8, borderLeft: '2px solid var(--accent)', marginTop: 2, color: e.kind === 'wrong' ? 'var(--error)' : 'var(--text-2)' }}>
          {KIND_LABEL[e.kind] || e.kind}{e.userText ? `: ${e.userText}` : ''}
        </div>
      ))}
    </div>
  );
}

function Labeled({ label, children, controls }) {
  // Header unified to the report section-header size (tweak 3): same fontSize/weight as .gamewiki-md h2,
  // no uppercase/letter-spacing — one header look across the popup's Macro/Player/Comms tabs.
  // tweak 4: single-value sections pass their Wrong/Edit/Note ItemControls via `controls` → header
  // right. Multi-item sections keep per-item controls in the body (preserves per-item feedback refs).
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 16, fontWeight: 650, lineHeight: 1.3, color: 'var(--text)' }}>{label}</div>
        {controls && <div style={{ flexShrink: 0 }}>{controls}</div>}
      </div>
      <div style={{ fontSize: 13.5, marginTop: 4 }}>{children}</div>
    </div>
  );
}

export default function VodReportView({ sidecarPath, commsPath, feedbackPath, mdPath, accent, onClose, onRegenerate, onAddNotes }) {
  const [state, setState] = useState({ status: 'loading' });
  const [report, setReport] = useState(null);
  const [segments, setSegments] = useState(null); // null = loading, [] = none/unavailable
  const [tab, setTab] = useState('tldr');
  const [reloadKey, setReloadKey] = useState(0); // bumped after a Regenerate to re-read the sidecar
  const [busy, setBusy] = useState(''); // '' | 'regen' | 'notes'
  const paneRef = useRef(null); // content pane — jump target lookup root
  const pendingJumpRef = useRef(null); // m:ss awaiting the Segments tab to be visible
  // Export-to-.md popover state (anchored to the Export rail button).
  const [exportOpen, setExportOpen] = useState(false);
  const [exportAnchor, setExportAnchor] = useState(null); // RailButton bounding rect
  const [exportSel, setExportSel] = useState(() => new Set(['report', 'actions', 'qa']));
  const [exportDest, setExportDest] = useState('');
  const [exportErr, setExportErr] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  // Per-item corrections (.vodfeedback sidecar, append-only) + the Player-Cards expander set.
  const [feedback, setFeedback] = useState({ entries: [] });
  const [openCards, setOpenCards] = useState(() => new Set());

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

  // Raw diarized segments the report was built from (.vodcomms sidecar) — read-only here;
  // relabeling lives in ScrimViewer's CommsTranscriptView. Missing/bad → [] (degrades to a gap).
  useEffect(() => {
    if (!commsPath) { setSegments([]); return; }
    let cancelled = false;
    setSegments(null);
    api.getRawFileMeta(commsPath, 'gamewiki')
      .then((r) => { if (!cancelled) setSegments(parseSegments(r.content)); })
      .catch(() => { if (!cancelled) setSegments([]); });
    return () => { cancelled = true; };
  }, [commsPath]);

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

  const addFeedback = (entry) => {
    // 'wrong' is a toggle (tweak 5): if this ref is already marked wrong, clicking again removes the
    // mark instead of stacking another "Marked wrong" line. Edit/Note still append (multiple are legit).
    let next;
    if (entry.kind === 'wrong' && feedback.entries.some((e) => e.ref === entry.ref && e.kind === 'wrong')) {
      next = { entries: feedback.entries.filter((e) => !(e.ref === entry.ref && e.kind === 'wrong')) };
    } else {
      next = { entries: [...feedback.entries, { ...entry, ts: new Date().toISOString() }] };
    }
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
  }, []);

  useEffect(() => {
    const t = pendingJumpRef.current;
    if (tab !== 'segments' || !t || !Array.isArray(segments) || !segments.length) return;
    pendingJumpRef.current = null;
    const [m, s] = t.split(':').map(Number);
    const tSec = (m || 0) * 60 + (s || 0);
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

  // App-wide toast via the shared `agentic:notify` bus (NotificationProvider styles it).
  const toast = (type, title, message) => {
    const err = type === 'error';
    window.dispatchEvent(new CustomEvent('agentic:notify', {
      detail: {
        type: err ? 'deadlock-error' : 'deadlock-info', title, message,
        accent: err ? 'var(--error)' : (accent || 'var(--accent)'),
        iconKey: err ? 'alert' : 'bell', duration: err ? 6000 : 3500,
      },
    }));
  };

  const openExport = (e) => {
    if (exportOpen) { setExportOpen(false); return; } // toggle — outsideExempt keeps the click in
    setExportErr('');
    setExportAnchor(e.currentTarget.getBoundingClientRect());
    setExportOpen(true);
  };
  const pickExportDest = async () => {
    setExportErr('');
    try {
      const p = await save({
        defaultPath: `${baseName(mdPath)} VOD Review.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (p) setExportDest(p.toLowerCase().endsWith('.md') ? p : `${p}.md`);
    } catch (e) { setExportErr(String(e?.message || e)); }
  };
  const toggleSection = (id) => setExportSel((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const doExport = async () => {
    if (!report || !exportDest || exportSel.size === 0 || exportBusy) return;
    setExportBusy(true);
    setExportErr('');
    try {
      const md = serializeReportMarkdown(report, exportSel, `${baseName(mdPath)} VOD Review`, segments);
      await invoke('export_report_file', { path: exportDest, content: md, reveal: true });
      toast('success', 'Exported', exportDest);
      setExportOpen(false);
    } catch (e) {
      setExportErr(String(e?.message || e));
    } finally {
      setExportBusy(false);
    }
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
      {/* Left rail */}
      <div style={{ width: 186, flexShrink: 0, padding: '14px 10px', borderRight: '1px solid var(--border)', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: candyGap(8), overflowY: 'auto', overflowX: 'hidden' }}>
        {TABS.map((t) => (
          <RailButton key={t.id} active={t.id === tab} accent={accent} onClick={() => setTab(t.id)}>{t.label}</RailButton>
        ))}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: candyGap(8) }}>
          {onAddNotes && (
            <RailButton accent={accent} disabled={!!busy} onClick={() => runRail('notes', onAddNotes)}>
              {busy === 'notes' ? 'Adding…' : 'Add Notes'}
            </RailButton>
          )}
          {onRegenerate && (
            <RailButton accent={accent} disabled={!!busy} onClick={() => runRail('regen', onRegenerate)}>
              {busy === 'regen' ? 'Regenerating…' : 'Regenerate'}
            </RailButton>
          )}
          <RailButton accent={accent} data-export-trigger disabled={!report} onClick={openExport}>
            {exportBusy ? 'Exporting…' : 'Export'}
          </RailButton>
          {mdPath && (
            <button type="button" data-own-press className="candy-btn" data-shape="icon"
              title="Show scrim file in folder" style={{ alignSelf: 'flex-start', '--accent': accent }}
              onClick={() => invoke('coaching_reveal_path', { path: mdPath }).catch((e) => console.error('coaching_reveal_path failed:', e))}>
              <span className="candy-face"><IconFolder size={16} /></span>
            </button>
          )}
        </div>
      </div>

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
                    <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{mmss(s.t0Ms)}</span>
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
                <h2 style={{ marginTop: 0 }}>TL;DR</h2>
                {r.tldr ? <p>{r.tldr}</p> : <Empty>No summary.</Empty>}
                {sections.map((sec) => (
                  <div key={sec.id}>
                    <h2>{sec.heading}</h2>
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
                          <Labeled label="Lane verdict" controls={<ItemChips refId={REF.pcField(c, 'laneVerdict')} aiText={c.laneVerdict} entries={feedback.entries} onAdd={addFeedback} />}>
                            {c.laneVerdict || 'Not analyzed.'}
                            <FindingList findings={r.meta.findings} path={`playerCards[${i}].laneVerdict`} />
                            <ItemMarks refId={REF.pcField(c, 'laneVerdict')} entries={feedback.entries} />
                          </Labeled>
                          <Labeled label="Souls curve" controls={<ItemChips refId={REF.pcField(c, 'soulsCurveRead')} aiText={c.soulsCurveRead} entries={feedback.entries} onAdd={addFeedback} />}>
                            {c.soulsCurveRead || 'Not analyzed.'}
                            <FindingList findings={r.meta.findings} path={`playerCards[${i}].soulsCurveRead`} />
                            <ItemMarks refId={REF.pcField(c, 'soulsCurveRead')} entries={feedback.entries} />
                          </Labeled>
                          <Labeled label="Items" controls={<ItemChips refId={REF.pcField(c, 'itemCritique')} aiText={c.itemCritique} entries={feedback.entries} onAdd={addFeedback} />}>
                            {c.itemCritique || 'Not analyzed.'}
                            <FindingList findings={r.meta.findings} path={`playerCards[${i}].itemCritique`} />
                            <ItemMarks refId={REF.pcField(c, 'itemCritique')} entries={feedback.entries} />
                          </Labeled>
                          {(c.deathAnalysis || []).length > 0 && (
                            <Labeled label="Deaths">
                              {c.deathAnalysis.map((d, j) => (
                                <div key={j} style={{ marginTop: j ? 8 : 0 }}>
                                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                                    <span><TimeChip t={d.t} onJump={jumpToSegment} />{d.what}</span>
                                    <ItemChips refId={REF.death(c, d)} aiText={d.what} entries={feedback.entries} onAdd={addFeedback} />
                                  </div>
                                  {d.why && <div style={{ color: 'var(--text-2)', marginTop: 2 }}>{d.why}</div>}
                                  {d.lesson && <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>Lesson: {d.lesson}</div>}
                                  <FindingList findings={r.meta.findings} path={`playerCards[${i}].deathAnalysis[${j}]`} />
                                  <ItemMarks refId={REF.death(c, d)} entries={feedback.entries} />
                                </div>
                              ))}
                            </Labeled>
                          )}
                          {(c.drills || []).length > 0 && (
                            <Labeled label="Drills">
                              {c.drills.map((t, j) => (
                                <div key={j} style={{ marginTop: j ? 6 : 0 }}>
                                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                                    <span>{t}</span>
                                    <ItemChips refId={REF.drill(c, t)} aiText={t} entries={feedback.entries} onAdd={addFeedback} />
                                  </div>
                                  <ItemMarks refId={REF.drill(c, t)} entries={feedback.entries} />
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
              <div>
                <Labeled label="Tempo" controls={<ItemChips refId={REF.tempoRead} aiText={r.macro.tempoRead} entries={feedback.entries} onAdd={addFeedback} />}>
                  {r.macro.tempoRead || 'Not analyzed.'}
                  <FindingList findings={r.meta.findings} path="macro.tempoRead" />
                  <ItemMarks refId={REF.tempoRead} entries={feedback.entries} />
                </Labeled>
                <Labeled label="Lane map" controls={<ItemChips refId={REF.laneMap} aiText={r.macro.laneMap} entries={feedback.entries} onAdd={addFeedback} />}>
                  {r.macro.laneMap || 'Not analyzed.'}
                  <FindingList findings={r.meta.findings} path="macro.laneMap" />
                  <ItemMarks refId={REF.laneMap} entries={feedback.entries} />
                </Labeled>
                {(r.macro.objectiveWindows || []).length > 0 && (
                  <Labeled label="Objective windows">
                    {r.macro.objectiveWindows.map((w, i) => (
                      <div key={i} style={{ marginTop: i ? 8 : 0 }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                          <span><TimeChip t={w.t} onJump={jumpToSegment} /><b>{w.event}</b>{w.verdict ? ` — ${w.verdict}` : ''}</span>
                          <ItemChips refId={REF.objective(w)} aiText={`${w.event} ${w.verdict}`} entries={feedback.entries} onAdd={addFeedback} />
                        </div>
                        {w.why && <div style={{ color: 'var(--text-2)', marginTop: 2 }}>{w.why}</div>}
                        <FindingList findings={r.meta.findings} path={`macro.objectiveWindows[${i}]`} />
                        <ItemMarks refId={REF.objective(w)} entries={feedback.entries} />
                      </div>
                    ))}
                  </Labeled>
                )}
                {(r.macro.swings || []).length > 0 && (
                  <Labeled label="Tempo swings">
                    {r.macro.swings.map((s, i) => (
                      <div key={i} style={{ marginTop: i ? 8 : 0 }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                          <span><TimeChip t={s.t} onJump={jumpToSegment} />{s.direction}{s.cause ? ` — ${s.cause}` : ''}</span>
                          <ItemChips refId={REF.swing(s)} aiText={`${s.direction} ${s.cause}`} entries={feedback.entries} onAdd={addFeedback} />
                        </div>
                        <FindingList findings={r.meta.findings} path={`macro.swings[${i}]`} />
                        <ItemMarks refId={REF.swing(s)} entries={feedback.entries} />
                      </div>
                    ))}
                  </Labeled>
                )}
              </div>
            ) : <Empty>Not in this report — Regenerate to build the macro analysis.</Empty>)}

            {tab === 'comms' && (r.commsGrade?.overall || (r.commsGrade?.callouts || []).length || (r.commsGrade?.missed || []).length ? (
              <div>
                <Labeled label="Overall" controls={<ItemChips refId={REF.overall} aiText={r.commsGrade.overall} entries={feedback.entries} onAdd={addFeedback} />}>
                  <b>{r.commsGrade.overall || 'Not graded.'}</b>
                  <FindingList findings={r.meta.findings} path="commsGrade.overall" />
                  <ItemMarks refId={REF.overall} entries={feedback.entries} />
                </Labeled>
                {(r.commsGrade.callouts || []).length > 0 && (
                  <Labeled label="Callouts">
                    {r.commsGrade.callouts.map((c, i) => (
                      <div key={i} style={{ marginTop: i ? 8 : 0 }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                          <span><TimeChip t={c.t} onJump={jumpToSegment} /><b>{c.who}:</b> {c.call}</span>
                          <ItemChips refId={REF.callout(c)} aiText={c.call} entries={feedback.entries} onAdd={addFeedback} />
                        </div>
                        {(c.verdict || c.evidence) && <div style={{ color: 'var(--text-2)', marginTop: 2 }}>{c.verdict}{c.evidence ? ` — ${c.evidence}` : ''}</div>}
                        <FindingList findings={r.meta.findings} path={`commsGrade.callouts[${i}]`} />
                        <ItemMarks refId={REF.callout(c)} entries={feedback.entries} />
                      </div>
                    ))}
                  </Labeled>
                )}
                {(r.commsGrade.missed || []).length > 0 && (
                  <Labeled label="Missed calls">
                    {r.commsGrade.missed.map((m, i) => (
                      <div key={i} style={{ marginTop: i ? 6 : 0 }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                          <span>{m}</span>
                          <ItemChips refId={REF.missed(m)} aiText={m} entries={feedback.entries} onAdd={addFeedback} />
                        </div>
                        <FindingList findings={r.meta.findings} path={`commsGrade.missed[${i}]`} />
                        <ItemMarks refId={REF.missed(m)} entries={feedback.entries} />
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
                      {(it.timestamps || []).length > 0 && <span style={{ display: 'block', marginTop: 3 }}>{it.timestamps.map((t, i) => <TimeChip key={i} t={t} onJump={jumpToSegment} />)}</span>}
                      <FindingList findings={r.meta.findings} path={`actionItems[${(r.actionItems || []).indexOf(it)}]`} />
                      <ItemControls refId={REF.action(it)} aiText={it.text} entries={feedback.entries} onAdd={addFeedback} />
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

      {/* Export-to-.md popover — anchored to the Export rail button. */}
      <Popover
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        outsideExempt="[data-export-trigger]"
        accent={accent}
        showClose
        title="Export VOD Review"
        style={exportAnchor ? { position: 'fixed', left: Math.min(exportAnchor.right + 8, window.innerWidth - 308), bottom: Math.max(8, window.innerHeight - exportAnchor.top + 8), width: 300, zIndex: 100000 } : { display: 'none' }}
        bodyStyle={{ padding: 14 }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Sections to export:</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {EXPORT_SECTIONS.map((s) => (
              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
                <input type="checkbox" checked={exportSel.has(s.id)} onChange={() => toggleSection(s.id)} style={{ accentColor: accent || 'var(--accent)' }} />
                {s.label}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: exportDest ? 'var(--text)' : 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={exportDest}>
              {exportDest || 'No destination chosen'}
            </div>
            <OutlinedBtn small onClick={pickExportDest} disabled={exportBusy}>Choose…</OutlinedBtn>
          </div>
          {exportErr && <div style={{ fontSize: 11.5, color: 'var(--error)' }}>{exportErr}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <PrimaryBtn small accent={accent} onClick={doExport} disabled={!exportDest || exportSel.size === 0 || exportBusy}>
              {exportBusy ? 'Exporting…' : 'Export'}
            </PrimaryBtn>
          </div>
        </div>
      </Popover>
    </AppWindow>
  );
}
