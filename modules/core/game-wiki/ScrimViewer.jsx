// ScrimViewer — renders a Deadlock coaching-scrim .md as interactive fill-in boxes
// (never raw markdown). Reference shape: the planner DayPane (read -> parse -> render
// boxes -> write back read->parse->merge->serialize on blur, behind a fresh-mtime
// conflict guard). Editable: teams / coached / date / score / VOD / per-match fields
// + notes bullets. Opaque ### Match Data / ### Coaching Summary stay read-only
// (Run-Process-owned, merged fresh from disk on every save).
//
// SF5 adds file pickers + the inline scoreboard; SF7 adds "+ New Match".

import { useCallback, useEffect, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, invoke } from '@host/api.js';
import { IconFolder, IconPlayCircle, IconPlus, IconFileText, IconSettings, IconFilm, IconHardDrive, IconChevronRight } from '@host/components/icons.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { candyGap } from '@host/util/candy.js';
import CollapsibleRail from '@host/components/ui/CollapsibleRail.jsx';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import Popover from '@host/components/ui/Popover.jsx';
import SidebarSeam from '@host/components/SidebarSeam.jsx';
import TreeSidebar from '@host/components/vault-tree/TreeSidebar.jsx';
import { useTreeExpansion } from '@host/components/vault-tree/useTreeExpansion.js';
import { useKeybindHold } from '@host/keybinds/useKeybind.js';
import { parseScrim, serializeScrim, mergeScrim, appendMatch, getNotes, ensureNotes } from './scrimSchema.js';
import MatchViewPopup from './MatchViewPopup.jsx';
import { sidecarPath, scrimSidecarPath, renderSummary, setMatchDataBody, MATCH_DATA_PLACEHOLDER, clock, extractMeta, fmtLocalTime, extractSpatial } from './matchData.js';
import { compileNotes, renderCoachingSummary, setCoachingSummaryBody, parseTimedNote, formatTimedBullet, sortByTimeAsc, secFromClock } from './noteCompile.js';
import { setCommsTranscriptBody, renderCommsSummary, parseSegments, parseCommsSidecar, buildCommsSidecar } from './commsCompile.js';
import { alignDiarization, mergeTranscripts, labelForCluster, speakerColor } from './diarize.js';
import { matchClusters, enrollPrint, parseVoiceprints, DEFAULT_THRESHOLD } from './voiceprints.js';
import { auditSilentDeaths } from './deathAudit.js';
import { buildTranscriptBlock, generateReport, normalizeTranscript, transcriptHash, verifyReport } from './vodReport.js';
import { buildMatchDigest } from './matchDigest.js';
import { buildBrainContext, buildLexicon, lexiconStale, LEXICON_PATH } from './analystBrain.js';
import VodReportView from './VodReportView.jsx';
import { buildFights, judgeTeamfights, summarize } from './teamfightComms.js';
import TeamfightCommsView from './TeamfightCommsView.jsx';
import { matchMetrics, sumMatchMetrics, aggregateTeam, renderTeamPage, openHomework, teamSidecarPath, teamPagePath, normIssue } from './teamProgress.js';
import CommsTranscriptView from './CommsTranscriptView.jsx';
import { useSettings } from '@host/hooks/useSettings.js';
import { buildMomentsDigest, classifyMoments, reconcile, renderAutoClassification, setAutoClassificationBody, sideFromTeamFields, mergedItemToBullet } from './autoClassify.js';
import { useStopwatch, readStopwatch } from './useStopwatch.js';
import RetagButton from './RetagButton.jsx';
import ReviewModal from './ReviewModal.jsx';
import { classColor } from './classColors.js';
import { Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const SAVE_DEBOUNCE_MS = 700;
// The comms-transcription model (Deadlock Scrim Coaching SF1 gate, 2026-06-17): the
// cached large-v3-turbo — best coherence on player names + in-game announcer callouts
// for coaching review (~0.04 RTF on Vulkan; deviates from the spec's base.en default).
const STT_MODEL = 'large-v3-turbo-q5_0';
const MP4_FILTERS = [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'webm'] }];
const IMG_FILTERS = [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }];
const NOTES_FILTERS = [{ name: 'Notes', extensions: ['md', 'txt'] }];

// Per-team voiceprint store (SF6, Comms Diarization): Deadlock/Coaching/Teams/<Team>/.voiceprints.json
// — the coached team's roster + saved voiceprints, reused across that team's scrims. The
// Teams/<Team>/ subdir is created on first write (vault_write_file → atomic_write mkdir-parents).
const TEAMS_BASE = 'Deadlock/Coaching/Teams';
const teamStorePath = (team) => `${TEAMS_BASE}/${String(team || '').trim()}/.voiceprints.json`;

// localStorage: global track defaults (0-based OBS track indices) + your mic-track name. Remembered
// across scrims; the track indices are overridable per scrim via the Comms/Mic Track frontmatter.
const LS_TRACKS = 'gw-coach-tracks';   // { comms, mic }
const LS_YOUNAME = 'gw-coach-name';    // string

function loadTrackDefaults() {
  try { const j = JSON.parse(localStorage.getItem(LS_TRACKS) || '{}'); return { comms: j.comms ?? '', mic: j.mic ?? '' }; }
  catch { return { comms: '', mic: '' }; }
}
function saveTrackDefault(key, val) {
  const d = loadTrackDefaults(); d[key] = val;
  try { localStorage.setItem(LS_TRACKS, JSON.stringify(d)); } catch { /* private mode */ }
}
const loadYourName = () => { try { return localStorage.getItem(LS_YOUNAME) || ''; } catch { return ''; } };

// Scrim Tree Consolidation (2026-07-14): the tree's Report/Coaching leaves + the pane
// view + the collapsible rail persistence. The report tab list is normally published live
// by the inline VodReportView (onTabsChange); this default seeds the tree before a report
// exists so its leaves are clickable from the start.
const DEFAULT_REPORT_TABS = [
  { id: 'tldr', label: 'Report' }, { id: 'players', label: 'Player Cards' },
  { id: 'macro', label: 'Macro' }, { id: 'comms', label: 'Comms Grade' },
  { id: 'actions', label: 'Action Items' }, { id: 'qa', label: 'Q&A' },
  { id: 'keep', label: 'Keep Doing' }, { id: 'debates', label: 'Debates' },
  { id: 'followups', label: 'Follow-ups' }, { id: 'segments', label: 'Segments' },
];
const REPORT_GROUP = ['tldr', 'players', 'macro', 'comms'];
const COACHING_GROUP = ['actions', 'qa', 'keep', 'debates', 'followups', 'segments'];
const LS_RAIL_EXPANDED = 'gw-scrim-rail-expanded'; // global (one scrim-rail pref, 1-1 with the main nav)
const LS_RAIL_WIDTH = 'gw-scrim-rail-width';
const RAIL_MIN = 200, RAIL_MAX = 460, RAIL_DEFAULT = 280;
const loadRailExpanded = () => { try { return localStorage.getItem(LS_RAIL_EXPANDED) !== '0'; } catch { return true; } };
const loadRailWidth = () => { try { const v = parseInt(localStorage.getItem(LS_RAIL_WIDTH), 10); return Number.isFinite(v) && v >= RAIL_MIN && v <= RAIL_MAX ? v : RAIL_DEFAULT; } catch { return RAIL_DEFAULT; } };
const viewKey = (p) => `gw-scrim-view:${p}`; // per-scrim last-viewed pane
const loadView = (p) => { try { const j = JSON.parse(localStorage.getItem(viewKey(p)) || 'null'); if (j && (j.kind === 'match' || j.kind === 'report')) return j; } catch { /* none */ } return null; };

// A track field ("" / non-numeric / negative → null = "not set"); a set value routes -map 0:a:<n>.
function trackIndex(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Native file-open dialog → absolute path string (or null if cancelled). The path
// is stored verbatim in the .md (never copied — multi-GB recordings stay in place).
async function pickFile(filters) {
  const picked = await openDialog({ directory: false, multiple: false, filters });
  return typeof picked === 'string' ? picked : (picked?.path || null);
}

// App-wide toast — the shared NotificationProvider listens for `agentic:notify`
// and styles by accent/iconKey (red "!" for errors, mirroring the app's own toasts).
function notify(type, title, message) {
  const err = type === 'error';
  window.dispatchEvent(new CustomEvent('agentic:notify', {
    detail: {
      type: err ? 'deadlock-error' : 'deadlock-info', title, message,
      accent: err ? 'var(--error)' : 'var(--accent)', iconKey: err ? 'alert' : 'bell',
      duration: err ? 6000 : 3500,
    },
  }));
}

const wrap = { flex: 1, minHeight: 0, overflowY: 'auto' };
const inner = { maxWidth: 720, margin: '0 auto', padding: '20px 28px 64px', fontFamily: 'var(--font-mono)' };
const card = {
  border: '1px solid color-mix(in oklch, var(--text) 12%, transparent)',
  background: 'color-mix(in oklch, var(--text) 4%, transparent)',
  borderRadius: 12, padding: '14px 16px', marginBottom: 16,
};
const sectionTitle = { fontSize: 15, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--text)' };
const labelStyle = { fontSize: 12, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text)', marginBottom: 8 };
const valueStyle = { fontSize: 14, color: 'var(--text)', wordBreak: 'break-word' };
const removeBtn = { border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 4px', flexShrink: 0 };

function EditField({ label, value, onChange, onCommit, placeholder, right }) {
  return (
    <div style={{ marginBottom: candyGap(8, true) }}>
      <div style={labelStyle}>{label}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div className="candy-btn" data-shape="field" style={{ flex: 1, minWidth: 0 }}>
          <input
            className="candy-face"
            value={value || ''}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onCommit}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
          />
        </div>
        {right}
      </div>
    </div>
  );
}

function MiniBtn({ icon: Icon, title, onClick }) {
  return (
    <button className="candy-btn" data-shape="icon" title={title} onClick={onClick}
      style={{ width: 30, height: 30, flexShrink: 0 }}>
      <span className="candy-face"><Icon size={15} /></span>
    </button>
  );
}

// Inline scoreboard — read via the coaching_read_image Rust command (returns a data:
// URL for any user-picked path, dodging the mortar-pestle-asset:// allowlist). For the
// user's eyes only; the pipeline never reads it.
function Scoreboard({ path }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc(null); setFailed(false);
    if (!path) return undefined;
    invoke('coaching_read_image', { path })
      .then((dataUrl) => { if (!cancelled) setSrc(dataUrl); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [path]);
  if (!path) return null;
  if (failed) return <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Couldn’t load screenshot (moved or unreadable).</div>;
  if (!src) return <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Loading screenshot</div>;
  return <img src={src} alt="Scoreboard" style={{ maxWidth: '100%', borderRadius: 8, marginTop: 8, display: 'block', border: '1px solid color-mix(in oklch, var(--text) 12%, transparent)' }} />;
}

// Count-up game clock (sub-plan 5): readout + text Start/Pause + Reset — glyph-free,
// the clock wears the notes-label style (no running tint) per the minimalism pass.
function TimerControls({ sw }) {
  return (
    <div className="candy-center-row" style={{ gap: 6 }}>
      <span style={{ ...labelStyle, marginBottom: 0, fontVariantNumeric: 'tabular-nums', minWidth: 40 }}>{clock(sw.elapsedSec)}</span>
      <button className="candy-btn" data-shape="chip" onClick={sw.toggle} title={sw.running ? 'Pause timer' : 'Start timer'}>
        <span className="candy-face">{sw.running ? 'Pause' : 'Start'}</span>
      </button>
      <button className="candy-btn" data-shape="chip" onClick={sw.reset} title="Reset timer">
        <span className="candy-face">Reset</span>
      </button>
    </div>
  );
}

// Per-team notes — the canonical, timestamped, classified list (sub-plan 5). Each row
// decomposes a bullet into a RetagButton (the classification) + an editable "[m:ss] text"
// field; rows render time-ascending (untimed last) but edits map back to the ORIGINAL
// index. When the timer runs, a new note via ENTER is stamped with the elapsed time.
// `fill`: slim live mode with a user-pinned panel height — the editor and its list
// flex-fill the panel instead of the compact 165px list cap (add-field stays pinned
// at the bottom).
function NotesEditor({ bullets, onChange, onCommit, storageKey, overlay, slim, fill, dictating, onDictate }) {
  const [draft, setDraft] = useState('');
  const sw = useStopwatch(storageKey);
  // Overlay: bounded scroll window (~3 rows) pinned to the newest note, so 20+ notes
  // never grow the panel — the add-field below stays on screen.
  const listRef = useRef(null);
  useEffect(() => { if (overlay && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [overlay, bullets.length]);
  const addBullet = () => {
    const t = draft.trim();
    if (!t) return;
    onChange([...bullets, sw.running ? `[${clock(sw.elapsedRef.current)}] ${t}` : t]);
    setDraft(''); onCommit();
  };
  const setAt = (i, nb) => onChange(bullets.map((x, j) => (j === i ? nb : x)));
  const onText = (row, raw) => {
    const m = /^\[(\d{1,2}):([0-5]\d)\]\s*/.exec(raw);
    const atSec = m ? Number(m[1]) * 60 + Number(m[2]) : null;
    setAt(row._i, formatTimedBullet({ atSec, classification: row.classification, text: m ? raw.slice(m[0].length) : raw }));
  };
  const onRetag = (row, c) => setAt(row._i, formatTimedBullet({ atSec: row.atSec, classification: c, text: row.text }));
  const { ordered, untimedCount } = sortByTimeAsc(bullets.map((b, i) => ({ ...parseTimedNote(b), _i: i })), (x) => x.atSec);
  const firstUntimed = ordered.length - untimedCount;
  return (
    <div style={{ marginTop: overlay ? 0 : 8, marginBottom: overlay ? 'var(--cbtn-depth)' : candyGap(8, true), ...(fill ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : null) }}>
      {/* One compact control row: timer (slim-only — the clock keeps counting hidden,
          epoch math in useStopwatch) + Dictate. No "Notes" label — the list is self-evident. */}
      {(slim || (overlay && onDictate)) && (
        <div className="candy-center-row" style={{ gap: 8, marginBottom: 8 }}>
          {slim && <TimerControls sw={sw} />}
          {overlay && onDictate && (
            <button className={`candy-btn${dictating ? ' is-active' : ''}`} data-shape="chip" onClick={onDictate}
              title="Dictate a note — speech-to-text appended to this match">
              <span className="candy-face">{dictating ? 'Listening' : 'Dictate'}</span>
            </button>
          )}
        </div>
      )}
      <div ref={listRef} style={fill ? { flex: 1, overflowY: 'auto', minHeight: 0 } : overlay ? { maxHeight: 165, overflowY: 'auto', minHeight: 0 } : undefined}>
      {ordered.map((row, k) => (
        <div key={row._i}>
          {untimedCount > 0 && firstUntimed > 0 && k === firstUntimed && (
            <div style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '6px 0 2px' }}>Untimed</div>
          )}
          <div className="candy-center-row" style={{ gap: 6, marginBottom: candyGap(4, true) }}>
            <RetagButton label={row.classification} onPick={(c) => onRetag(row, c)} allowClear />
            <div className="candy-btn" data-shape="field" style={{ flex: 1, minWidth: 0 }}>
              <input
                className="candy-face"
                value={formatTimedBullet({ atSec: row.atSec, classification: null, text: row.text })}
                placeholder="note"
                onChange={(e) => onText(row, e.target.value)}
                onBlur={onCommit}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
              />
            </div>
            <button onClick={() => { onChange(bullets.filter((_, j) => j !== row._i)); onCommit(); }} title="Remove note" style={removeBtn}>×</button>
          </div>
        </div>
      ))}
      </div>
      <div className="candy-btn" data-shape="field" style={{ width: '100%', marginTop: 2 }}>
        <input
          className="candy-face"
          value={draft}
          placeholder={sw.running ? `Add a note  (stamped @ ${clock(sw.elapsedSec)})` : 'Add a note'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBullet(); } }}
        />
      </div>
    </div>
  );
}

