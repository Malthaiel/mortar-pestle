// Overlay Studio Panel â€” the merged in-game overlay (Overlay epic; promoted from
// the "Overlay Studio Panel" prototype). Replaces the two separate panels
// (Capture HUD + STT Overlay Panel) with ONE draggable panel whose three
// sections â€” Voice / Video / Screenshots â€” are candy tiles the user can drag to
// REORDER (reusing DraggableSidebarList, the same pointer hold-drag that powers
// the right-sidebar music/planner widgets). Order persists to localStorage
// (overlay-studio-order) because the bare overlay host can't reach the server-
// backed useSidebarOrder. Recent history shows inline (5 transcripts Â· 3 clips Â·
// 3 screenshots) with a per-section "View all" popup. STT + Game Capture are
// stubbed on Windows v1 â€” offline/empty states are intentional.
//
// Pointer arbitration: the OUTER panel drags by its â ¿ header grip only (dragProps
// on the header, not the panel body), because useOverlayPanelDrag only bails on
// button/input/[data-no-drag] and a tile is a <div class="candy-btn"> â€” a
// whole-body panel drag handle would fight the tile reorder. Tile bodies route to
// DraggableSidebarList; inner controls are real <button>/[data-no-drag].
import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useStt } from '@modules/studio/overlay/SttProvider.jsx';
import RecordButton from '@modules/studio/overlay/RecordButton.jsx';
import VuMeter from '@modules/studio/overlay/VuMeter.jsx';
import TranscriptView from '@modules/studio/overlay/TranscriptView.jsx';
import { insertTranscriptToDailyLog } from '@modules/studio/overlay/insertToDailyLog.js';
import DraggableSidebarList from '@host/components/DraggableSidebarList.jsx';
import { applyOrder } from '@host/hooks/useSidebarOrder.js';
import { api, mediaHttpUrl } from '@host/api.js';
import { openConcierge } from '@host/agents/concierge/ConciergeProvider.jsx';
import useOverlayPanelDrag from './useOverlayPanelDrag.js';
import { IconX } from '../components/icons.jsx';
import '@modules/studio/overlay/stt.css'; // reused .stt-vu / .stt-transcript chrome (the host never mounts SttPage)

// Panel presence â€” shared with StudioOverlayLauncher via localStorage + a window
// event (the OverlayBrowserPanel pattern). Default OPEN; hiding keeps the panel
// mounted (display:none) so recordings/transcripts in flight survive a minimize.
export const OPEN_EVT = 'overlay-studio-open-changed';
const OPEN_KEY = 'overlay-studio-open';
export const isPanelOpen = () => { try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; } };
export const setPanelOpen = (v) => {
  try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(OPEN_EVT, { detail: !!v }));
};

const ORDER_KEY = 'overlay-studio-order';
const HISTORY_KEY = 'overlay-stt-history';
const HISTORY_CAP = 20;
const CLIP_SECS = 30;
const DEFAULT_ORDER = ['voice', 'video', 'shots'];
const todayDs = () => new Date().toISOString().slice(0, 10);

function loadOrder() {
  try { const a = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null'); return Array.isArray(a) && a.length ? a : DEFAULT_ORDER; }
  catch { return DEFAULT_ORDER; }
}
function loadHistory() {
  try { const a = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function saveHistory(a) { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(a)); } catch { /* quota / private mode */ } }

function rel(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function mmss(secs) { const m = Math.floor(secs / 60), s = secs % 60; return `${m}:${String(s).padStart(2, '0')}`; }

function Thumb({ poster, glyph }) {
  const url = poster ? mediaHttpUrl(poster) : null;
  return <div className="ov-studio-thumb">{url ? <img src={url} alt="" /> : <span>{glyph}</span>}</div>;
}

// Fullscreen candy layer INSIDE the overlay webview (not AppWindow â€” host has no
// providers). Rendered as a sibling of the CSS-transformed panel so position:fixed
// anchors to the viewport, not the panel.
function ViewAllModal({ section, clips, shots, history, onClose, doCopy, onDelHistory }) {
  const title = section === 'voice' ? 'Voice Â· transcripts' : section === 'video' ? 'Video Â· clips' : 'Screenshots';
  const isList = section === 'voice';
  return (
    <div className="video-cinema ov-studio-modal" onPointerDown={(e) => { if (e.target.classList.contains('ov-studio-modal')) onClose(); }}>
      <div className="candy-card ov-studio-modal-card">
        <div className="candy-center-row ov-studio-sec-head">
          <span className="ov-studio-sec-title section-title">{title}</span>
          <button type="button" data-no-drag className="candy-btn" data-shape="icon" data-size="small" title="Close" aria-label="Close" onClick={onClose}><span className="candy-face"><IconX size={13} /></span></button>
        </div>
        <div className={`ov-studio-modal-body${isList ? ' is-list' : ''}`}>
          {section === 'video' && (clips.length
            ? clips.map((c) => <Thumb key={c.path} poster={c.poster} glyph="â–¶" />)
            : <div className="ov-studio-empty">No clips yet</div>)}
          {section === 'shots' && (shots.length
            ? shots.map((s) => <Thumb key={s.path} poster={s.poster} glyph="ðŸ–¼" />)
            : <div className="ov-studio-empty">No screenshots yet</div>)}
          {section === 'voice' && (history.length
            ? history.map((r) => (
              <div className="candy-center-row ov-studio-trow" key={r.id}>
                <span className="ov-studio-trow-text" title={r.text}>{r.text}</span>
                <span className="ov-studio-trow-ts">{rel(r.ts)}</span>
                <button type="button" data-no-drag className="candy-btn" data-size="small" onClick={() => doCopy(r.text)}><span className="candy-face">Copy</span></button>
                <button type="button" data-no-drag className="candy-btn" data-shape="icon" data-size="small" title="Delete" aria-label="Delete" onClick={() => onDelHistory(r.id)}><span className="candy-face"><IconX size={13} /></span></button>
              </div>
            ))
            : <div className="ov-studio-empty">No transcripts yet</div>)}
        </div>
      </div>
    </div>
  );
}

export default function OverlayStudioPanel({ showToast }) {
  const { style: dragStyle, dragProps } = useOverlayPanelDrag('overlay-panel-studio', { x: 220, y: 40 });
  // Minimized/open â€” driven by the bottom-left launcher chip.
  const [open, setOpen] = useState(isPanelOpen);
  useEffect(() => {
    const onChange = (e) => setOpen(!!e.detail);
    window.addEventListener(OPEN_EVT, onChange);
    return () => window.removeEventListener(OPEN_EVT, onChange);
  }, []);
  const [order, setOrder] = useState(loadOrder);
  const [viewAll, setViewAll] = useState(null); // 'voice' | 'video' | 'shots' | null

  // â”€â”€ Voice (STT) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const { engineDown, modelReady, recording, fileBusy, vu, text, settled, toggleDictation, setText } = useStt();
  const [autoCopy, setAutoCopy] = useState(() => localStorage.getItem('overlay-stt-autocopy') !== 'off');
  const [history, setHistory] = useState(loadHistory);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!recording) { setElapsed(0); return undefined; }
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const pushHistory = useCallback((t) => {
    setHistory((prev) => { const next = [{ id: `${Date.now()}-${prev.length}`, text: t, ts: Date.now() }, ...prev].slice(0, HISTORY_CAP); saveHistory(next); return next; });
  }, []);
  const doCopy = useCallback(async (t) => {
    const v = (t || '').trim(); if (!v) return;
    try { await navigator.clipboard.writeText(v); showToast('âœ“ Copied', 1600); }
    catch { showToast('Copy failed', 1600); }
  }, [showToast]);

  const prevSettled = useRef(false);
  useEffect(() => {
    if (settled && !prevSettled.current) { const t = (text || '').trim(); if (t) { pushHistory(t); if (autoCopy) doCopy(t); } }
    prevSettled.current = settled;
  }, [settled, text, autoCopy, doCopy, pushHistory]);

  const toggleAutoCopy = () => setAutoCopy((v) => { localStorage.setItem('overlay-stt-autocopy', v ? 'off' : 'on'); return !v; });
  const sendNote = async () => { const r = await insertTranscriptToDailyLog(text); showToast(r?.ok ? 'Sent to Quick Notes' : 'Send failed', 1600); };
  const sendTask = async () => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim(); if (!clean) return;
    try { await api.daySections.addTask(todayDs(), clean); showToast('Sent to Planner', 1600); } catch { showToast('Send failed', 1600); }
  };
  const delHistory = (id) => setHistory((prev) => { const next = prev.filter((r) => r.id !== id); saveHistory(next); return next; });
  const micDisabled = engineDown || !modelReady || fileBusy;
  const canSend = !!(text || '').trim();

  // â”€â”€ Video (Game Capture) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const [recordingVid, setRecordingVid] = useState(false);
  const [clips, setClips] = useState([]);
  const refreshClips = useCallback(() => { invoke('capture_list_clips').then((cs) => { if (Array.isArray(cs)) setClips(cs); }).catch(() => {}); }, []);
  const [shots, setShots] = useState([]);
  const refreshShots = useCallback(() => { invoke('capture_list_screenshots').then((ss) => { if (Array.isArray(ss)) setShots(ss); }).catch(() => {}); }, []);

  useEffect(() => {
    invoke('get_capture_state').then((s) => { if (s && typeof s.recording === 'boolean') setRecordingVid(s.recording); }).catch(() => {});
    // Chain the unlisten onto the registration promise â€” a plain `un` variable is
    // still null if we unmount before `listen` resolves, orphaning the listener.
    const p = listen('capture-state', (e) => {
      const d = e.payload; if (!d) return;
      if (typeof d.state === 'string') { if (typeof d.recording === 'boolean') setRecordingVid(d.recording); }
      else if (d.code || d.message) { showToast('Save failed'); }
    });
    return () => { p.then((un) => un()).catch(() => {}); };
  }, [showToast]);

  useEffect(() => {
    refreshClips();
    refreshShots();
    const subs = [
      listen('capture-saved', () => { showToast('Clip saved âœ“'); refreshClips(); }),
      listen('capture-screenshot-saved', () => { showToast('Screenshot saved'); refreshShots(); }),
    ];
    return () => subs.forEach((p) => p.then((un) => un()).catch(() => {}));
  }, [refreshClips, refreshShots, showToast]);

  const clip = async () => {
    try { await invoke('capture_save_replay', { windowSecs: CLIP_SECS }); showToast(`Clipped last ${CLIP_SECS}s`); }
    catch (e) { const msg = String(e?.message || e || ''); showToast(/arm|ring/i.test(msg) ? 'Arm the replay ring first' : 'Clip failed â€” engine down?'); }
  };
  const toggleRecord = async () => {
    try { if (recordingVid) { await invoke('capture_stop'); showToast('Savingâ€¦'); } else { await invoke('capture_start'); showToast('Recording started'); } }
    catch { showToast('Capture engine unavailable'); }
  };
  const screenshot = async () => {
    // SF9 toggle (Settings â†’ Overlay â€º Capture): whether the shot shows the overlay
    // panels. Read fresh at click time â€” the flag is written by another webview.
    let includeOverlay = false;
    try { includeOverlay = localStorage.getItem('overlay-shot-include-overlay') === '1'; } catch { /* default clean shot */ }
    try { await invoke('capture_screenshot', { includeOverlay }); showToast('Screenshotâ€¦'); }
    catch { showToast('Screenshot failed'); }
  };

  // â”€â”€ Sections (reorderable tiles) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const sections = [
    {
      id: 'voice',
      render: () => (
        <div className="candy-btn ov-studio-tile" data-shape="tile" aria-label="Voice section">
          <div className="candy-face">
            <div className="candy-center-row ov-studio-sec-head">
              <span className="ov-studio-sec-title section-title">Voice{recording && <> Â· <span style={{ color: 'var(--accent)' }}>â— live</span> Â· {mmss(elapsed)}</>}</span>
              <button type="button" data-no-drag className="candy-btn" data-size="small" onClick={() => setViewAll('voice')}><span className="candy-face">View all</span></button>
            </div>
            <div className="candy-center-row" style={{ gap: 10 }}>
              <RecordButton recording={recording} disabled={micDisabled} onToggle={toggleDictation} />
              <div style={{ flex: 1, minWidth: 0 }}><VuMeter rms={vu} active={recording} /></div>
            </div>
            <TranscriptView text={text} settled={settled} busy={recording || fileBusy} placeholder={engineDown ? 'Voice engine offline' : 'Your transcript appears here'} onChange={setText} />
            {/* marginTop: -4px (candy-face gap 12â†’8 raw) + -2.4px (.stt-transcript line-height 1.6 bottom half-leading slack) â†’ transcriptâ†’actions visible 8 (was 14.4); 2.4px is font-derived, stable */}
            <div className="candy-center-row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 'calc(-4px - 2.4px)' }}>
              <button type="button" data-no-drag className="candy-btn" data-size="small" disabled={!canSend} onClick={sendNote}><span className="candy-face">Note</span></button>
              <button type="button" data-no-drag className="candy-btn" data-size="small" disabled={!canSend} onClick={sendTask}><span className="candy-face">Task</span></button>
              <button type="button" data-no-drag className="candy-btn" data-size="small" disabled={!canSend} title="Ask Concierge â€” send transcript" onClick={() => openConcierge({ prefill: text })}><span className="candy-face">Claude</span></button>
              <span style={{ flex: 1 }} />
              <button type="button" data-no-drag className={`candy-btn${autoCopy ? ' is-active' : ''}`} data-shape="chip" data-size="small" title="Auto-copy on final" aria-pressed={autoCopy} onClick={toggleAutoCopy}><span className="candy-face">Auto-copy</span></button>
            </div>
            {history.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {history.slice(0, 5).map((r) => (
                  <div className="candy-center-row ov-studio-trow" key={r.id}>
                    <span className="ov-studio-trow-text" title={r.text}>{r.text}</span>
                    <span className="ov-studio-trow-ts">{rel(r.ts)}</span>
                    <button type="button" data-no-drag className="candy-btn" data-size="small" onClick={() => doCopy(r.text)}><span className="candy-face">Copy</span></button>
                    <button type="button" data-no-drag className="candy-btn" data-shape="icon" data-size="small" title="Delete" aria-label="Delete" onClick={() => delHistory(r.id)}><span className="candy-face"><IconX size={13} /></span></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ),
    },
    {
      id: 'video',
      render: () => (
        <div className="candy-btn ov-studio-tile" data-shape="tile" aria-label="Video section">
          <div className="candy-face">
            <div className="candy-center-row ov-studio-sec-head">
              <span className="ov-studio-sec-title section-title">Video</span>
              <button type="button" data-no-drag className="candy-btn" data-size="small" onClick={() => setViewAll('video')}><span className="candy-face">View all</span></button>
            </div>
            <div className="candy-center-row" style={{ gap: 8 }}>
              <button type="button" data-no-drag className="candy-btn" data-size="small" onClick={clip}><span className="candy-face">â–£ Clip last 30s</span></button>
              <button type="button" data-no-drag className={`candy-btn${recordingVid ? ' is-active' : ''}`} data-size="small" onClick={toggleRecord}><span className="candy-face">{recordingVid ? 'â–  Stop' : 'â— Record'}</span></button>
            </div>
            {clips.length ? (
              <div className="ov-studio-thumbs">{clips.slice(0, 3).map((c) => <Thumb key={c.path} poster={c.poster} glyph="â–¶" />)}</div>
            ) : <div className="ov-studio-empty">No clips yet</div>}
          </div>
        </div>
      ),
    },
    {
      id: 'shots',
      render: () => (
        <div className="candy-btn ov-studio-tile" data-shape="tile" aria-label="Screenshots section">
          <div className="candy-face">
            <div className="candy-center-row ov-studio-sec-head">
              <span className="ov-studio-sec-title section-title">Screenshots</span>
              <button type="button" data-no-drag className="candy-btn" data-size="small" onClick={() => setViewAll('shots')}><span className="candy-face">View all</span></button>
            </div>
            <div className="candy-center-row" style={{ gap: 8 }}>
              <button type="button" data-no-drag className="candy-btn" data-size="small" onClick={screenshot}><span className="candy-face">ðŸ“· Screenshot</span></button>
            </div>
            {shots.length ? (
              <div className="ov-studio-thumbs">{shots.slice(0, 3).map((s) => <Thumb key={s.path} poster={s.poster} glyph="ðŸ–¼" />)}</div>
            ) : <div className="ov-studio-empty">No screenshots yet</div>}
          </div>
        </div>
      ),
    },
  ];
  const ordered = applyOrder(sections, order, (s) => s.id);

  const handleReorder = (from, to) => {
    const ids = ordered.map((s) => s.id);
    if (to === from || to === from + 1) return;
    const adjustedTo = from < to ? to - 1 : to;
    const next = ids.slice();
    const [moved] = next.splice(from, 1);
    next.splice(adjustedTo, 0, moved);
    setOrder(next);
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(next)); } catch { /* quota / private mode */ }
  };

  return (
    <>
      <div className="video-cinema" style={{ position: 'absolute', top: 0, left: 0, background: 'transparent', padding: 0, display: open ? undefined : 'none', ...dragStyle }}>
        <div className="candy-card ov-studio-panel">
          <div className="candy-center-row ov-studio-head" {...dragProps} style={{ touchAction: 'none' }}>
            <span className="ov-studio-title section-title">Studio Overlay</span>
            <span className="stt-grip" aria-hidden="true">â ¿</span>
          </div>
          <DraggableSidebarList
            items={ordered}
            keyExtractor={(s) => s.id}
            renderItem={(s) => s.render()}
            onReorder={handleReorder}
            growToContain
            style={{ gap: 'var(--ov-gap)' }}
          />
        </div>
      </div>
      {viewAll && (
        <ViewAllModal section={viewAll} clips={clips} shots={shots} history={history} onClose={() => setViewAll(null)} doCopy={doCopy} onDelHistory={delHistory} />
      )}
    </>
  );
}