// Collapsed-by-default per-team notes: a "Create Notes" button (mirrors "+ New Match")
// until opened — or auto-opened once the team already has notes (e.g. after a Classify→Save).
function TeamNotes({ team, bullets, onChange, onCommit, storageKey, overlay, slim, fill, dictating, onDictate }) {
  const [opened, setOpened] = useState(false);
  if (!slim && !opened && bullets.length === 0) {
    return (
      <button className="candy-btn" data-shape="row" onClick={() => setOpened(true)} style={{ width: '100%', marginTop: 8, marginBottom: candyGap(8) }}>
        <span className="candy-face" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><IconPlus size={14} /> Create Notes{team ? ` · ${team}` : ''}</span>
      </button>
    );
  }
  return <NotesEditor bullets={bullets} onChange={onChange} onCommit={onCommit} storageKey={storageKey} overlay={overlay} slim={slim} fill={fill} dictating={dictating} onDictate={onDictate} />;
}

function SaveTag({ state }) {
  const map = { saving: ['Saving', 'var(--text-muted)'], error: ['Save failed — edit to retry', 'var(--error)'] };
  const m = map[state];
  if (!m) return null;
  return <span style={{ fontSize: 11, color: m[1] }}>{m[0]}</span>;
}

// Renders the persisted ### Coaching Summary body — the count-suffix header,
// `#### <classification>` group headings, and `- ` bullets that renderCoachingSummary
// emits. A snapshot of the last Run Process; the _(…)_ marker line is hidden.
function CoachingSummaryView({ body }) {
  const items = [];
  let header = null;
  for (const raw of String(body || '').split('\n')) {
    const t = raw.trim();
    if (!t || /^_\(.*\)_$/.test(t)) continue;
    if (t.startsWith('#### ')) items.push({ type: 'group', text: t.slice(5) });
    else if (t.startsWith('- ')) items.push({ type: 'note', text: t.slice(2) });
    else if (!header) header = t;
  }
  if (!header && !items.length) return null;
  return (
    <div style={{ marginTop: 2 }}>
      {header && <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>{header}</div>}
      {items.map((it, i) => (it.type === 'group'
        ? <div key={i} style={{ ...labelStyle, color: it.text === 'Unclassified' ? 'var(--text-muted)' : 'var(--accent)', marginTop: 8, marginBottom: 3 }}>{it.text}</div>
        : <div key={i} style={{ ...valueStyle, fontSize: 13, display: 'flex', gap: 6, marginBottom: 2 }}><span style={{ color: 'var(--text-muted)' }}>•</span><span>{it.text}</span></div>))}
    </div>
  );
}

// classColor (label → sentiment tint) now lives in ./classColors.js, shared with
// RetagButton + ReviewModal so the color vocabulary stays in one place.

// Read-only AI provenance for one team from the .autoclass sidecar — the merged review
// output now lives in Notes (the canonical list), so this is collapsed history: what the
// AI suggested + your final review state, sorted by in-game time (untimed last). No
// actions here (retag/accept/drop happen in the review modal and on the Notes bullets).
function AutoClassificationView({ sidecarPath: scPath, team }) {
  const [sugg, setSugg] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.getRawFileMeta(scPath, 'gamewiki')
      .then((r) => { if (!cancelled) { const j = JSON.parse(r.content || '{}'); setSugg(j.teams?.[team]?.suggestions || []); } })
      .catch(() => { if (!cancelled) setSugg([]); });
    return () => { cancelled = true; };
  }, [scPath, team]);
  if (sugg == null) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading</div>;
  if (!sugg.length) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No AI provenance yet.</div>;
  const { ordered, untimedCount } = sortByTimeAsc(sugg, (s) => secFromClock(s.at));
  const firstUntimed = ordered.length - untimedCount;
  return (
    <div style={{ marginTop: 4 }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, padding: 0, fontFamily: 'var(--font-mono)' }}>
        {open ? '▾' : '▸'} AI provenance ({sugg.length})
      </button>
      {open && ordered.map((s, k) => {
        const dropped = s.review === 'rejected' || s.dropped;
        const label = s.userLabel || s.classification;
        return (
          <div key={s.momentId}>
            {untimedCount > 0 && firstUntimed > 0 && k === firstUntimed && (
              <div style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 0.5, margin: '4px 0 2px' }}>Untimed</div>
            )}
            <div style={{ display: 'flex', gap: 8, marginBottom: 6, opacity: dropped ? 0.4 : 0.85 }}>
              <span style={{ ...labelStyle, marginBottom: 0, color: classColor(label), minWidth: 76, textDecoration: dropped ? 'line-through' : 'none' }}>{label || '—'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {s.at || 'untimed'}{s.subject ? ` · ${s.subject}` : ''}{s.source ? ` · ${s.source}` : ''}{s.review && s.review !== 'pending' ? ` · ${s.review}` : ''}
                </div>
                <div style={{ ...valueStyle, fontSize: 13 }}>{s.rationale}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Silent-Death Audit (sub-plan 10) — coached-team deaths with no comms segment in the
// ~10 s before them: a missed-callout list. Pure cross-ref of the two sidecars the match
// already owns (.matchdata deaths × .commstranscript segments), no AI. Recording clock =
// game clock + the match's Comms Offset field (seconds of pre-game in the recording).
// Same sidecar-read machinery as AutoClassificationView / CommsTranscriptView.
function SilentDeathAudit({ matchSidecar, commsSidecar, side, offsetS }) {
  const [state, setState] = useState({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    Promise.all([
      api.getRawFileMeta(matchSidecar, 'gamewiki'),
      api.getRawFileMeta(commsSidecar, 'gamewiki'),
    ]).then(([md, cm]) => {
      if (cancelled) return;
      let raw;
      try { raw = JSON.parse(md.content); } catch { setState({ status: 'error' }); return; }
      const audit = auditSilentDeaths(extractSpatial(raw).deaths, parseSegments(cm.content), { side, offsetS });
      setState({ status: 'ready', audit });
    }).catch(() => { if (!cancelled) setState({ status: 'missing' }); });
    return () => { cancelled = true; };
  }, [matchSidecar, commsSidecar, side, offsetS]);

  const { status, audit } = state;
  if (status === 'loading') return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Checking callouts</div>;
  if (status === 'missing') return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Needs both match data and a comms transcript.</div>;
  if (status === 'error') return <div style={{ fontSize: 12, color: 'var(--error)' }}>Couldn’t parse the stored match data.</div>;
  if (!audit.total) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No coached-team deaths recorded.</div>;
  if (!audit.silent.length) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>All {audit.total} deaths had comms nearby.</div>;
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
        {audit.silent.length} of {audit.total} deaths had no comms in the 10 s before them:
      </div>
      {audit.silent.map((d, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 2, fontSize: 12.5 }}>
          <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{clock(d.t)}</span>
          <span style={{ color: 'var(--text)' }}>{d.hero}</span>
        </div>
      ))}
    </div>
  );
}

// Per-team roster editor (SF6 Comms Diarization) — the coached team's player names, stored in the
// team's voiceprint store + reused across that team's scrims. Add/remove/rename rows (candy fields);
// names seed the Speakers-panel + inline-relabel dropdowns. Renaming a row here does NOT move an
// existing voiceprint (prints are name-keyed — re-enroll under the new name from the Speakers panel).
function RosterEditor({ team, readStore, writeStore, onSaved }) {
  const [roster, setRoster] = useState(null); // null = loading
  const [draft, setDraft] = useState('');
  const storeRef = useRef({ roster: [], prints: {} });
  useEffect(() => {
    let cancelled = false;
    setRoster(null); setDraft('');
    if (!String(team || '').trim()) { setRoster([]); return undefined; }
    readStore(team).then((s) => { if (!cancelled) { storeRef.current = s; setRoster(s.roster || []); } })
      .catch(() => { if (!cancelled) setRoster([]); });
    return () => { cancelled = true; };
  }, [team, readStore]);
  const update = (names) => { storeRef.current = { ...storeRef.current, roster: names }; setRoster(names); };
  const commit = () => { writeStore(team, storeRef.current).then(() => onSaved?.(storeRef.current.roster)).catch(() => {}); };
  if (!String(team || '').trim()) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Set a Coached Team (below) to build its roster.</div>;
  if (roster == null) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading roster</div>;
  const addName = () => { const t = draft.trim(); setDraft(''); if (!t || roster.includes(t)) return; update([...roster, t]); commit(); };
  return (
    <div style={{ marginBottom: candyGap(8, true) }}>
      <div style={labelStyle}>Roster{team ? ` · ${team}` : ''}</div>
      {roster.map((n, i) => (
        <div key={i} className="candy-center-row" style={{ gap: 6, marginBottom: candyGap(4, true) }}>
          <div className="candy-btn" data-shape="field" style={{ flex: 1, minWidth: 0 }}>
            <input className="candy-face" value={n}
              onChange={(e) => update(roster.map((x, j) => (j === i ? e.target.value : x)))}
              onBlur={commit}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
          </div>
          <button onClick={() => { update(roster.filter((_, j) => j !== i)); commit(); }} title="Remove player" style={removeBtn}>×</button>
        </div>
      ))}
      <div className="candy-btn" data-shape="field" style={{ width: '100%', marginTop: 2 }}>
        <input className="candy-face" value={draft} placeholder="Add a player"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addName(); } }} />
      </div>
    </div>
  );
}

// Speakers panel (SF6) — one row per detected voice cluster → a roster-name dropdown, auto-filled
// where a voiceprint matched at extract time. Assigning enrolls/retrains that player's print and
// relabels every segment of the cluster (onReassign = ScrimViewer.reassignCluster). Reads the object
// .commstranscript sidecar; renders nothing for a legacy / no-diarization transcript.
function SpeakersPanel({ sidecarPath: scPath, roster, onReassign }) {
  const [vm, setVm] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.getRawFileMeta(scPath, 'gamewiki')
      .then((r) => { if (!cancelled) setVm(parseCommsSidecar(r.content)); })
      .catch(() => { if (!cancelled) setVm({ segments: [], clusters: [], micSpeaker: 'You' }); });
    return () => { cancelled = true; };
  }, [scPath]);
  if (!vm) return null;
  const clusters = vm.clusters || [];
  if (!clusters.length) return null;
  const options = [{ value: '', label: 'Unknown' }, ...roster.map((n) => ({ value: n, label: n }))];
  const labelOf = (cid) => { const s = (vm.segments || []).find((x) => Number(x.cluster) === Number(cid)); return s?.speaker || labelForCluster(cid, {}); };
  return (
    <div style={{ marginTop: 8 }}>
      <div style={labelStyle}>Speakers</div>
      {clusters.map((c) => {
        const cur = labelOf(c.clusterId);
        const val = roster.includes(cur) ? cur : '';
        return (
          <div key={c.clusterId} className="candy-center-row" style={{ gap: 8, marginBottom: candyGap(4, true) }}>
            <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', minWidth: 84, color: speakerColor(val) }}>{labelForCluster(c.clusterId, {})}</span>
            <CandySelect value={val} options={options} onChange={(n) => onReassign(c.clusterId, n)} title="Assign this voice to a player" placeholder={cur} compact />
          </div>
        );
      })}
    </div>
  );
}

// The scrim rail's collapse header — the shared CollapsibleRail's `header` slot (1-1 with
// the main nav's brand toggle, labelled with the matchup instead of the brand mark). Wears
// the same `.candy-btn.is-primary` brand block; collapsed shows an expand chevron.
function ScrimRailHeader({ expanded, matchup, accent, onToggle }) {
  const tip = expanded ? 'Collapse rail' : 'Expand rail';
  return (
    <div style={{ height: 'var(--brand-section-h)', flexShrink: 0, display: 'flex' }}>
      <button type="button" onClick={onToggle} data-own-press aria-label={tip} title={tip} aria-pressed={!expanded}
        className="candy-btn is-primary" data-shape="block" data-variant="brand" style={accent ? { '--accent': accent } : undefined}>
        <span className="candy-face" style={{ justifyContent: expanded ? 'flex-start' : 'center', padding: expanded ? '0 12px' : 0 }}>
          {expanded
            ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{matchup}</span>
            : <IconChevronRight size={16} />}
        </span>
      </button>
    </div>
  );
}

// One reveal-target row in the tree toolbar's Reveal popover.
function RevealRow({ label, onClick }) {
  return (
    <button type="button" className="candy-btn" data-shape="row" onClick={onClick} style={{ width: '100%' }}>
      <span className="candy-face" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><IconFileText size={16} /> {label}</span>
    </button>
  );
}

// `fill` (overlay only): the panel's height is user-pinned — in slim live mode the
// notes list drops its compact cap and flex-fills the pinned height instead.
export default function ScrimViewer({ path, accent, overlay = false, live = false, onLive, fill = false }) {
  const [scrim, setScrim] = useState(null);
  const [err, setErr] = useState(null);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const [runningN, setRunningN] = useState(null); // match.n with an in-flight Run Process
  const [commsN, setCommsN] = useState(null); // match.n with an in-flight Extract Comms
  const [commsPhase, setCommsPhase] = useState(''); // status label while extracting/transcribing
  const [vodBusy, setVodBusy] = useState(false); // scrim-level Extract VOD Comms in flight (sub-plan 11)
  const [vodPhase, setVodPhase] = useState(''); // status label while extracting the VOD Review
  const [reporting, setReporting] = useState(false); // Generate Report (Claude) in flight (sub-plan 11)
  const [reportPhase, setReportPhase] = useState(''); // pipeline phase label on the report button face (Move 15)
  const [reviewingN, setReviewingN] = useState(null); // match.n with an in-flight Review Comms (sub-plan 13)
  const [tfOpen, setTfOpen] = useState(null); // { n } → TeamfightCommsView popup open for that match
  const [tfReady, setTfReady] = useState(() => new Set()); // match.ns with a cached .tfcomms review
  const [sttUp, setSttUp] = useState(true); // speech engine reachable (stt_status non-null)
  const [matchPopup, setMatchPopup] = useState(null); // { n } of the match whose full view is open
  const [review, setReview] = useState(null); // { idx, teamName, items } — active merge-review modal
  const [classifyingN, setClassifyingN] = useState(null); // match.n with an in-flight Classify (AI)
  const [classifyPhase, setClassifyPhase] = useState(''); // status label while classifying
  const [aiConfigured, setAiConfigured] = useState(true); // an Anthropic key or claude CLI is available
  const classifyRef = useRef(false); // Classify double-fire guard
  const { settings } = useSettings();
  // Overlay mode: which match the header picker focuses + a live-dictation flag.
  const [focusedN, setFocusedN] = useState(null);
  const [dictating, setDictating] = useState(false);
  // Slim live mode (Live chip → panel-head Exit Live): hide everything but
  // head/notes/voice/timer while spectating in-game. State lives in
  // ScrimOverlayPanel (live/onLive props) so the panel head can exit it.
  const slim = overlay && live;
  // SF6 Comms Diarization: coached-team roster (Speakers panel + inline-relabel dropdowns), your
  // mic-track name, the global track defaults (field placeholders), + a bump key that remounts the
  // comms views after a cluster relabel (the opaque summary text is unchanged, so its key alone won't).
  const [coachedRoster, setCoachedRoster] = useState([]);
  const [yourName, setYourName] = useState(loadYourName);
  const [trackDefaults, setTrackDefaults] = useState(loadTrackDefaults);
  const [commsRelabelKey, setCommsRelabelKey] = useState(0);
  const matchFocusRef = useRef(null); // fresh focusedN for event-listener closures
  useEffect(() => { matchFocusRef.current = focusedN; }, [focusedN]);

  // Scrim Tree Consolidation (2026-07-14): the pane view (match card vs report tab,
  // per-scrim persisted), the report tab list (published by the inline VodReportView),
  // the collapsible left rail (global expanded flag + width, 1-1 with the main nav), and
  // the tree-toolbar composition popups (settings modal · scrim popup · reveal popover).
  const [view, setView] = useState(null); // {kind:'match',n} | {kind:'report',tab}; null until scrim loads
  const [reportTabs, setReportTabs] = useState(DEFAULT_REPORT_TABS);
  const [railExpanded, setRailExpanded] = useState(loadRailExpanded);
  const [railWidth, setRailWidth] = useState(loadRailWidth);
  const [railResizing, setRailResizing] = useState(false);
  // Live mode rail — this LOCAL flag drives the rail in slim WITHOUT touching the
  // persisted railExpanded (which is 1-1 with the main-nav; mutating it would pollute
  // the main window). On every live toggle it re-seeds: collapsed when the
  // scrimLiveAutoCollapse setting is on, else whatever the rail was (default off).
  // The setting is read FRESH from localStorage — the overlay host is a separate
  // webview, so useSettings' in-webview change event never reaches it.
  const [liveRailOpen, setLiveRailOpen] = useState(false);
  useEffect(() => {
    let auto = false;
    try { auto = JSON.parse(localStorage.getItem('focus_settings') || '{}').scrimLiveAutoCollapse === true; } catch { /* default: keep rail */ }
    setLiveRailOpen(auto ? false : railExpanded);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only on live toggle
  }, [live]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scrimOpen, setScrimOpen] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  const [revealAnchor, setRevealAnchor] = useState(null);
  const railPeek = useKeybindHold('sidebar.peek-left', settings?.keybinds);
  const treeExp = useTreeExpansion('gw-scrim-tree', ['matches', 'report', 'coaching']);

  const scrimRef = useRef(null);
  const runningRef = useRef(false); // Run Process double-fire guard
  const commsRef = useRef(false); // Extract Comms double-fire guard
  const vodRef = useRef(false); // Extract VOD Comms double-fire guard (sub-plan 11)
  const reportRef = useRef(false); // Generate Report double-fire guard (sub-plan 11)
  const tfRef = useRef(false); // Review Comms double-fire guard (sub-plan 13)
  const saveTimer = useRef(null);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  const lastSavedRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const setSafeSaveState = (s) => { if (mountedRef.current) setSaveState(s); };

  // Probe the STT engine on mount + on every supervisor status change, so Extract Comms
  // disables (with a hint) when the speech engine is down. stt_status returns null when the
  // sidecar is unreachable. Feature-detect only — no import from modules/studio/stt/.
  useEffect(() => {
    const probe = () => invoke('stt_status')
      .then((s) => { if (mountedRef.current) setSttUp(s != null); })
      .catch(() => { if (mountedRef.current) setSttUp(false); });
    probe();
    // Chain unlisten onto the registration promise — a plain `unlisten` var is
    // still null if we unmount before `listen` resolves, orphaning the listener.
    const sub = listen('stt-engine-status', probe);
    return () => { sub.then((un) => un()).catch(() => {}); };
  }, []);

  // AI backend availability — the Classify (AI) button disables (with a hint) when neither
  // an Anthropic key nor a resolvable `claude` CLI is configured. Mirrors useSettings' v1.5
  // backend auto-detect; re-checks when the configured CLI path changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hasKey = await invoke('design_get_api_key').catch(() => false);
      if (hasKey) { if (!cancelled) setAiConfigured(true); return; }
      const cli = await invoke('design_cli_auth_status', { cliPath: settings?.agents?.claudeCliPath || '' }).catch(() => null);
      // Only flip to unavailable on a concrete answer; an errored check stays optimistic
      // (the classify call surfaces a clear AUTH toast if a backend is genuinely missing).
      if (!cancelled && cli) setAiConfigured(!!cli.installed);
    })();
    return () => { cancelled = true; };
  }, [settings?.agents?.claudeCliPath]);

  // Writeback: re-read fresh (opaque-region truth + fresh mtime) -> merge local box
  // edits -> serialize -> savePage with the just-read mtime. Conflict (a write landed
  // between our read and write) retries once. Serializes overlapping saves.
  const doSave = useCallback(async () => {
    const local = scrimRef.current;
    if (!local) return;
    if (savingRef.current) { pendingRef.current = true; return; }
    savingRef.current = true;
    setSafeSaveState('saving');
    try {
      let fresh = local, freshMtime = null;
      try { const r = await api.getRawFileMeta(path, 'gamewiki'); fresh = parseScrim(r.content); freshMtime = r.mtime ?? null; }
      catch { /* file missing/new — write local as-is */ }
      const content = serializeScrim(mergeScrim(local, fresh));
      if (content === lastSavedRef.current) { setSafeSaveState('saved'); }
      else {
        try {
          await api.savePage(path, content, freshMtime, 'gamewiki');
          lastSavedRef.current = content;
          setSafeSaveState('saved');
        } catch (e) {
          if (e?.code === 'CONFLICT') {
            const r2 = await api.getRawFileMeta(path, 'gamewiki');
            const content2 = serializeScrim(mergeScrim(scrimRef.current, parseScrim(r2.content)));
            await api.savePage(path, content2, r2.mtime ?? null, 'gamewiki');
            lastSavedRef.current = content2;
            setSafeSaveState('saved');
          } else { console.error('scrim save failed', e); setSafeSaveState('error'); }
        }
      }
    } finally {
      savingRef.current = false;
      if (pendingRef.current) { pendingRef.current = false; doSave(); }
    }
  }, [path]);

  const scheduleSave = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => doSave(), SAVE_DEBOUNCE_MS);
  }, [doSave]);
  const flushSave = useCallback(() => { clearTimeout(saveTimer.current); doSave(); }, [doSave]);

  const applyEdit = useCallback((mutator) => {
    const next = mutator(scrimRef.current);
    scrimRef.current = next;
    setScrim(next);
    scheduleSave();
  }, [scheduleSave]);

  // Run Process — fetch the match's deadlock-api metadata, store the raw JSON verbatim
  // in the .matchdata sidecar, write a summary + pointer into ### Match Data (data half),
  // and compile the coached team's tagged notes into ### Coaching Summary (note half).
  // Both subsections are opaque/disk-owned (mergeScrim pulls them fresh), so they're
  // written straight to disk — an applyEdit would be dropped on save. The two opaque
  // writes are ordered before ONE serialize/save so neither clobbers the other.
  const runProcess = useCallback(async (idx) => {
    const m = scrimRef.current?.matches?.[idx];
    if (!m || runningRef.current) return;
    const matchId = String(m.fields['Match ID'] || '').trim();
    if (!matchId) { notify('error', 'Match ID required', 'Enter a Match ID for this match first.'); return; }
    if (!/^\d+$/.test(matchId)) { notify('error', 'Invalid Match ID', 'Match ID must be a number.'); return; }

    runningRef.current = true; setRunningN(m.n);
    try {
      // flush any pending box edit so the on-disk file is current before we merge
      clearTimeout(saveTimer.current);
      if (serializeScrim(scrimRef.current) !== lastSavedRef.current) await doSave();

      const data = await invoke('deadlock_fetch_match', { matchId });

      // 1) raw JSON → sidecar (verbatim source of truth; null mtime = overwrite freely)
      const scPath = sidecarPath(path, m.n);
      await api.savePage(scPath, JSON.stringify(data), null, 'gamewiki');

      // 2) summary + pointer → ### Match Data, compiled notes → ### Coaching Summary
      //    (both disk-owned; one merged write/save; retry once on conflict)
      const body = renderSummary(data, scPath.split('/').pop());
      // Auto-fill from the deadlock-api payload (paste-Match-ID → fill Score + Time):
      // this match's Time from start_time, and the series Score as the coached team's
      // W–L across all fetched matches. Both are non-opaque editable fields, so
      // mergeScrim keeps them; overwrite on each run.
      const autoTime = fmtLocalTime(extractMeta(data).startTime);
      const deriveScore = async (scrimObj, coached) => {
        let w = 0, l = 0, any = false;
        for (const mm of scrimObj.matches || []) {
          const { coachedSide } = sideFromTeamFields(mm.fields, coached);
          if (coachedSide == null) continue; // Amber/Sapphire not set → can't tell the side
          let winner = null;
          if (mm.n === m.n) winner = extractMeta(data).winningTeam;
          else { try { const sr = await api.getRawFileMeta(sidecarPath(path, mm.n), 'gamewiki'); winner = extractMeta(JSON.parse(sr.content)).winningTeam; } catch { winner = null; } }
          if (winner == null) continue; // unfetched match → skip
          any = true; if (winner === coachedSide) w++; else l++;
        }
        return any ? `${w}-${l}` : null;
      };
      const writeMd = async () => {
        const r = await api.getRawFileMeta(path, 'gamewiki').catch(() => null);
        const fresh = r ? parseScrim(r.content) : scrimRef.current;
        let base = mergeScrim(scrimRef.current, fresh);
        const coached = base.frontmatter?.['Coached Team'] || base.frontmatter?.['Team 1'] || '';
        if (autoTime) base = { ...base, matches: base.matches.map((mm) => (mm.n === m.n ? { ...mm, fields: { ...mm.fields, Time: autoTime } } : mm)) };
        const score = await deriveScore(base, coached);
        if (score != null) base = { ...base, scrim: { ...base.scrim, Score: score } };
        const notes = getNotes(base.matches.find((mm) => mm.n === m.n));
        const summaryBody = renderCoachingSummary(compileNotes(notes?.bullets || []));
        const merged = setCoachingSummaryBody(setMatchDataBody(base, m.n, body), m.n, summaryBody);
        const content = serializeScrim(merged);
        await api.savePage(path, content, r?.mtime ?? null, 'gamewiki');
        lastSavedRef.current = content; scrimRef.current = merged; setScrim(merged);
      };
      try { await writeMd(); } catch (e) { if (e?.code === 'CONFLICT') await writeMd(); else throw e; }

      notify('success', 'Run Process complete', `Match ${matchId} — data + notes compiled.`);
    } catch (e) {
      const msg = {
        NOT_FOUND: ['No such match', `deadlock-api has no match ${matchId}.`],
        RATE_LIMITED: ['Rate limited', 'deadlock-api is rate-limiting — wait a moment and retry.'],
        NETWORK: ['Network error', e?.message || 'Could not reach deadlock-api.'],
        INVALID: ['Invalid Match ID', e?.message || 'Match ID must be a number.'],
        UPSTREAM: ['deadlock-api error', e?.message || 'Unexpected response from deadlock-api.'],
      }[e?.code] || ['Run Process failed', e?.message || String(e)];
      notify('error', msg[0], msg[1]);
    } finally {
      runningRef.current = false; setRunningN(null);
    }
  }, [path, doSave]);

  // Read/write the coached team's voiceprint store (SF6): roster + saved prints, per team, reused
  // across scrims. Missing file → empty store (first run). Prints are L2-normalized (voiceprints.js).
  const readTeamStore = useCallback(async (team) => {
    if (!String(team || '').trim()) return { roster: [], prints: {} };
    try { const r = await api.getRawFileMeta(teamStorePath(team), 'gamewiki'); return parseVoiceprints(r.content); }
    catch { return { roster: [], prints: {} }; }
  }, []);
  const writeTeamStore = useCallback(async (team, store) => {
    if (!String(team || '').trim()) return;
    // The Teams/<Team>/ subdir is created on first write (vault_write_file → atomic_write mkdir-parents).
    await api.savePage(teamStorePath(team), JSON.stringify({ roster: store.roster || [], prints: store.prints || {} }), null, 'gamewiki');
  }, []);

  // Write the opaque ### Comms Transcript summary for match n (disk-owned; merged write behind the
  // fresh-mtime conflict guard, retry once) — shared by Extract Comms + a cluster relabel.
  const writeCommsOpaque = useCallback(async (n, body) => {
    const doWrite = async () => {
      const r = await api.getRawFileMeta(path, 'gamewiki').catch(() => null);
      const fresh = r ? parseScrim(r.content) : scrimRef.current;
      const merged = setCommsTranscriptBody(mergeScrim(scrimRef.current, fresh), n, body);
      const content = serializeScrim(merged);
      await api.savePage(path, content, r?.mtime ?? null, 'gamewiki');
      lastSavedRef.current = content; scrimRef.current = merged; setScrim(merged);
    };
    try { await doWrite(); } catch (e) { if (e?.code === 'CONFLICT') await doWrite(); else throw e; }
  }, [path]);

  // Post-process + persist a finished MATCH comms job (the fast, pure-JS half): match clusters
  // vs the coached team's saved voiceprints (auto-LABEL only — enrollment happens on an explicit
  // Speakers-panel assignment), align comms text to clusters, merge mic ∪ comms by time → the
  // object .commstranscript sidecar + the opaque ### Comms Transcript. `diarization: null` ⇒ the
  // legacy single-downmix run (no comms track): speaker-null transcript, unchanged behavior.
  const finishMatchJob = useCallback(async (matchN, result) => {
    const m = (scrimRef.current?.matches || []).find((x) => x.n === matchN);
    if (!m) return;
    const scPath = sidecarPath(path, matchN, 'comms');
    // Persist the sidecar payload + the opaque ### Comms Transcript summary (segs = the merged list).
    const finishOpaque = async (segs, payload) => {
      setCommsPhase('Saving');
      await api.savePage(scPath, JSON.stringify(payload), null, 'gamewiki');
      const durationS = segs.length ? Math.max(...segs.map((s) => Number(s.t1Ms) || 0)) / 1000 : 0;
      const body = renderCommsSummary({ n: matchN, segments: segs, durationS, sidecarFileName: scPath.split('/').pop() });
      await writeCommsOpaque(matchN, body);
    };
    const micNote = result.micSkipped ? ' · mic silent, skipped' : '';
    if (!result.diarization) {
      const raw = result.commsSegments || [];
      const segs = raw.length ? raw : (result.commsFinalText ? [{ t0Ms: 0, t1Ms: 0, text: result.commsFinalText }] : []);
      await finishOpaque(segs, segs.map((seg) => ({ ...seg, speaker: null, cluster: null })));
      notify('success', 'Comms extracted', `Match ${m.fields['Match ID'] || matchN} — ${segs.length} segment${segs.length === 1 ? '' : 's'} transcribed.`);
      return;
    }
    const fmNow = scrimRef.current?.frontmatter || {};
    const coachedTeam = fmNow['Coached Team'] || fmNow['Team 1'] || '';
    const store = await readTeamStore(coachedTeam);
    const nameMap = matchClusters(result.diarization.clusters || [], store.prints || {}, DEFAULT_THRESHOLD);
    const diarSpans = result.diarization.segments || [];
    const aligned = alignDiarization(result.commsSegments || [], diarSpans);
    const yourName = loadYourName() || 'You';
    const merged = mergeTranscripts({ micSegments: result.micSegments || [], commsSegments: aligned, micSpeaker: yourName, nameMap });
    await finishOpaque(merged, buildCommsSidecar({ segments: merged, clusters: result.diarization.clusters || [], micSpeaker: yourName }));
    const voices = result.diarization.numSpeakers ?? (result.diarization.clusters || []).length;
    const named = Object.values(nameMap).filter(Boolean).length;
    notify('success', 'Comms extracted', `Match ${m.fields['Match ID'] || matchN} — ${merged.length} segments · ${voices} voice${voices === 1 ? '' : 's'}${named ? ` · ${named} auto-named` : ''}${micNote}.`);
  }, [path, readTeamStore, writeCommsOpaque]);

  // Post-process + persist a finished VOD comms job: one .vodcomms sidecar for the whole scrim
  // + a `- VOD Comms:` pointer bullet under ## Scrim (which can't hold ### subsections).
  const finishVodJob = useCallback(async (result) => {
    const fmNow = scrimRef.current?.frontmatter || {};
    const coachedTeam = fmNow['Coached Team'] || fmNow['Team 1'] || '';
    const store = await readTeamStore(coachedTeam);
    const nameMap = matchClusters(result.diarization?.clusters || [], store.prints || {}, DEFAULT_THRESHOLD);
    const vodSpans = result.diarization?.segments || [];
    const aligned = alignDiarization(result.commsSegments || [], vodSpans);
    const coachName = loadYourName() || 'Coach';
    const merged = mergeTranscripts({ micSegments: result.micSegments || [], commsSegments: aligned, micSpeaker: coachName, nameMap });
    const scPath = scrimSidecarPath(path, 'vodcomms');
    setVodPhase('Saving');
    await api.savePage(scPath, JSON.stringify(buildCommsSidecar({ segments: merged, clusters: result.diarization?.clusters || [], micSpeaker: coachName })), null, 'gamewiki');
    const stamp = new Date().toISOString().slice(0, 10);
    applyEdit((p) => ({ ...p, scrim: { ...p.scrim, 'VOD Comms': `extracted ${stamp} · ${merged.length} segments` } }));
    flushSave();
    const voices = result.diarization?.numSpeakers ?? (result.diarization?.clusters || []).length;
    const named = Object.values(nameMap).filter(Boolean).length;
    notify('success', 'VOD comms extracted', `${merged.length} segments · ${voices} voice${voices === 1 ? '' : 's'}${named ? ` · ${named} auto-named` : ''}${result.micSkipped ? ' · coach mic silent, skipped' : ''}.`);
  }, [path, readTeamStore, applyEdit, flushSave]);

  // Extract Comms (SF6 + gate-blocker 2 "reattachable job") — one click starts the RUST-owned
  // comms job (comms_job_start: extract tracks → silence-probe mic → load model → transcribe →
  // diarize). The job survives webview reloads/teardowns (the dev overlay reloads on every
  // Shift+C show); the comms-job bridge effect below owns ALL completion handling
  // (finishMatchJob), so fresh runs and re-attached runs share one path. With NO comms track
  // set the job degrades to the legacy single-downmix, speaker-null run (old recordings).
  const extractComms = useCallback(async (idx) => {
    const m = scrimRef.current?.matches?.[idx];
    if (!m || commsRef.current) return;
    const video = String(m.fields['Scrim Recording'] || '').trim();
    if (!video) { notify('error', 'No recording', 'Set a Scrim Recording (.mp4) for this match first.'); return; }
    let up = false;
    try { up = (await invoke('stt_status')) != null; } catch { up = false; }
    if (!up) { setSttUp(false); notify('error', 'Speech engine unavailable', 'The transcription engine is not running — reopen the app and try again.'); return; }

    const fmNow = scrimRef.current?.frontmatter || {};
    const defs = loadTrackDefaults();
    const commsIdx = trackIndex(fmNow['Comms Track'] ?? defs.comms);
    const micIdx = trackIndex(fmNow['Mic Track'] ?? defs.mic);

    commsRef.current = true;
    setCommsN(m.n); setCommsPhase('Extracting audio');
    try {
      // flush any pending box edit so the on-disk file is current before the final merge
      clearTimeout(saveTimer.current);
      if (serializeScrim(scrimRef.current) !== lastSavedRef.current) await doSave();
      // fixed-K diarization = coached roster size (caps phantom clusters); no roster →
      // cap at 8 (6 players + coach + margin) — uncapped auto-clustering on a long track
      // explodes the cluster count (and the result payload).
      const coachedTeam = fmNow['Coached Team'] || fmNow['Team 1'] || '';
      const store = await readTeamStore(coachedTeam);
      await invoke('comms_job_start', {
        video, commsTrack: commsIdx, micTrack: micIdx, model: STT_MODEL,
        maxSpeakers: (store.roster || []).length || 8, scrimPath: path, kind: 'match', matchN: m.n,
      });
    } catch (e) {
      commsRef.current = false; setCommsN(null); setCommsPhase('');
      notify('error', 'Extract Comms failed', e?.message || String(e));
    }
  }, [path, doSave, readTeamStore]);

  // Cancel the in-flight comms job — Rust raises the engine cancel; the terminal
  // comms-job-done {cancelled:true} event clears the busy UI.
  const cancelComms = useCallback(() => {
    if (!commsRef.current) return;
    setCommsPhase('Cancelling');
    invoke('comms_job_cancel').catch(() => {});
  }, []);

  // Extract VOD Comms (sub-plan 11) — the scrim-level twin of extractComms for the post-match VOD
  // Review recording: the SAME Rust-owned comms job (kind 'vod'; mic track = coach/you, Discord
  // track = the combined team), scrim-scoped. Completion lands in finishVodJob via the bridge
  // effect. No speaker-blind path: the comms track is required.
  const extractVodComms = useCallback(async () => {
    if (vodRef.current) return;
    const video = String(scrimRef.current?.scrim?.['VOD Review'] || '').trim();
    if (!video) { notify('error', 'No VOD recording', 'Set a VOD Review (.mp4) for this scrim first.'); return; }
    let up = false;
    try { up = (await invoke('stt_status')) != null; } catch { up = false; }
    if (!up) { setSttUp(false); notify('error', 'Speech engine unavailable', 'The transcription engine is not running — reopen the app and try again.'); return; }

    const fmNow = scrimRef.current?.frontmatter || {};
    const defs = loadTrackDefaults();
    const commsIdx = trackIndex(fmNow['Comms Track'] ?? defs.comms);
    const micIdx = trackIndex(fmNow['Mic Track'] ?? defs.mic);
    if (commsIdx == null) { notify('error', 'No comms track', 'Set the Comms Track (the Discord audio track index) so the team voices can be separated.'); return; }

    vodRef.current = true;
    setVodBusy(true); setVodPhase('Extracting audio');
    try {
      clearTimeout(saveTimer.current);
      if (serializeScrim(scrimRef.current) !== lastSavedRef.current) await doSave();
      // fixed-K diarization = coached roster size (caps phantom clusters); no roster →
      // cap at 8, same rationale as extractComms.
      const coachedTeam = fmNow['Coached Team'] || fmNow['Team 1'] || '';
      const store = await readTeamStore(coachedTeam);
      await invoke('comms_job_start', {
        video, commsTrack: commsIdx, micTrack: micIdx, model: STT_MODEL,
        maxSpeakers: (store.roster || []).length || 8, scrimPath: path, kind: 'vod', matchN: null,
      });
    } catch (e) {
      vodRef.current = false; setVodBusy(false); setVodPhase('');
      notify('error', 'Extract VOD Comms failed', e?.message || String(e));
    }
  }, [path, doSave, readTeamStore]);

  const cancelVod = useCallback(() => {
    if (!vodRef.current) return;
    setVodPhase('Cancelling');
    invoke('comms_job_cancel').catch(() => {});
  }, []);

  // Comms-job bridge (gate-blocker 2): follow + finish the Rust-owned comms job from ANY mount.
  // (a) On mount, comms_job_status re-attaches — a running job restores the busy UI, a
  // done-unconsumed one is finished right here (e.g. the job outlived a dev overlay reload or a
  // closed window). (b) The global comms-job-progress / comms-job-done events drive live phase
  // text + completion. comms_job_take is take-once under the Rust mutex, so with both the main
  // window and the overlay mounted only ONE consumer post-processes; the other's take returns
  // null and it just clears its busy UI.
  useEffect(() => {
    let dead = false;
    const phaseText = (p) => `${p.phase}${p.pct != null ? ` ${Math.round(p.pct)}%` : ''}`;
    const showBusy = (p) => {
      if (p.kind === 'vod') { vodRef.current = true; setVodBusy(true); setVodPhase(phaseText(p)); }
      else { commsRef.current = true; setCommsN(p.matchN); setCommsPhase(phaseText(p)); }
    };
    const clearBusy = (kind) => {
      if (kind === 'vod') { vodRef.current = false; setVodBusy(false); setVodPhase(''); }
      else { commsRef.current = false; setCommsN(null); setCommsPhase(''); }
    };
    const finish = async (kind, matchN) => {
      const result = await invoke('comms_job_take').catch(() => null);
      if (!result) { clearBusy(kind); return; } // another mounted ScrimViewer consumed it
      try {
        if (kind === 'vod') await finishVodJob(result);
        else await finishMatchJob(matchN, result);
      } catch (e) {
        notify('error', kind === 'vod' ? 'Extract VOD Comms failed' : 'Extract Comms failed', e?.message || String(e));
      } finally { clearBusy(kind); }
    };
    (async () => {
      const st = await invoke('comms_job_status').catch(() => null);
      if (dead || !st || st.scrimPath !== path) return;
      if (st.status === 'running') showBusy(st);
      else if (st.status === 'done') { showBusy(st); await finish(st.kind, st.matchN); }
      else {
        // stale error/cancelled job whose done event died with the old webview
        await invoke('comms_job_clear').catch(() => {});
        if (st.status === 'error') notify('error', st.kind === 'vod' ? 'Extract VOD Comms failed' : 'Extract Comms failed', st.error || 'unknown error');
      }
    })();
    // Chain unlisten onto the registration promises — a plain `unlisten` var is still
    // null if we unmount before `listen` resolves, orphaning the listener.
    const subs = [
      listen('comms-job-progress', (e) => {
        const p = e.payload || {};
        if (p.scrimPath !== path || p.status !== 'running') return;
        showBusy(p);
      }),
      listen('comms-job-done', (e) => {
        const p = e.payload || {};
        if (p.scrimPath !== path) return;
        if (p.ok) { finish(p.kind, p.matchN); return; }
        invoke('comms_job_clear').catch(() => {});
        clearBusy(p.kind);
        if (p.cancelled) notify('success', p.kind === 'vod' ? 'VOD comms cancelled' : 'Comms cancelled', 'Transcription was cancelled — nothing saved.');
        else notify('error', p.kind === 'vod' ? 'Extract VOD Comms failed' : 'Extract Comms failed', p.error || 'unknown error');
      }),
    ];
    return () => { dead = true; subs.forEach((s) => s.then((un) => un())); };
  }, [path, finishMatchJob, finishVodJob]);

  // Team Progress (sub-plan 12) — cross-scrim memory. Walk every scrim for this team, read each one's
  // .vodreport (action items) + per-match .matchdata/.commstranscript sidecars, compute team-level
  // metrics (deaths/buffs/obj/soul + callout rate + silent-death count), aggregate into the
  // .teamprogress.<Team>.json sidecar, and regenerate the app-owned Teams/<Team>.md page. Client-side
  // walk, no new Rust; the page is fully generated (never hand-edited) so a plain overwrite is safe.
  // Runs after each Generate Report. Team-level metrics only — match data has no player names.
  const updateTeamProgress = useCallback(async (team) => {
    if (!String(team || '').trim()) return null;
    try {
      const res = await api.getVaultFolder('Deadlock', 'Coaching/Scrim', 'gamewiki').catch(() => null);
      const pages = (res?.pages || []).map((p) => String(p.path || '').replace(/^\/+/, ''));
      const scrims = [];
      for (const pagePath of pages) {
        let sc;
        try { sc = parseScrim((await api.getRawFileMeta(pagePath, 'gamewiki')).content); } catch { continue; }
        const fm = sc.frontmatter || {};
        const coached = fm['Coached Team'] || fm['Team 1'] || '';
        if (normIssue(coached) !== normIssue(team)) continue; // not this team's scrim

        let report = null;
        try { report = JSON.parse((await api.getRawFileMeta(scrimSidecarPath(pagePath, 'vodreport'), 'gamewiki')).content); } catch { /* no report yet */ }

        const perMatch = [];
        let segTotal = 0, durTotalS = 0, silentTotal = 0, haveComms = false;
        let tfFights = 0, tfJumbled = 0, tfMissed = 0, haveTf = false; // sub-plan 13 comms review
        for (const m of sc.matches || []) {
          const { coachedSide } = sideFromTeamFields(m.fields, coached);
          if (coachedSide == null) continue;
          let raw = null;
          try { raw = JSON.parse((await api.getRawFileMeta(sidecarPath(pagePath, m.n), 'gamewiki')).content); } catch { continue; }
          perMatch.push(matchMetrics(raw, coachedSide));
          try {
            const cm = (await api.getRawFileMeta(sidecarPath(pagePath, m.n, 'comms'), 'gamewiki')).content;
            const segs = parseSegments(cm);
            haveComms = true;
            segTotal += segs.filter((s) => String(s.text || '').trim()).length;
            durTotalS += segs.length ? Math.max(...segs.map((s) => Number(s.t1Ms) || 0)) / 1000 : 0;
            const offsetS = Number(m.fields['Comms Offset']) || 0;
            silentTotal += auditSilentDeaths(extractSpatial(raw).deaths, segs, { side: coachedSide, offsetS }).silent.length;
          } catch { /* no comms for this match */ }
          try {
            const tf = JSON.parse((await api.getRawFileMeta(sidecarPath(pagePath, m.n, 'tfcomms'), 'gamewiki')).content);
            const s = tf.summary || summarize(tf.fights || []);
            if (s.fights) { haveTf = true; tfFights += s.fights; tfJumbled += (s.jumbled || 0); tfMissed += (s.missed || 0); }
          } catch { /* no comms review for this match */ }
        }
        if (!perMatch.length && !report) continue;
        const metrics = {
          ...sumMatchMetrics(perMatch),
          calloutRate: haveComms && durTotalS > 0 ? Math.round((segTotal / (durTotalS / 60)) * 10) / 10 : null,
          silentDeaths: haveComms ? silentTotal : null,
          commsJumbled: haveTf && tfFights ? Math.round((tfJumbled / tfFights) * 100) / 100 : null,
          commsMissed: haveTf && tfFights ? Math.round((tfMissed / tfFights) * 100) / 100 : null,
        };
        scrims.push({ date: fm['Date'] || '', report, metrics });
      }
      const agg = aggregateTeam({ team, scrims });
      const stamp = new Date().toISOString().slice(0, 10);
      agg.updated = stamp;
      await api.savePage(teamSidecarPath(team), JSON.stringify(agg), null, 'gamewiki');
      await api.savePage(teamPagePath(team), renderTeamPage(agg, stamp), null, 'gamewiki');
      return agg;
    } catch (e) { console.error('team progress update failed', e); return null; }
  }, []);

  // Generate Report (sub-plan 11) — read the cached .vodcomms transcript, have Claude (Opus, via the
  // generic coaching_classify_match bridge) organize it into the report JSON, reconcile the coach's
  // checkbox state onto it, persist the .vodreport sidecar + a `- VOD Report:` pointer bullet, and
  // open VodReportView. Re-runnable without re-transcribing. priorActionItems stays [] until sub-plan
  // 12 (Team Progress) feeds it — the follow-up block is empty-tolerant. Mirrors classify()'s backend
  // resolution + sidecar reconcile discipline.
  const generateVodReport = useCallback(async () => {
    if (reportRef.current) return;
    const commsPath = scrimSidecarPath(path, 'vodcomms');
    let segments;
    try { segments = parseCommsSidecar((await api.getRawFileMeta(commsPath, 'gamewiki')).content).segments; }
    catch { notify('error', 'No VOD comms', 'Extract VOD Comms first — the report reads that transcript.'); return; }
    if (!segments.length) { notify('error', 'Empty transcript', 'The VOD comms transcript has no segments to report on.'); return; }

    reportRef.current = true; setReporting(true);
    try {
      const fm = scrimRef.current?.frontmatter || {};
      const coachedTeam = fm['Coached Team'] || fm['Team 1'] || '';
      const opponent = (fm['Team 1'] === coachedTeam ? fm['Team 2'] : fm['Team 1']) || '';

      // resolve backend (mirror classify: honor settings.agents, fall back to key-detect)
      const ag = settings?.agents || {};
      let backend = ag.authBackend;
      if (!backend) backend = (await invoke('design_get_api_key').catch(() => false)) ? 'api-key' : 'claude-cli';
      const agents = { authBackend: backend, model: ag.model || 'opus', claudeCliPath: ag.claudeCliPath || '' };

      // prior report → carry checkbox state across regenerates.
      const scPath = scrimSidecarPath(path, 'vodreport');
      let prior = null;
      try { prior = JSON.parse((await api.getRawFileMeta(scPath, 'gamewiki')).content); } catch { /* first run */ }

      // cross-scrim follow-up loop (sub-plan 12): the team's currently-open homework feeds the report
      // prompt so Claude judges each prior item resolved/persisting. Empty until a team page exists.
      let priorActionItems = [];
      try { priorActionItems = openHomework(JSON.parse((await api.getRawFileMeta(teamSidecarPath(coachedTeam), 'gamewiki')).content)); } catch { /* no team memory yet */ }

      // player-written notes (.vodnotes sidecar, filled by the popup's Add Notes button) —
      // supplementary source material for the report's topic sections; missing-tolerant.
      let notesBlock = '';
      try { notesBlock = (await api.getRawFileMeta(scrimSidecarPath(path, 'vodnotes'), 'gamewiki')).content; } catch { /* no notes */ }

      // ── Analyst pipeline (Moves 6/8/9/10/11): brain + digests + normalize → draft → verify ──
      setReportPhase('Normalizing');
      // lexicon, auto-refreshed when >7 days stale (no AI — folder enumeration + re-render)
      let lexicon = '';
      try {
        lexicon = (await api.getRawFileMeta(LEXICON_PATH, 'gamewiki')).content;
        if (lexiconStale(lexicon)) {
          lexicon = await buildLexicon(api, new Date().toISOString().slice(0, 10));
          await api.savePage(LEXICON_PATH, lexicon, null, 'gamewiki');
        }
      } catch { /* brain missing → buildBrainContext surfaces it loudly */ }
      const brain = await buildBrainContext(api, { coachedTeam });

      // deterministic per-match digests (matches without a data sidecar are skipped)
      const matchDigests = [];
      for (const m of (scrimRef.current?.matches || [])) {
        try { matchDigests.push(buildMatchDigest(JSON.parse((await api.getRawFileMeta(sidecarPath(path, m.n), 'gamewiki')).content), { label: `Match ${m.n}` })); }
        catch { /* no match data for this one */ }
      }

      // the coach's tagged in-game notes, compiled per match (chess.com classifications)
      const coachNotesBlock = (scrimRef.current?.matches || []).map((m) => {
        const bullets = getNotes(m)?.bullets || [];
        return bullets.length ? `### Match ${m.n}\n${renderCoachingSummary(compileNotes(bullets))}` : '';
      }).filter(Boolean).join('\n\n');

      // Pass 0: lexicon-grounded transcript normalization, content-hash-cached in .vodnorm
      const normPath = scrimSidecarPath(path, 'vodnorm');
      const hash = transcriptHash(segments);
      let cachedNorm = null;
      try { const c = JSON.parse((await api.getRawFileMeta(normPath, 'gamewiki')).content); if (c.hash === hash) cachedNorm = c; } catch { /* no cache */ }
      const norm = await normalizeTranscript(invoke, segments, lexicon, agents, { cached: cachedNorm });
      if (!norm.discarded && !cachedNorm) {
        api.savePage(normPath, JSON.stringify({ hash, corrections: norm.corrections, skipped: norm.skipped }), null, 'gamewiki').catch(() => {});
      }
      const transcriptBlock = buildTranscriptBlock(norm.segments);

      // Pass 1: the grounded draft
      setReportPhase('Analyzing');
      const draft = await generateReport(invoke, { transcriptBlock, teams: { opponent }, coachedTeam, priorActionItems, notesBlock, brainContext: brain.text, matchDigests, coachNotesBlock, prior }, agents);

      // Pass 2: read-only tool-armed fact-check (degrades to a warning, never blocks)
      setReportPhase('Fact-checking');
      const { report, ran: verified } = await verifyReport(invoke, { report: draft, matchDigests, lexicon }, agents);

      report.meta.passes = [...(norm.discarded ? [] : ['normalize']), 'draft', ...(verified ? ['verify'] : [])];
      report.meta.brainSections = brain.sections.filter((s) => s.present).map((s) => s.label);
      report.meta.warnings = [...brain.warnings, ...(norm.warning ? [norm.warning] : []), ...report.meta.warnings];

      setReportPhase('Saving');
      await api.savePage(scPath, JSON.stringify(report), null, 'gamewiki');

      const stamp = new Date().toISOString().slice(0, 10);
      const n = (report.actionItems || []).length;
      applyEdit((p) => ({ ...p, scrim: { ...p.scrim, 'VOD Report': `generated ${stamp} · ${n} item${n === 1 ? '' : 's'}` } }));
      flushSave();
      setView({ kind: 'report', tab: 'tldr' });
      // regenerate this team's cross-scrim page/sidecar (best-effort — never blocks the report result)
      updateTeamProgress(coachedTeam).catch(() => {});
      notify('success', 'Report generated', `${n} action item${n === 1 ? '' : 's'}.`);
    } catch (e) {
      const msg = {
        AUTH: ['AI backend not configured', 'Add an Anthropic API key or Claude CLI in Settings → Agents.'],
        NETWORK: ['Network error', e?.message || 'Could not reach the model.'],
        UPSTREAM: ['Model error', e?.message || 'The model returned an unexpected response.'],
      }[e?.code] || ['Report failed', e?.message || String(e)];
      notify('error', msg[0], msg[1]);
    } finally {
      reportRef.current = false; setReporting(false); setReportPhase('');
    }
  }, [path, settings, applyEdit, flushSave, updateTeamProgress]);

  // Add Notes (VOD Report Sections) — pick a player-written .md/.txt notes file, read it via
  // coaching_read_text (the explicit file-pick is the grant), and append it under a `## <basename>`
  // header to the .vodnotes sidecar. The next Generate/Regenerate feeds it to the report prompt.
  const addVodNotes = useCallback(async () => {
    const p = await pickFile(NOTES_FILTERS);
    if (!p) return;
    try {
      const text = await invoke('coaching_read_text', { path: p });
      const notesPath = scrimSidecarPath(path, 'vodnotes');
      let existing = '';
      try { existing = (await api.getRawFileMeta(notesPath, 'gamewiki')).content; } catch { /* first notes file */ }
      const base = p.split(/[\\/]/).pop().replace(/\.(md|txt)$/i, '');
      const next = `${existing.trim() ? `${existing.trimEnd()}\n\n` : ''}## ${base}\n\n${String(text).trim()}\n`;
      await api.savePage(notesPath, next, null, 'gamewiki');
      notify('success', 'Notes added', `${base} will feed the next report generation.`);
    } catch (e) {
      notify('error', 'Notes failed', e?.message || String(e));
    }
  }, [path]);

  // Review Comms (sub-plan 13) — cluster the coached team's in-game comms around each teamfight
  // (a death cluster), score jumble, have Claude judge each callout good/wrong/late + flag the calls
  // that were missed (with a should've-said line), cache the .tfcomms sidecar, open TeamfightCommsView.
  // Re-runnable. Mirrors classify()/generateVodReport backend resolution. Feeds sub-plan 12's Comms
  // trend via updateTeamProgress (jumbled share + missed/fight).
  const reviewComms = useCallback(async (idx, side, coachedTeam) => {
    if (tfRef.current) return;
    const m = scrimRef.current?.matches?.[idx];
    if (!m) return;
    let raw, segments;
    try { raw = JSON.parse((await api.getRawFileMeta(sidecarPath(path, m.n), 'gamewiki')).content); }
    catch { notify('error', 'No match data', 'Run Process first — the review needs the match data.'); return; }
    try { segments = parseSegments((await api.getRawFileMeta(sidecarPath(path, m.n, 'comms'), 'gamewiki')).content); }
    catch { notify('error', 'No comms', 'Extract Comms first — the review reads that transcript.'); return; }

    const offsetS = Number(m.fields['Comms Offset']) || 0;
    const fights = buildFights(extractSpatial(raw).deaths, segments, { side, offsetS });
    if (!fights.length) { notify('info', 'No teamfights', 'No death clusters found to review in this match.'); return; }

    tfRef.current = true; setReviewingN(m.n);
    try {
      const ag = settings?.agents || {};
      let backend = ag.authBackend;
      if (!backend) backend = (await invoke('design_get_api_key').catch(() => false)) ? 'api-key' : 'claude-cli';
      const agents = { authBackend: backend, model: ag.model || 'opus', claudeCliPath: ag.claudeCliPath || '' };

      const judged = await judgeTeamfights(invoke, { fights, coachedTeam, roster: coachedRoster }, agents);
      const report = { generated: new Date().toISOString().slice(0, 10), model: agents.model, fights: judged, summary: summarize(judged) };
      await api.savePage(sidecarPath(path, m.n, 'tfcomms'), JSON.stringify(report), null, 'gamewiki');
      setTfReady((s) => new Set(s).add(m.n));
      setTfOpen({ n: m.n });
      // regenerate this team's cross-scrim page (best-effort — the Comms trend now has jumble/missed).
      updateTeamProgress(coachedTeam).catch(() => {});
      const missed = judged.reduce((a, f) => a + (f.missed || []).length, 0);
      notify('success', 'Comms reviewed', `${judged.length} teamfight${judged.length === 1 ? '' : 's'} · ${missed} missed call${missed === 1 ? '' : 's'}.`);
    } catch (e) {
      const msg = {
        AUTH: ['AI backend not configured', 'Add an Anthropic API key or Claude CLI in Settings → Agents.'],
        NETWORK: ['Network error', e?.message || 'Could not reach the model.'],
        UPSTREAM: ['Model error', e?.message || 'The model returned an unexpected response.'],
      }[e?.code] || ['Review failed', e?.message || String(e)];
      notify('error', msg[0], msg[1]);
    } finally {
      tfRef.current = false; setReviewingN(null);
    }
  }, [path, settings, coachedRoster, updateTeamProgress]);

  // Which matches already have a cached .tfcomms review → drives the "Open Review" chip without a
  // regenerate. Probed on load (a cheap metadata read per match); reviewComms adds to it on generate.
  useEffect(() => {
    let cancelled = false;
    const matches = scrim?.matches || [];
    if (!matches.length) { setTfReady(new Set()); return undefined; }
    Promise.all(matches.map((m) =>
      api.getRawFileMeta(sidecarPath(path, m.n, 'tfcomms'), 'gamewiki').then(() => m.n).catch(() => null)
    )).then((ns) => { if (!cancelled) setTfReady(new Set(ns.filter((n) => n != null))); });
    return () => { cancelled = true; };
  }, [path, scrim?.matches?.length]);

  // Reassign a whole speaker cluster to a roster name (Speakers panel or an inline transcript
  // relabel). On an explicit name (not a clear) this ENROLLS/retrains the voiceprint from the
  // cluster's mean embedding (the correction→retrain safety valve), then relabels every segment
  // of that cluster in the sidecar + regenerates the opaque summary. A clear reverts to "Speaker N".
  const reassignCluster = useCallback(async (idx, cid, name) => {
    const m = scrimRef.current?.matches?.[idx];
    if (!m) return;
    try {
      const scPath = sidecarPath(path, m.n, 'comms');
      const r = await api.getRawFileMeta(scPath, 'gamewiki');
      const vm = parseCommsSidecar(r.content); // { segments, clusters, micSpeaker }
      const cl = (vm.clusters || []).find((c) => Number(c.clusterId) === Number(cid));
      const coachedTeam = scrimRef.current?.frontmatter?.['Coached Team'] || scrimRef.current?.frontmatter?.['Team 1'] || '';
      if (name && cl?.embedding?.length) {
        const store = await readTeamStore(coachedTeam);
        const prints = enrollPrint(store.prints || {}, name, cl.embedding);
        const roster = (store.roster || []).includes(name) ? store.roster : [...(store.roster || []), name];
        await writeTeamStore(coachedTeam, { roster, prints });
        setCoachedRoster(roster);
      }
      const label = name || labelForCluster(Number(cid), {});
      const segments = (vm.segments || []).map((s) => (Number(s.cluster) === Number(cid) ? { ...s, speaker: label } : s));
      const payload = buildCommsSidecar({ segments, clusters: vm.clusters || [], micSpeaker: vm.micSpeaker });
      await api.savePage(scPath, JSON.stringify(payload), null, 'gamewiki');
      const durationS = segments.length ? Math.max(...segments.map((s) => Number(s.t1Ms) || 0)) / 1000 : 0;
      const body = renderCommsSummary({ n: m.n, segments, durationS, sidecarFileName: scPath.split('/').pop() });
      await writeCommsOpaque(m.n, body);
      setCommsRelabelKey((k) => k + 1); // remount the comms views (opaque body text is unchanged)
    } catch (e) {
      notify('error', 'Relabel failed', e?.message || String(e));
    }
  }, [path, readTeamStore, writeTeamStore, writeCommsOpaque]);

  // Load the coached team's roster (from its voiceprint store) for the Speakers panel + inline
  // relabel dropdowns; refreshes when the Coached Team changes.
  useEffect(() => {
    let cancelled = false;
    const team = scrim?.frontmatter?.['Coached Team'] || scrim?.frontmatter?.['Team 1'] || '';
    if (!team) { setCoachedRoster([]); return undefined; }
    readTeamStore(team).then((s) => { if (!cancelled) setCoachedRoster(s.roster || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [scrim?.frontmatter?.['Coached Team'], scrim?.frontmatter?.['Team 1'], readTeamStore]);

  // Classify (AI) — propose chess.com classifications for a team by reasoning over the
  // pulled match data. Reads the .matchdata sidecar → buildMomentsDigest(side) → Claude
  // (coaching_classify_match, headless/no-tools) → reconcile with prior review state →
  // persist the .autoclass sidecar (review-state truth) + an AI-badged
  // ### Auto Classification (<team>) mirror. Mirrors extractComms' write discipline and
  // NEVER touches ### Notes — auto stays separate from the user's manual tags. Reusable
  // for either team (coached run wires it in SF3; the enemy run reuses it in SF4).
  const classify = useCallback(async (idx, side, teamName) => {
    const m = scrimRef.current?.matches?.[idx];
    if (!m || classifyRef.current || side == null || !teamName) return;
    classifyRef.current = true; setClassifyingN(m.n); setClassifyPhase('Reading match data');
    try {
      clearTimeout(saveTimer.current);
      if (serializeScrim(scrimRef.current) !== lastSavedRef.current) await doSave();

      const mr = await api.getRawFileMeta(sidecarPath(path, m.n), 'gamewiki');
      const raw = JSON.parse(mr.content);
      const digest = buildMomentsDigest(raw, side);
      if (!digest.moments.length) { notify('error', 'Nothing to classify', 'No notable moments found for that side in this match.'); return; }

      // the team's own notes (with timestamps) for the AI to fold in (sub-plan 5 merge)
      const notesSub = getNotes(scrimRef.current.matches[idx], teamName);
      const userNotes = (notesSub?.bullets || []).map((b, i) => { const p = parseTimedNote(b); return { noteId: `n${i}`, at: p.at, atSec: p.atSec, label: p.classification, text: p.text }; });

      // optional comms context (best-effort — never required)
      let commsSlice = '';
      try {
        const cr = await api.getRawFileMeta(sidecarPath(path, m.n, 'comms'), 'gamewiki');
        commsSlice = (JSON.parse(cr.content) || []).map((s) => s.text).filter(Boolean).join(' ');
      } catch { /* no comms — fine */ }

      // resolve backend (honor settings.agents; fall back to key-detect)
      const ag = settings?.agents || {};
      let backend = ag.authBackend;
      if (!backend) backend = (await invoke('design_get_api_key').catch(() => false)) ? 'api-key' : 'claude-cli';
      const agents = { authBackend: backend, model: ag.model || 'opus', claudeCliPath: ag.claudeCliPath || '' };

      setClassifyPhase('Asking Claude');
      const fresh = await classifyMoments(invoke, digest, agents, { commsSlice, userNotes });

      // reconcile with prior review state, persist the sidecar (review-state source of truth)
      setClassifyPhase('Saving');
      const scPath = sidecarPath(path, m.n, 'autoclass');
      let store = { teams: {} };
      try { const sr = await api.getRawFileMeta(scPath, 'gamewiki'); store = JSON.parse(sr.content) || { teams: {} }; if (!store.teams) store.teams = {}; } catch { /* first run */ }
      const reconciled = reconcile(fresh, store.teams[teamName]);
      store.teams[teamName] = { side, model: agents.model, suggestions: reconciled };
      await api.savePage(scPath, JSON.stringify(store), null, 'gamewiki');

      // AI-badged mirror → ### Auto Classification (<team>) (opaque/disk-owned; merged write, retry once)
      const body = renderAutoClassification(store.teams[teamName]);
      const writeMd = async () => {
        const r = await api.getRawFileMeta(path, 'gamewiki').catch(() => null);
        const fresh2 = r ? parseScrim(r.content) : scrimRef.current;
        const merged = setAutoClassificationBody(mergeScrim(scrimRef.current, fresh2), m.n, teamName, body);
        const content = serializeScrim(merged);
        await api.savePage(path, content, r?.mtime ?? null, 'gamewiki');
        lastSavedRef.current = content; scrimRef.current = merged; setScrim(merged);
      };
      try { await writeMd(); } catch (e) { if (e?.code === 'CONFLICT') await writeMd(); else throw e; }

      // open the review/merge modal with the reconciled items (the modal's Save writes Notes)
      setReview({ idx, teamName, items: reconciled });
    } catch (e) {
      const msg = {
        AUTH: ['AI backend not configured', 'Add an Anthropic API key or Claude CLI in Settings → Agents.'],
        NETWORK: ['Network error', e?.message || 'Could not reach the model.'],
        UPSTREAM: ['Model error', e?.message || 'The model returned an unexpected response.'],
        INVALID: ['Classify failed', e?.message || 'Bad input.'],
      }[e?.code] || ['Classify failed', e?.message || String(e)];
      notify('error', msg[0], msg[1]);
    } finally {
      classifyRef.current = false; setClassifyingN(null); setClassifyPhase('');
    }
  }, [path, doSave, settings]);

  // Save the merge-review modal (sub-plan 5): the kept items REPLACE the team's ### Notes
  // (the canonical list), each as a "[m:ss] Label: text" bullet, time-ascending. Both kept
  // and dropped items are persisted to the .autoclass sidecar (provenance), and the AI
  // mirror is regenerated. Mirrors the classify() write discipline: sidecar (own mtime)
  // first, then ONE markdown read→merge→serialize→save behind the fresh-mtime conflict guard.
  const saveReview = useCallback(async (idx, teamName, kept, dropped) => {
    const m = scrimRef.current?.matches?.[idx];
    if (!m) return;
    try {
      const bullets = sortByTimeAsc(kept, (it) => it.atSec).ordered.map(mergedItemToBullet);

      const scPath = sidecarPath(path, m.n, 'autoclass');
      let store = { teams: {} };
      try { const sr = await api.getRawFileMeta(scPath, 'gamewiki'); store = JSON.parse(sr.content) || { teams: {} }; if (!store.teams) store.teams = {}; } catch { /* first run */ }
      const prev = store.teams?.[teamName] || {};
      store.teams[teamName] = { side: prev.side ?? null, model: prev.model || 'opus', suggestions: [...kept, ...dropped] };
      await api.savePage(scPath, JSON.stringify(store), null, 'gamewiki');

      const body = renderAutoClassification(store.teams[teamName]);
      const writeMd = async () => {
        const r = await api.getRawFileMeta(path, 'gamewiki').catch(() => null);
        let merged = mergeScrim(scrimRef.current, r ? parseScrim(r.content) : scrimRef.current);
        merged = { ...merged, matches: merged.matches.map((mm) => {
          if (mm.n !== m.n) return mm;
          const withNotes = ensureNotes(mm, teamName); // lazily create the enemy notes block
          return { ...withNotes, subsections: withNotes.subsections.map((s) => (s.kind === 'notes' && s.team === teamName ? { ...s, bullets } : s)) };
        }) };
        merged = setAutoClassificationBody(merged, m.n, teamName, body);
        const content = serializeScrim(merged);
        await api.savePage(path, content, r?.mtime ?? null, 'gamewiki');
        lastSavedRef.current = content; scrimRef.current = merged; setScrim(merged);
      };
      try { await writeMd(); } catch (e) { if (e?.code === 'CONFLICT') await writeMd(); else throw e; }

      setReview(null);
      notify('success', 'Notes updated', `${teamName} — ${bullets.length} note${bullets.length === 1 ? '' : 's'} from review.`);
    } catch (e) {
      notify('error', 'Save failed', e?.message || String(e));
    }
  }, [path]);

  // Load on path change; flush a pending edit for the outgoing path before switching.
  useEffect(() => {
    let cancelled = false;
    setScrim(null); setErr(null); setSaveState('idle'); setView(null);
    scrimRef.current = null; lastSavedRef.current = null;
    api.getRawFileMeta(path, 'gamewiki')
      .then((r) => {
        if (cancelled) return;
        const parsed = parseScrim(r.content);
        scrimRef.current = parsed;
        lastSavedRef.current = serializeScrim(parsed);
        setScrim(parsed);
      })
      .catch((e) => { if (!cancelled) setErr(String(e?.message || e)); });
    return () => {
      cancelled = true;
      clearTimeout(saveTimer.current);
      if (scrimRef.current && serializeScrim(scrimRef.current) !== lastSavedRef.current) doSave();
    };
  }, [path, doSave]);

  // Reconcile the pane view once the scrim loads (and whenever matches change): keep a
  // valid restored view (report tab, or an existing match); else fall back to the last
  // saved per-scrim view; else the first match. The functional updater bails (same ref)
  // when the current view is still valid, so this is a no-op on ordinary field edits.
  useEffect(() => {
    if (!scrim) return;
    const ns = (scrim.matches || []).map((m) => m.n);
    setView((cur) => {
      const restored = cur || loadView(path);
      if (restored?.kind === 'report') return restored;
      if (restored?.kind === 'match' && ns.includes(restored.n)) return restored;
      return { kind: 'match', n: ns[0] ?? 1 };
    });
  }, [scrim, path]);
  // Persist the pane view per scrim + the rail-expanded flag globally (width persists via
  // the SidebarSeam storageKey).
  useEffect(() => { if (view) { try { localStorage.setItem(viewKey(path), JSON.stringify(view)); } catch { /* private mode */ } } }, [view, path]);
  useEffect(() => { try { localStorage.setItem(LS_RAIL_EXPANDED, railExpanded ? '1' : '0'); } catch { /* private mode */ } }, [railExpanded]);

  // ── Overlay mode: focused-match live capture (dictate → note, screenshot →
  //    scoreboard) routed to the focused match. All gated on `overlay`; the in-app
  //    page never sets a live target or listens. Single writer: these route through
  //    applyEdit so ScrimViewer's own state updates + saves (no stale 2nd writer). ──
  const appendNoteToFocused = useCallback((text) => {
    const mn = matchFocusRef.current; const t = String(text || '').trim();
    if (mn == null || !t) return;
    applyEdit((p) => {
      const coached = p.frontmatter?.['Coached Team'] || p.frontmatter?.['Team 1'] || '';
      // Stamp with the running game clock (same [m:ss] the typed-note path uses) so a
      // dictated note lands timed exactly like one typed while the timer runs.
      const sw = readStopwatch(`gw-sw:${path}:m${mn}:${coached}`);
      const stamped = sw.running ? `[${clock(sw.elapsedSec)}] ${t}` : t;
      return { ...p, matches: (p.matches || []).map((m) => {
        if (m.n !== mn) return m;
        const has = (m.subsections || []).some((s) => s.kind === 'notes' && s.team === coached);
        const next = [...(getNotes(m, coached)?.bullets || []), stamped];
        if (has) return { ...m, subsections: m.subsections.map((s) => (s.kind === 'notes' && s.team === coached ? { ...s, bullets: next } : s)) };
        const subs = [...(m.subsections || [])];
        const fo = subs.findIndex((s) => s.kind === 'opaque');
        const note = { kind: 'notes', team: coached, bullets: next };
        if (fo === -1) subs.push(note); else subs.splice(fo, 0, note);
        return { ...m, subsections: subs };
      }) };
    });
    flushSave();
  }, [applyEdit, flushSave]);

  const setFocusedScoreboardIfEmpty = useCallback((pth) => {
    const mn = matchFocusRef.current; if (mn == null || !pth) return;
    applyEdit((p) => ({ ...p, matches: (p.matches || []).map((m) => (
      m.n === mn && !String(m.fields?.['Scoreboard'] || '').trim() ? { ...m, fields: { ...m.fields, Scoreboard: pth } } : m
    )) }));
    flushSave();
  }, [applyEdit, flushSave]);

  // Dictate button — its OWN stt_start_dictation session (client Channel), distinct
  // from the hotkey PTT path (dictation_committed → overlay-dictation-committed), so
  // they never double-append. The final transcript becomes a note on the focused match.
  const toggleDictate = useCallback(() => {
    if (dictating) { invoke('stt_stop_dictation').catch(() => {}); return; }
    const model = settings?.stt?.defaultModel || 'base.en';
    const segs = [];
    const ch = new Channel();
    ch.onmessage = (ev) => {
      switch (ev.kind) {
        case 'segment': segs.push(ev.text ?? ''); break;
        case 'final': { const t = (ev.text ?? segs.join(' ')).replace(/\s+/g, ' ').trim(); if (t) appendNoteToFocused(t); setDictating(false); break; }
        case 'error': setDictating(false); break;
        case 'done': setDictating(false); break;
        default: break;
      }
    };
    setDictating(true);
    invoke('stt_start_dictation', { model, useGpu: null, onEvent: ch }).catch(() => setDictating(false));
  }, [dictating, settings, appendNoteToFocused]);

  const takeScoreboardShot = useCallback(() => { invoke('capture_screenshot').catch(() => {}); }, []);

  // Default / correct the focused match once the scrim loads (overlay only).
  useEffect(() => {
    if (!overlay || !scrim) return;
    const ns = (scrim.matches || []).map((m) => m.n);
    if (focusedN == null || !ns.includes(focusedN)) setFocusedN(ns[0] ?? null);
  }, [overlay, scrim, focusedN]);

  // Keep the overlay's live-capture focus in lockstep with the tree's selected match, so
  // dictation/screenshot route to whatever match the tree currently shows.
  useEffect(() => { if (overlay && view?.kind === 'match') setFocusedN(view.n); }, [overlay, view]);

  // Publish the Rust live-target so the hotkey dictation reroute targets the focused
  // match (refresh on focus change; clear on unmount).
  useEffect(() => {
    if (!overlay || !path || focusedN == null) return;
    const coached = scrimRef.current?.frontmatter?.['Coached Team'] || scrimRef.current?.frontmatter?.['Team 1'] || '';
    invoke('overlay_go_live', { target: { scrimPath: path, matchN: focusedN, coachedTeam: coached } }).catch(() => {});
  }, [overlay, path, focusedN]);
  useEffect(() => {
    if (!overlay) return undefined;
    return () => { invoke('overlay_go_offline').catch(() => {}); };
  }, [overlay]);

  useEffect(() => {
    if (!overlay) return undefined;
    // Keep the registration promises and chain unlisten onto them — pushing into a
    // plain array misses any listener that resolves after cleanup already ran
    // (fast unmount / effect churn), leaving it attached → double-appended notes.
    const subs = [
      listen('overlay-dictation-committed', (e) => appendNoteToFocused(e.payload?.text)),
      listen('capture-screenshot-saved', (e) => setFocusedScoreboardIfEmpty(e.payload?.path)),
    ];
    return () => subs.forEach((p) => p.then((u) => u()).catch(() => {}));
  }, [overlay, appendNoteToFocused, setFocusedScoreboardIfEmpty]);

  if (err) return <div style={wrap}><div style={inner}><p style={{ color: 'var(--error)' }}>Couldn’t open this scrim: {err}</p></div></div>;
  if (!scrim) return <div style={wrap}><div style={inner}><p style={{ color: 'var(--text-muted)' }}>Loading</p></div></div>;

  const fm = scrim.frontmatter;
  const setFm = (k, v) => applyEdit((p) => ({ ...p, frontmatter: { ...p.frontmatter, [k]: v } }));
  const setScrimField = (k, v) => applyEdit((p) => ({ ...p, scrim: { ...p.scrim, [k]: v } }));
  const setMatchField = (idx, k, v) => applyEdit((p) => ({
    ...p, matches: p.matches.map((m, i) => (i === idx ? { ...m, fields: { ...m.fields, [k]: v } } : m)),
  }));
  // Team-keyed (sub-plan 5): writes ONLY the matching team's notes block, creating it
  // (before the first opaque section) when absent — both teams now have a notes list, and
  // the old "write every notes subsection" form would clone one team's notes onto the other.
  const setNotes = (idx, team, bullets) => applyEdit((p) => ({
    ...p, matches: p.matches.map((m, i) => {
      if (i !== idx) return m;
      if ((m.subsections || []).some((s) => s.kind === 'notes' && s.team === team)) {
        return { ...m, subsections: m.subsections.map((s) => (s.kind === 'notes' && s.team === team ? { ...s, bullets } : s)) };
      }
      const subs = [...(m.subsections || [])];
      const firstOpaque = subs.findIndex((s) => s.kind === 'opaque');
      const note = { kind: 'notes', team, bullets };
      if (firstOpaque === -1) subs.push(note); else subs.splice(firstOpaque, 0, note);
      return { ...m, subsections: subs };
    }),
  }));
  const addMatch = () => { applyEdit((p) => appendMatch(p)); flushSave(); };

  // ── Scrim Tree Consolidation (Phase 3): the match card as a pane-renderable function
  //    (one leaf per match drives it), plus the 3-folder tree model + the non-overlay
  //    tree layout. renderMatchCard is the verbatim match card; the overlay return below
  //    keeps its own inline copy this phase (Phase 4 dedups). ──
  const renderMatchCard = (m, idx) => {
    const matchData = (m.subsections.find((s) => s.kind === 'opaque' && s.heading === 'Match Data') || {}).body;
    const populated = matchData && matchData !== MATCH_DATA_PLACEHOLDER;
    const summaryBody = (m.subsections.find((s) => s.kind === 'opaque' && s.heading === 'Coaching Summary') || {}).body;
    const hasSummary = !!(summaryBody && summaryBody.trim());
    const commsBody = (m.subsections.find((s) => s.kind === 'opaque' && s.heading === 'Comms Transcript') || {}).body;
    const hasComms = !!(commsBody && commsBody.trim());
    const coachedTeam = fm['Coached Team'] || fm['Team 1'] || '';
    const enemyTeam = (fm['Team 1'] === coachedTeam ? fm['Team 2'] : fm['Team 1']) || '';
    const { coachedSide, enemySide } = sideFromTeamFields(m.fields, coachedTeam);
    const autoBody = (m.subsections.find((s) => s.kind === 'opaque' && s.heading === `Auto Classification (${coachedTeam})`) || {}).body;
    const hasAuto = !!(autoBody && autoBody.trim());
    const enemyAutoBody = (m.subsections.find((s) => s.kind === 'opaque' && s.heading === `Auto Classification (${enemyTeam})`) || {}).body;
    const hasEnemyAuto = !!(enemyAutoBody && enemyAutoBody.trim());
    return (
      <div key={m.n} style={slim && fill ? { ...card, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : card}>
        {/* Slim hides the whole title/chip block — the head's match picker already
            names the match; Dictate lives in the notes control row. */}
        {!slim && (
        <div style={{ marginBottom: candyGap(8) }}>
          <div style={sectionTitle}>Match {m.n}</div>
          <div className="candy-chip-row" style={{ marginTop: 4 }}>
            {overlay && (
              <button className="candy-btn" data-shape="chip" onClick={takeScoreboardShot}
                title="Capture a scoreboard screenshot for this match">
                <span className="candy-face">Scoreboard</span>
              </button>
            )}
            {!slim && populated && (
              <button className="candy-btn" data-shape="chip" onClick={() => setMatchPopup({ n: m.n })} title="Open the full match view">
                <span className="candy-face">View Full Match</span>
              </button>
            )}
            {!slim && (
            <button className="candy-btn" data-shape="chip"
              disabled={commsN === m.n || runningN === m.n || !m.fields['Scrim Recording'] || !sttUp}
              onClick={() => extractComms(idx)}
              title={!m.fields['Scrim Recording']
                ? 'Set a Scrim Recording (.mp4) for this match first'
                : !sttUp ? 'Speech engine unavailable — reopen the app'
                  : 'Extract Comms — transcribe this match recording'}
              style={commsN === m.n ? { opacity: 0.6, cursor: 'progress' } : undefined}>
              <span className="candy-face">{commsN === m.n ? (commsPhase || 'Working') : 'Extract Comms'}</span>
            </button>
            )}
            {!slim && commsN === m.n && (
              <button className="candy-btn" data-shape="chip" onClick={cancelComms} title="Cancel transcription"><span className="candy-face">×</span></button>
            )}
            {!slim && (
            <button className="candy-btn" data-shape="chip"
              disabled={runningN === m.n || commsN === m.n}
              onClick={() => runProcess(idx)}
              title="Run Process — pull this match's data from deadlock-api by Match ID"
              style={runningN === m.n ? { opacity: 0.6, cursor: 'progress' } : undefined}>
              <span className="candy-face">{runningN === m.n ? 'Running' : 'Run Process'}</span>
            </button>
            )}
          </div>
        </div>
        )}
        {!slim && (<>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 14 }}>
          <EditField label="Match ID" value={m.fields['Match ID']} onChange={(v) => setMatchField(idx, 'Match ID', v)} onCommit={flushSave} placeholder="e.g. 38291042" />
          <EditField label="Time" value={m.fields['Time']} onChange={(v) => setMatchField(idx, 'Time', v)} onCommit={flushSave} placeholder="e.g. 7:42 PM" />
          <EditField label="Amber" value={m.fields['Amber']} onChange={(v) => setMatchField(idx, 'Amber', v)} onCommit={flushSave} placeholder="team on Amber side" />
          <EditField label="Sapphire" value={m.fields['Sapphire']} onChange={(v) => setMatchField(idx, 'Sapphire', v)} onCommit={flushSave} placeholder="team on Sapphire side" />
          <EditField label="Comms Offset" value={m.fields['Comms Offset']} onChange={(v) => setMatchField(idx, 'Comms Offset', v)} onCommit={flushSave} placeholder="s of pre-game in recording" />
        </div>
        <EditField label="Scrim Recording" value={m.fields['Scrim Recording']} onChange={(v) => setMatchField(idx, 'Scrim Recording', v)} onCommit={flushSave} placeholder="/path/to/match.mp4"
          right={<>
            <MiniBtn icon={IconFolder} title="Select .mp4" onClick={async () => { const p = await pickFile(MP4_FILTERS); if (p) { setMatchField(idx, 'Scrim Recording', p); flushSave(); } }} />
            {m.fields['Scrim Recording'] && <MiniBtn icon={IconPlayCircle} title="Open recording" onClick={() => invoke('coaching_open_path', { path: m.fields['Scrim Recording'] }).catch(() => {})} />}
          </>} />
        <EditField label="Scoreboard" value={m.fields['Scoreboard']} onChange={(v) => setMatchField(idx, 'Scoreboard', v)} onCommit={flushSave} placeholder="/path/to/scoreboard.png"
          right={<MiniBtn icon={IconFolder} title="Select screenshot" onClick={async () => { const p = await pickFile(IMG_FILTERS); if (p) { setMatchField(idx, 'Scoreboard', p); flushSave(); } }} />} />
        <Scoreboard path={m.fields['Scoreboard']} />
        </>)}
        {/* Coached team only — enemy notes UI dropped by design (notes are only ever
            taken on the coached team); enemy notes on disk still round-trip verbatim. */}
        <TeamNotes team={coachedTeam} bullets={getNotes(m, coachedTeam)?.bullets || []} overlay={overlay} slim={slim} fill={slim && fill}
          dictating={dictating} onDictate={overlay ? toggleDictate : undefined}
          onChange={(b) => setNotes(idx, coachedTeam, b)} onCommit={flushSave} storageKey={`gw-sw:${path}:m${m.n}:${coachedTeam}`} />
        {!slim && hasSummary && (
          <div style={{ marginTop: 8 }}>
            <CoachingSummaryView body={summaryBody} />
          </div>
        )}
        {!slim && hasComms && (
          <SpeakersPanel key={`sp:${commsBody}:${commsRelabelKey}`} sidecarPath={sidecarPath(path, m.n, 'comms')}
            roster={coachedRoster} onReassign={(cid, name) => reassignCluster(idx, cid, name)} />
        )}
        {!slim && (
        <div style={{ marginTop: 8 }}>
          <div style={labelStyle}>Comms Transcript</div>
          {hasComms
            ? <CommsTranscriptView key={`ct:${commsBody}:${commsRelabelKey}`} sidecarPath={sidecarPath(path, m.n, 'comms')}
                roster={coachedRoster} onReassign={(cid, name) => reassignCluster(idx, cid, name)} />
            : <div className="text-trim" style={{ fontSize: 12, color: 'var(--text-muted)' }}>Not yet extracted — click <strong>Extract Comms</strong>.</div>}
        </div>
        )}
        {!slim && hasComms && populated && coachedSide != null && (
          <div style={{ marginTop: 8 }}>
            <div style={labelStyle}>Silent Deaths</div>
            <SilentDeathAudit key={`${commsBody}:${matchData}`}
              matchSidecar={sidecarPath(path, m.n)}
              commsSidecar={sidecarPath(path, m.n, 'comms')}
              side={coachedSide}
              offsetS={Number(m.fields['Comms Offset']) || 0} />
          </div>
        )}
        {!slim && (
        <div style={{ marginTop: 8 }}>
          <div style={labelStyle}>Auto Classification</div>
          <div className="candy-chip-row">
            <button className="candy-btn" data-shape="chip"
              disabled={!populated || coachedSide == null || !aiConfigured || classifyingN === m.n || runningN === m.n || commsN === m.n}
              onClick={() => classify(idx, coachedSide, coachedTeam)}
              title={!populated ? 'Run Process first — Classify needs the match data'
                : coachedSide == null ? 'Fill the Amber/Sapphire team fields so the coached side resolves'
                  : !aiConfigured ? 'Configure an AI backend in Settings → Agents (API key or Claude CLI)'
                    : `Classify ${coachedTeam || 'the coached team'} — merges the AI with your notes`}
              style={classifyingN === m.n ? { opacity: 0.6, cursor: 'progress' } : undefined}>
              <span className="candy-face">{classifyingN === m.n ? (classifyPhase || 'Working') : `Classify ${coachedTeam || 'coached'}`}</span>
            </button>
            <button className="candy-btn" data-shape="chip"
              disabled={!populated || enemySide == null || !aiConfigured || classifyingN === m.n || runningN === m.n || commsN === m.n}
              onClick={() => classify(idx, enemySide, enemyTeam)}
              title={!populated ? 'Run Process first'
                : enemySide == null ? 'Fill the Amber/Sapphire team fields so the enemy side resolves'
                  : !aiConfigured ? 'Configure an AI backend in Settings → Agents'
                    : `Classify ${enemyTeam || 'the enemy team'}`}
              style={classifyingN === m.n ? { opacity: 0.6, cursor: 'progress' } : undefined}>
              <span className="candy-face">Classify {enemyTeam || 'enemy'}</span>
            </button>
          </div>
          {!populated && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: candyGap(8) }}>Pull match data first (Run Process), then Classify.</div>}
          {populated && coachedSide == null && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: candyGap(8) }}>Fill the <strong>Amber</strong> / <strong>Sapphire</strong> fields above with each team so the sides resolve.</div>}
          {hasAuto && (
            <div style={{ marginTop: candyGap(8) }}>
              <div style={{ ...labelStyle, color: 'var(--accent)', marginBottom: 2 }}>{coachedTeam || 'Coached'}</div>
              <AutoClassificationView key={autoBody} sidecarPath={sidecarPath(path, m.n, 'autoclass')} team={coachedTeam} />
            </div>
          )}
          {hasEnemyAuto && (
            <div style={{ marginTop: candyGap(8) }}>
              <div style={{ ...labelStyle, color: 'var(--text-muted)', marginBottom: 2 }}>{enemyTeam} · enemy</div>
              <AutoClassificationView key={enemyAutoBody} sidecarPath={sidecarPath(path, m.n, 'autoclass')} team={enemyTeam} />
            </div>
          )}
        </div>
        )}
        {/* Teamfight Comms Review (sub-plan 13) — Claude judges each fight's callouts. */}
        {!slim && (
        <div style={{ marginTop: 8 }}>
          <div style={labelStyle}>Teamfight Comms</div>
          <div className="candy-chip-row">
            <button className="candy-btn" data-shape="chip"
              disabled={!populated || !hasComms || coachedSide == null || !aiConfigured || reviewingN === m.n || runningN === m.n || commsN === m.n || classifyingN === m.n}
              onClick={() => reviewComms(idx, coachedSide, coachedTeam)}
              title={!populated ? 'Run Process first — the review needs the match data'
                : !hasComms ? 'Extract Comms first — the review reads that transcript'
                  : coachedSide == null ? 'Fill the Amber/Sapphire team fields so the coached side resolves'
                    : !aiConfigured ? 'Configure an AI backend in Settings → Agents (API key or Claude CLI)'
                      : 'Review Comms — Claude judges each teamfight’s callouts (good / missed / wrong / late)'}
              style={reviewingN === m.n ? { opacity: 0.6, cursor: 'progress' } : undefined}>
              <span className="candy-face">{reviewingN === m.n ? 'Asking Claude' : 'Review Comms'}</span>
            </button>
            {tfReady.has(m.n) && reviewingN !== m.n && (
              <button className="candy-btn" data-shape="chip" onClick={() => setTfOpen({ n: m.n })} title="Open the teamfight comms review">
                <span className="candy-face">Open Review</span>
              </button>
            )}
          </div>
          {populated && !hasComms && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: candyGap(8) }}>Extract Comms first, then Review Comms.</div>}
        </div>
        )}
      </div>
    );
  };

  // Tree model (3 folders) + toolbar wiring.
  const revealPath = (p) => invoke('coaching_reveal_path', { path: p }).catch(() => {});
  const tabs = reportTabs.length ? reportTabs : DEFAULT_REPORT_TABS;
  const tabLeaf = (t) => ({ id: t.id, label: t.label, active: view?.kind === 'report' && view.tab === t.id, onActivate: () => setView({ kind: 'report', tab: t.id }) });
  const group = (id, label, ids) => ({ id, label, isFolder: true, children: tabs.filter((t) => ids.includes(t.id)).map(tabLeaf) });
  const treeNodes = [
    { id: 'matches', label: 'Matches', isFolder: true, children: [
      ...scrim.matches.map((m) => ({ id: `match:${m.n}`, label: `Match ${m.n}`, active: view?.kind === 'match' && view.n === m.n, onActivate: () => setView({ kind: 'match', n: m.n }) })),
      { id: 'match:new', label: '+ New Match', onActivate: addMatch },
    ] },
    group('report', 'Report', REPORT_GROUP),
    group('coaching', 'Coaching', COACHING_GROUP),
  ];
  const treeController = { ...treeExp, expandAll: () => treeExp.expandAll(['matches', 'report', 'coaching']) };
  const treeButtons = { collapse: { show: true } };
  const treeExtra = [
    { title: 'Reveal files', icon: <IconHardDrive />, dataAttr: 'scrim-reveal-trigger', onClick: (e) => { setRevealAnchor(e.currentTarget.getBoundingClientRect()); setRevealOpen((o) => !o); } },
    { title: 'Coaching setup', icon: <IconSettings />, onClick: () => setSettingsOpen(true) },
    { title: 'Scrim', icon: <IconFilm />, onClick: () => setScrimOpen(true) },
    ...(overlay ? [{ title: live ? 'Leave live mode' : 'Go Live — just notes, voice, and the timer', icon: <IconPlayCircle />, onClick: () => onLive?.(!live), active: live, activeAccent: 'var(--error)' }] : []),
  ];
  const paneMatch = view?.kind === 'match' ? scrim.matches.find((m) => m.n === view.n) : null;
  const paneMatchIdx = paneMatch ? scrim.matches.findIndex((m) => m.n === paneMatch.n) : -1;
  // Slim (overlay live): the pane is always the focused match, stripped to notes+timer+dictate
  // (renderMatchCard self-strips on slim); the rail is force-collapsed (derived, not persisted).
  const slimMatch = slim ? scrim.matches.find((m) => m.n === focusedN) : null;
  const slimMatchIdx = slimMatch ? scrim.matches.findIndex((m) => m.n === slimMatch.n) : -1;
  const paneInner = overlay ? { padding: 8, fontFamily: 'var(--font-mono)', '--accent': accent } : { ...inner, '--accent': accent };

  // The tree layout serves BOTH the main window and the overlay (Phase 4). Overlay
  // differences (Go Live toolbar button, slim pane strip, rail auto-compact) are woven in
  // via the `overlay`/`slim` flags below.
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, '--accent': accent }}>
      <CollapsibleRail
        expanded={slim ? liveRailOpen : railExpanded}
        peek={slim ? false : railPeek}
        width={railWidth}
        railWidth={56}
        containerStyle={{ background: 'var(--surface)', borderRight: '1px solid var(--border)', transition: railResizing ? 'none' : 'width 180ms ease' }}
        header={<ScrimRailHeader expanded={slim ? liveRailOpen : (railExpanded || railPeek)} matchup={`${fm['Team 1'] || '?'} VS ${fm['Team 2'] || '?'}`} accent={accent} onToggle={slim ? () => setLiveRailOpen((v) => !v) : () => setRailExpanded((v) => !v)} />}
        seam={
          <div style={{ position: 'absolute', top: 0, bottom: 0, right: 0, display: 'flex', zIndex: 70 }}>
            <SidebarSeam width={railWidth} onWidthChange={setRailWidth} accent={accent} defaultWidth={RAIL_DEFAULT} minWidth={RAIL_MIN} maxWidth={RAIL_MAX}
              collapseThreshold={140} onCollapse={() => setRailExpanded(false)} onDragStart={() => setRailResizing(true)} onDragEnd={() => setRailResizing(false)}
              storageKey={LS_RAIL_WIDTH} edgeRingSide="right" ariaLabel="Resize scrim rail" />
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, borderTop: '1px solid var(--border)', marginTop: 4 }}>
          <TreeSidebar nodes={treeNodes} controller={treeController} buttons={treeButtons} accent={accent} toolbarExtra={treeExtra} />
        </div>
      </CollapsibleRail>

      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {slim ? (
          slimMatch ? (
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', ...(fill ? { display: 'flex', flexDirection: 'column' } : null) }}>
              <div style={fill ? { ...paneInner, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : paneInner}>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}><SaveTag state={saveState} /></div>
                {renderMatchCard(slimMatch, slimMatchIdx)}
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>No match.</div>
          )
        ) : view?.kind === 'report' ? (
          <VodReportView inline tab={view.tab}
            onTabChange={(t) => setView({ kind: 'report', tab: t })}
            onTabsChange={setReportTabs}
            sidecarPath={scrimSidecarPath(path, 'vodreport')}
            commsPath={scrimSidecarPath(path, 'vodcomms')}
            feedbackPath={scrimSidecarPath(path, 'vodfeedback')}
            mdPath={path} accent={accent} />
        ) : paneMatch ? (
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
            <div style={paneInner}>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}><SaveTag state={saveState} /></div>
              {renderMatchCard(paneMatch, paneMatchIdx)}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
            Pick a match, or a report section.
          </div>
        )}
      </div>

      {/* Coaching Setup + Matchup — the settings-modal toolbar button. */}
      <AppWindow open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Coaching Setup" accent={accent} width="min(560px, 92vw)" height="min(620px, 88vh)">
        <RosterEditor team={fm['Coached Team'] || fm['Team 1'] || ''} readStore={readTeamStore} writeStore={writeTeamStore} onSaved={setCoachedRoster} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 14 }}>
          <EditField label="Comms Track" value={fm['Comms Track']} onChange={(v) => setFm('Comms Track', v)}
            onCommit={() => { flushSave(); saveTrackDefault('comms', scrimRef.current?.frontmatter?.['Comms Track'] || ''); setTrackDefaults(loadTrackDefaults()); }}
            placeholder={trackDefaults.comms !== '' ? `default ${trackDefaults.comms}` : 'OBS track # (e.g. 4)'} />
          <EditField label="Mic Track" value={fm['Mic Track']} onChange={(v) => setFm('Mic Track', v)}
            onCommit={() => { flushSave(); saveTrackDefault('mic', scrimRef.current?.frontmatter?.['Mic Track'] || ''); setTrackDefaults(loadTrackDefaults()); }}
            placeholder={trackDefaults.mic !== '' ? `default ${trackDefaults.mic}` : 'OBS track # (e.g. 1)'} />
        </div>
        <EditField label="Your Name (mic track)" value={yourName} onChange={setYourName}
          onCommit={() => { try { localStorage.setItem(LS_YOUNAME, yourName || ''); } catch { /* private mode */ } }}
          placeholder="how your mic track is labeled (default: You)" />
        <div style={{ ...sectionTitle, marginTop: 20, marginBottom: 8 }}>Matchup</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 14 }}>
          <EditField label="Team 1" value={fm['Team 1']} onChange={(v) => setFm('Team 1', v)} onCommit={flushSave} />
          <EditField label="Team 2" value={fm['Team 2']} onChange={(v) => setFm('Team 2', v)} onCommit={flushSave} />
          <EditField label="Coached Team" value={fm['Coached Team']} onChange={(v) => setFm('Coached Team', v)} onCommit={flushSave} />
          <EditField label="Date" value={fm['Date']} onChange={(v) => setFm('Date', v)} onCommit={flushSave} placeholder="YYYY-MM-DD" />
          <EditField label="Scheduled" value={fm['Scheduled']} onChange={(v) => setFm('Scheduled', v)} onCommit={flushSave} placeholder="e.g. 7:00 PM" />
        </div>
      </AppWindow>

      {/* The whole Scrim card — the scrim-popup toolbar button. */}
      <AppWindow open={scrimOpen} onClose={() => setScrimOpen(false)} title="Scrim" accent={accent} width="min(560px, 92vw)" height="min(560px, 86vh)">
        <EditField label="Score" value={scrim.scrim['Score']} onChange={(v) => setScrimField('Score', v)} onCommit={flushSave} placeholder="e.g. 2-1" />
        <EditField label="VOD Review" value={scrim.scrim['VOD Review']} onChange={(v) => setScrimField('VOD Review', v)} onCommit={flushSave} placeholder="/path/to/review.mp4"
          right={<>
            <MiniBtn icon={IconFolder} title="Select .mp4" onClick={async () => { const p = await pickFile(MP4_FILTERS); if (p) { setScrimField('VOD Review', p); flushSave(); } }} />
            {scrim.scrim['VOD Review'] && <MiniBtn icon={IconPlayCircle} title="Open recording" onClick={() => invoke('coaching_open_path', { path: scrim.scrim['VOD Review'] }).catch(() => {})} />}
          </>} />
        <div className="candy-chip-row" style={{ marginTop: 8, marginBottom: 'var(--candy-depth)' }}>
          <button className="candy-btn" data-shape="chip"
            disabled={vodBusy || !scrim.scrim['VOD Review'] || !sttUp}
            onClick={extractVodComms}
            title={!scrim.scrim['VOD Review'] ? 'Set a VOD Review (.mp4) for this scrim first'
              : !sttUp ? 'Speech engine unavailable — reopen the app'
                : 'Extract VOD Comms — transcribe + split voices in the review recording'}
            style={vodBusy ? { opacity: 0.6, cursor: 'progress' } : undefined}>
            <span className="candy-face">{vodBusy ? (vodPhase || 'Working') : 'Extract VOD Comms'}</span>
          </button>
          {vodBusy && (
            <button className="candy-btn" data-shape="chip" onClick={cancelVod} title="Cancel">
              <span className="candy-face">×</span>
            </button>
          )}
          <button className="candy-btn" data-shape="chip"
            disabled={reporting || !scrim.scrim['VOD Comms'] || !aiConfigured}
            onClick={generateVodReport}
            title={!scrim.scrim['VOD Comms'] ? 'Extract VOD Comms first — the report reads that transcript'
              : !aiConfigured ? 'Configure an AI backend in Settings → Agents (API key or Claude CLI)'
                : 'Generate Report — Claude organizes the review into an action list'}
            style={reporting ? { opacity: 0.6, cursor: 'progress' } : undefined}>
            <span className="candy-face">{reporting ? (reportPhase || 'Asking Claude') : 'Generate Report'}</span>
          </button>
          <button className="candy-btn" data-shape="chip" onClick={addVodNotes}
            title="Add player-written notes (.md/.txt) to feed the next report generation">
            <span className="candy-face">Add Notes</span>
          </button>
          {scrim.scrim['VOD Report'] && (
            <button className="candy-btn" data-shape="chip" onClick={() => { setView({ kind: 'report', tab: 'tldr' }); setScrimOpen(false); }} title="Open the generated report">
              <span className="candy-face">Open Report</span>
            </button>
          )}
        </div>
      </AppWindow>

      {/* Reveal files — the tree-toolbar popover (3 targets). */}
      <Popover open={revealOpen} onClose={() => setRevealOpen(false)} outsideExempt="[data-scrim-reveal-trigger]" accent={accent} showClose title="Reveal"
        style={revealAnchor ? { position: 'fixed', left: Math.min(revealAnchor.left, window.innerWidth - 240), top: Math.min(revealAnchor.bottom + 6, window.innerHeight - 180), width: 220, zIndex: 100000 } : { display: 'none' }}
        bodyStyle={{ padding: 8 }}>
        <RevealRow label="Scrim file" onClick={() => revealPath(path)} />
        <RevealRow label="Comms transcript" onClick={() => revealPath(scrimSidecarPath(path, 'vodcomms'))} />
        <RevealRow label="Feedback sidecar" onClick={() => revealPath(scrimSidecarPath(path, 'vodfeedback'))} />
      </Popover>

      {/* Shared modals reused from the old return (report is inline now — no VodReportView popup). */}
      {matchPopup && (
        <MatchViewPopup sidecarPath={sidecarPath(path, matchPopup.n)} matchN={matchPopup.n} accent={accent} onClose={() => setMatchPopup(null)} />
      )}
      {tfOpen && (
        <TeamfightCommsView sidecarPath={sidecarPath(path, tfOpen.n, 'tfcomms')} accent={accent} onClose={() => setTfOpen(null)} />
      )}
      {review && (
        <ReviewModal accent={accent} teamName={review.teamName} items={review.items}
          onSave={(kept, dropped) => saveReview(review.idx, review.teamName, kept, dropped)} onClose={() => setReview(null)} />
      )}
    </div>
  );
}
