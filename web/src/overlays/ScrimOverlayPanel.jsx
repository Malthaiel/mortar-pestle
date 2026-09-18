// Scrim Overlay Panel — the Deadlock as a draggable candy panel in the Overlay
// Host (Deadlock Unification Phase 5): the shared DeadlockRail tree in a
// CollapsibleRail + the shared DeadlockPage pane, driven by LOCAL selection
// state (a navigate shim — no router exists in this webview). Non-scrim pages
// render read-only (the overlay is a mini wiki browser). The header is a slow
// seamless broadcast-HUD ticker; the whole band is the drag handle. Go Live /
// slim mode is GONE — dictation targets the last match page opened here
// (persisted; survives Shift+C reloads), and the panel finishes dictation /
// screenshot capture on disk when that match page isn't currently mounted.
// Accent resolves free — --accent is painted on :root by the host (OverlayHostView).
import { lazy, Suspense, useState, useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import useOverlayPanelDrag from './useOverlayPanelDrag.js';
import { invoke, emitDeadlockFileWritten, subscribeDeadlockFileWritten } from '../api.js';
import { safeDecode } from '../router.js';
import CollapsibleRail from '../components/ui/CollapsibleRail.jsx';
import DeadlockRail, { RailHeaderPill } from '@modules/core/deadlock/DeadlockRail.jsx';
import { api } from '../api.js';
import { VOD_BASE } from '@modules/core/deadlock/scrimSchema.js';
import { appendNote, setVodVideo, vodFile } from '@modules/core/deadlock/vodNotes.js';
import * as vodTimer from '@modules/core/deadlock/vodTimer.js';

// Scrim Teardown (2026-07-26): the live-notes path is GONE. Overview.md, match
// pages and the per-match stopwatch it read no longer exist, so the panel is a
// wiki browser plus the live-target control. The dictation target key moved here
// (it outlived scrimShared, which went with the scrim pages it served) — Rust
// still owns the live cell, so Go Live from a future surface keeps working.
const DICTATION_TARGET_KEY = 'overlay-dictation-target';

// react-markdown rides in DeadlockPage (~100KB) — lazy-split off the overlay boot
// chunk, mirroring the main app's split (index.jsx).
const DeadlockPage = lazy(() => import('@modules/core/deadlock/DeadlockPage.jsx'));

// Panel presence — shared with ScrimOverlayLauncher via localStorage + a window
// event (the OverlayBrowserPanel pattern). Default OPEN; hiding keeps the panel
// mounted (display:none) so timers, drafts, and dictation survive a minimize.
export const OPEN_EVT = 'overlay-scrim-open-changed';
const OPEN_KEY = 'overlay-scrim-open';
export const isPanelOpen = () => { try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; } };
export const setPanelOpen = (v) => {
  try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(OPEN_EVT, { detail: !!v }));
};

// All-direction edge/corner resize — the panel is content-height until the user
// drags a vertical edge (then height is pinned). Single size now (per-mode live
// sizes died with Go Live).
const SCRIM_W_KEY = 'overlay-panel-scrim-width';
const SCRIM_H_KEY = 'overlay-panel-scrim-height';
const SCRIM_MIN_W = 360, SCRIM_MAX_W = 900, SCRIM_DEFAULT_W = 460;
const SCRIM_MIN_H = 220, SCRIM_MAX_H = 1400;
const vpW = () => (typeof window !== 'undefined' && window.innerWidth) || SCRIM_MAX_W;
const vpH = () => (typeof window !== 'undefined' && window.innerHeight) || SCRIM_MAX_H;
const clampScrimW = (w) => Math.min(Math.max(w, SCRIM_MIN_W), Math.min(SCRIM_MAX_W, vpW()));
const clampScrimH = (h) => Math.min(Math.max(h, SCRIM_MIN_H), Math.min(SCRIM_MAX_H, vpH() - 20));
const loadScrimW = () => { try { const v = parseInt(localStorage.getItem(SCRIM_W_KEY), 10); return Number.isFinite(v) ? clampScrimW(v) : SCRIM_DEFAULT_W; } catch { return SCRIM_DEFAULT_W; } };
const loadScrimH = () => { try { const v = parseInt(localStorage.getItem(SCRIM_H_KEY), 10); return Number.isFinite(v) ? clampScrimH(v) : null; } catch { return null; } };
// 8 handles: 4 edges + 4 corners.
const RESIZE_HANDLES = ['l', 'r', 't', 'b', 'tl', 'tr', 'bl', 'br'];

// Local selection (the nav shim's state) — persisted so the overlay reopens on
// the page it was left on (state dies on every Shift+C reload).
const SEL_KEY = 'overlay-gw-selected';
const RAIL_KEY = 'overlay-gw-rail-open';
const loadSel = () => { try { return localStorage.getItem(SEL_KEY) || ''; } catch { return ''; } };
const loadRailOpen = () => { try { return localStorage.getItem(RAIL_KEY) !== '0'; } catch { return true; } };

// "TEAM1 VS TEAM2 (MM-DD-YY)" → "TEAM1 VS TEAM2" (date suffix dropped).
const titleOf = (base) => String(base || '').replace(/\s*\(\d{2}-\d{2}-\d{2}\)\s*$/, '');

// A Personal VOD note file: a direct child of VOD_BASE, no deeper.
function vodPathOf(sel) {
  if (!sel || !sel.startsWith(VOD_BASE + '/')) return null;
  const rest = sel.slice(VOD_BASE.length + 1);
  return rest && !rest.includes('/') ? sel : null;
}

export default function ScrimOverlayPanel() {
  const { style: dragStyle, dragProps, nudgeX, nudgeY, commitPos } = useOverlayPanelDrag('overlay-panel-scrim', { x: 40, y: 40 });
  // Minimized/open — driven by the bottom-left launcher chip.
  const [open, setOpen] = useState(isPanelOpen);
  useEffect(() => {
    const onChange = (e) => setOpen(!!e.detail);
    window.addEventListener(OPEN_EVT, onChange);
    return () => window.removeEventListener(OPEN_EVT, onChange);
  }, []);

  // Local selection + nav shim (DeadlockRail/DeadlockPage call nav with
  // '/deadlock/<encoded path>' — decode into the sel string).
  const [sel, setSel] = useState(loadSel);
  const nav = useCallback((to) => {
    const m = String(to || '').match(/^\/deadlock(?:\/(.*))?$/);
    const rest = m && m[1] ? safeDecode(m[1]) : '';
    setSel(rest);
    try { localStorage.setItem(SEL_KEY, rest); } catch { /* private mode */ }
  }, []);
  const [railOpen, setRailOpenState] = useState(loadRailOpen);
  const toggleRail = () => setRailOpenState((v) => {
    const next = !v;
    try { localStorage.setItem(RAIL_KEY, next ? '1' : '0'); } catch { /* private mode */ }
    return next;
  });

  // Scrim context from the selection — feeds the ticker + the header pill.
  const scrimFolder = (sel.match(/^(Deadlock\/Coaching\/Scrim\/[^/]+)(?:\/|$)/) || [])[1] || null;
  const scrimTitle = scrimFolder ? titleOf(scrimFolder.split('/').pop()) : '';

  // Re-publish the persisted dictation target on mount (the Rust cell survives
  // reloads, but republishing keeps it in step with what this webview last set).
  useEffect(() => {
    let t = null;
    try { t = JSON.parse(localStorage.getItem(DICTATION_TARGET_KEY) || 'null'); } catch { /* corrupt */ }
    if (t?.folder && t?.n) {
      invoke('overlay_go_live', { target: { scrimPath: t.folder, matchN: t.n, coachedTeam: t.coached || null } }).catch(() => {});
    }
  }, []);

  // Live target — mirrors the Rust cell so the End Live control can show/hide. Rust
  // emits `overlay-live-target` on BOTH go-live and go-offline, so this one listener
  // covers a target set from the match page as well as one cleared here.
  const [live, setLive] = useState(null);
  useEffect(() => {
    invoke('overlay_get_live_target').then(setLive).catch(() => {});
    const sub = listen('overlay-live-target', (e) => setLive(e.payload ?? null));
    return () => { sub.then((un) => un()).catch(() => {}); };
  }, []);

  // End Live — clear the Rust cell AND the persisted target. Both are required:
  // without the localStorage clear, the mount effect above re-publishes the very
  // target we just cleared the next time this overlay opens (which is exactly why
  // a live scrim used to be impossible to switch off).
  const endLive = useCallback(() => {
    try { localStorage.removeItem(DICTATION_TARGET_KEY); } catch { /* private mode */ }
    invoke('overlay_go_offline').catch(() => {});
    setLive(null);
  }, []);


  // ── Personal VODs: the match timer + the dictated-note sink ──────────────
  // This panel is the note sink because the overlay-host window is created at
  // boot and never destroyed — Shift+C only hides it — so a listener here is
  // alive while Malthaiel is in the game. Rust already reroutes a hold-to-talk
  // transcript to `overlay-dictation-committed` whenever a live target is set;
  // that event has had NO listener since the Scrim Teardown deleted the match
  // pages. This is that listener, aimed at a VOD file instead.
  const selVod = vodPathOf(sel);
  const [timer, setTimer] = useState(vodTimer.read);
  const armedPath = timer.target;

  // One 1 s tick while the clock runs — elapsed is DERIVED from the anchor, so
  // the tick only exists to repaint, never to count.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!armedPath) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [armedPath]);

  // Arming a VOD IS starting the RECORDING (user call): one action, and End is
  // the only way a stray hold-to-talk stops writing into a finished match.
  //
  // The recorder is started FIRST and the clock is anchored on the instant it
  // reports — `started_at_unix_ms`, not a `Date.now()` taken here — so a note's
  // stamp and the video's playhead are the same number by construction. If the
  // engine refuses (not running, no game, taken device), NOTHING arms: a clock
  // running with no video behind it is worse than no clock, because every note
  // it stamps points at a file that will never exist.
  const armVod = useCallback(async (path) => {
    if (!path) return;
    let snap = null;
    try {
      snap = await invoke('capture_start');
    } catch (err) {
      invoke('overlay_note_toast', { text: `Recording NOT started: ${String(err?.message || err)}` }).catch(() => {});
      return;
    }
    if (!snap) {
      invoke('overlay_note_toast', { text: 'Recorder is not running — nothing started' }).catch(() => {});
      return;
    }
    setTimer(vodTimer.start(path, snap.started_at_unix_ms));
    invoke('overlay_go_live', { target: { scrimPath: path, matchN: 0, coachedTeam: null } }).catch(() => {});
  }, []);

  // The file the next `capture-saved` belongs to. Set at End, because by the
  // time the clip lands (poster + remux run off-thread) the timer is already
  // disarmed and there is nothing left to ask which match it was.
  const savingForRef = useRef(null);

  const endVod = useCallback(() => {
    const t = vodTimer.read();
    if (t.target) savingForRef.current = t.target;
    invoke('capture_stop').catch((err) => {
      invoke('overlay_note_toast', { text: `Recording stop failed: ${String(err?.message || err)}` }).catch(() => {});
    });
    setTimer(vodTimer.end());
    invoke('overlay_go_offline').catch(() => {});
  }, []);

  // Re-publish the armed VOD on mount, and RE-READ the recorder rather than
  // trusting the stored anchor. The Rust cell survives a webview reload, but the
  // scrim effect above republishes ITS persisted target, so without this a
  // Shift+C mid-match would silently repoint dictation at a dead scrim — and a
  // recording that died while the webview was gone would leave a clock counting
  // a match nothing is filming.
  useEffect(() => {
    const t = vodTimer.read();
    if (!t.target) return;
    invoke('overlay_go_live', { target: { scrimPath: t.target, matchN: 0, coachedTeam: null } }).catch(() => {});
    invoke('get_capture_state').then((snap) => {
      const recording = snap?.state === 'recording' || snap?.recording === true;
      if (!recording) { setTimer(vodTimer.end()); invoke('overlay_go_offline').catch(() => {}); return; }
      setTimer(vodTimer.anchor(snap.started_at_unix_ms));
    }).catch(() => {});
  }, []);

  // The recorder is the clock's truth in BOTH directions: it publishes the real
  // start instant once it leaves `starting`, and it can stop on its own (disk
  // full, game closed, encoder lost). Follow it either way — a clock that keeps
  // counting after the camera stopped is the lie this listener exists to stop.
  useEffect(() => {
    const sub = listen('capture-state', (e) => {
      const snap = e.payload;
      if (!vodTimer.isArmed()) return;
      const recording = snap?.state === 'recording' || snap?.recording === true;
      if (recording) { setTimer(vodTimer.anchor(snap.started_at_unix_ms)); return; }
      if (snap?.state === 'starting' || snap?.state === 'finalizing') return; // mid-transition
      savingForRef.current = vodTimer.read().target;
      setTimer(vodTimer.end());
      invoke('overlay_go_offline').catch(() => {});
      invoke('overlay_note_toast', { text: 'Recording stopped — match timer ended' }).catch(() => {});
    });
    return () => { sub.then((un) => un()).catch(() => {}); };
  }, []);

  // The clip landed: write its path onto the note it belongs to, so the notes
  // and the video find each other months later. One clip per End — the ref is
  // spent immediately so an unrelated later save can't overwrite the link.
  useEffect(() => {
    const sub = listen('capture-saved', async (e) => {
      const path = savingForRef.current;
      const file = e.payload?.path;
      if (!path || !file) return;
      savingForRef.current = null;
      try {
        const md = vodFile(path);
        const body = await api.getRawFile(md, 'deadlock');
        await api.savePage(md, setVodVideo(body, file), null, 'deadlock');
      } catch (err) {
        invoke('overlay_note_toast', { text: `Clip saved, but the note link failed: ${String(err?.message || err)}` }).catch(() => {});
      }
    });
    return () => { sub.then((un) => un()).catch(() => {}); };
  }, []);

  // The two global timer keys (Rust `global_shortcut` → `vod-timer-key`). They
  // fire while Deadlock has focus, which is the whole reason they are not DOM
  // chords. Start/End ONLY — pause went with the hand-rolled stopwatch: the
  // recorder has no pause, so a paused clock would desync from the video it is
  // supposed to index.
  useEffect(() => {
    const sub = listen('vod-timer-key', (e) => {
      const action = e.payload?.action;
      if (action === 'start') {
        // Start needs something to write into. Prefer what is already armed
        // (a no-op), else the VOD currently open in this panel.
        const path = vodTimer.read().target || vodPathOf(loadSel());
        if (!path) {
          invoke('overlay_note_toast', { text: 'Pick a VOD in the overlay first' }).catch(() => {});
          return;
        }
        armVod(path);
      } else if (action === 'end') {
        endVod();
      }
    });
    return () => { sub.then((un) => un()).catch(() => {}); };
  }, [armVod, endVod]);

  // The PRESS stamp. `stt-dictation-started` fires when the hold-to-talk key
  // goes DOWN; the transcript arrives seconds later on release. Stamping the
  // release would push every note as late as the sentence was long, so latch the
  // clock here and spend it when the words land.
  const pressMsRef = useRef(null);
  useEffect(() => {
    const sub = listen('stt-dictation-started', () => {
      pressMsRef.current = vodTimer.isArmed() ? vodTimer.elapsedMs() : null;
    });
    return () => { sub.then((un) => un()).catch(() => {}); };
  }, []);

  // The sink. Reads the file, appends the bullet, writes it back, and toasts —
  // the toast fires whether the overlay is hidden or open, so the confirmation
  // reaches him mid-game without Shift+C.
  useEffect(() => {
    const sub = listen('overlay-dictation-committed', async (e) => {
      const text = String(e.payload?.text || '').trim();
      const path = e.payload?.scrimPath;
      if (!text || !path || !vodPathOf(path)) return; // not a VOD target
      // Fall back to the live clock only if the press event never arrived — a
      // missing stamp is worse than a slightly late one.
      const stamp = pressMsRef.current ?? vodTimer.elapsedMs();
      pressMsRef.current = null;
      try {
        const file = vodFile(path);
        const body = await api.getRawFile(file, 'deadlock');
        await api.savePage(file, appendNote(body, stamp, text), null, 'deadlock');
        // The reader lives in the OTHER window and the Deadlock root is unwatched,
        // so tell it by hand or the note stays invisible until he navigates away.
        emitDeadlockFileWritten(file).catch(() => {});
        invoke('overlay_note_toast', { text: `${vodTimer.fmt(stamp)} — ${text}` }).catch(() => {});
      } catch (err) {
        // A dropped note is a defect, not an acceptable degradation — say so on
        // screen rather than losing the words silently.
        invoke('overlay_note_toast', { text: `Note NOT saved: ${String(err?.message || err)}` }).catch(() => {});
      }
    });
    return () => { sub.then((un) => un()).catch(() => {}); };
  }, []);

  // Resize (all edges + corners). Refs feed the pointer handlers the current size
  // without re-binding them each frame.
  const [width, setWidth] = useState(loadScrimW);
  const [height, setHeight] = useState(loadScrimH);
  const widthRef = useRef(width); widthRef.current = width;
  const heightRef = useRef(height); heightRef.current = height;
  const panelRef = useRef(null);
  const resize = useRef(null);
  const startResize = (hx, vy) => (e) => {
    e.preventDefault(); e.stopPropagation();
    if (vy && heightRef.current == null && panelRef.current) setHeight(clampScrimH(panelRef.current.getBoundingClientRect().height));
    resize.current = { hx, vy, lastX: e.clientX, lastY: e.clientY };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
  };
  const moveResize = useCallback((e) => {
    const r = resize.current; if (!r) return;
    const dx = e.clientX - r.lastX, dy = e.clientY - r.lastY; r.lastX = e.clientX; r.lastY = e.clientY;
    if (r.hx) {
      const cur = widthRef.current;
      const nw = clampScrimW(r.hx === 'right' ? cur + dx : cur - dx);
      if (nw !== cur) { if (r.hx === 'left') nudgeX(cur - nw); setWidth(nw); } // left edge: keep right fixed
    }
    if (r.vy) {
      const cur = heightRef.current; if (cur == null) return;
      const nh = clampScrimH(r.vy === 'bottom' ? cur + dy : cur - dy);
      if (nh !== cur) { if (r.vy === 'top') nudgeY(cur - nh); setHeight(nh); } // top edge: keep bottom fixed
    }
  }, [nudgeX, nudgeY]);
  const endResize = useCallback((e) => {
    if (!resize.current) return;
    resize.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    try {
      localStorage.setItem(SCRIM_W_KEY, String(widthRef.current));
      if (heightRef.current != null) localStorage.setItem(SCRIM_H_KEY, String(heightRef.current));
    } catch { /* ignore */ }
    commitPos();
  }, [commitPos]);
  const resizeProps = { onPointerMove: moveResize, onPointerUp: endResize, onPointerCancel: endResize };

  // Ticker items: GAMEWIKI OVERLAY · scrim title. One group = items each led by a
  // ● separator; rendered twice in the track for a seamless translateX(0 → -50%)
  // loop. The MATCH n / elapsed items went with the match pages that fed them.
  const tickerItems = [{ text: 'GAMEWIKI OVERLAY', bright: true }];
  if (scrimTitle) tickerItems.push({ text: scrimTitle, bright: true });
  // The match clock does NOT ride the ticker: a number you read at a glance
  // mid-game cannot be on a 45-second scroll. It sits still in the VOD bar
  // below, which is also why the Start control moved out of this band — the
  // band is the drag handle, and a button on a moving handle is a mis-drag
  // waiting to happen.
  const renderTickerGroup = (keyPrefix) => tickerItems.map((it, i) => (
    <span className="ov-scrim-ticker-group" key={`${keyPrefix}-${i}`}>
      <span className="ov-scrim-ticker-sep" aria-hidden="true">●</span>
      <span className={`ov-scrim-ticker-item${it.bright ? ' is-bright' : ''}`}>{it.text}</span>
    </span>
  ));

  return (
    <div className="video-cinema" style={{ position: 'absolute', top: 0, left: 0, background: 'transparent', padding: 0, display: open ? undefined : 'none', ...dragStyle }}>
      <div ref={panelRef} className="candy-card ov-scrim-panel" style={{ width, ...(height != null ? { height, maxHeight: 'none' } : null) }}>
        {/* Broadcast-HUD ticker header — the whole band is the drag handle. */}
        <div className="candy-center-row ov-studio-head" {...dragProps} style={{ touchAction: 'none' }}>
          <div className="ov-scrim-ticker">
            <div className="ov-scrim-ticker-track" style={{ animation: 'scrimTickerScroll 45s linear infinite' }}>
              {renderTickerGroup('a')}
              {renderTickerGroup('b')}
            </div>
          </div>
          {/* End Live — only while a scrim IS live; the scrim push-to-talk bind
              routes to it until this clears. */}
          {live && !armedPath && (
            <button type="button" data-no-drag className="candy-btn" data-size="small"
              title="Stop routing scrim voice notes to this match"
              aria-label="End live scrim" onClick={endLive}>
              <span className="candy-face">End Live</span>
            </button>
          )}
        </div>

        {/* Personal VOD bar — a STILL row under the moving band: clock hard
            left, the one recording control hard right. Shown when a VOD is open
            OR one is armed, so End cannot go out of reach by browsing away. */}
        {(selVod || armedPath) && (
          // The body below cancels the panel's own 8px gap with a negative
          // margin, so this row would sit flush against it and the Start
          // button's depth shadow would paint into the tree. Put the panel's
          // gap BACK with its own token rather than inventing a number —
          // measured, the band then clears by 4.0px against the header's 4.3px
          // above, so the bar reads evenly spaced between the two.
          <div className="candy-center-row" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, marginBottom: 'var(--ov-gap)' }}>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 15 }}>
              {vodTimer.fmt(vodTimer.elapsedMs(timer))}
            </span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.7, fontSize: 12 }}>
              {titleOf((armedPath || selVod).split('/').pop())}
            </span>
            {!armedPath ? (
              <button type="button" className="candy-btn" data-size="small"
                title="Start recording and send voice notes to this VOD"
                onClick={() => armVod(selVod)}>
                <span className="candy-face">Start</span>
              </button>
            ) : (
              <button type="button" className="candy-btn" data-size="small"
                title="Stop the recording and stop sending voice notes"
                onClick={endVod}>
                <span className="candy-face">End</span>
              </button>
            )}
          </div>
        )}

        {/* Body — shared tree rail + shared page pane, local selection. */}
        <div className="ov-scrim-body" style={height != null ? { flex: 1 } : undefined}>
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <CollapsibleRail expanded={railOpen} width={210} railWidth={44}
              header={<RailHeaderPill label={scrimTitle || 'GAMEWIKI OVERLAY'}
                title={railOpen ? 'Collapse rail' : 'Expand rail'} onClick={toggleRail} expanded={railOpen} />}
              containerStyle={{ borderRight: '1px solid var(--border)' }}>
              <DeadlockRail route={{ page: 'deadlock', rest: sel }} nav={nav} header={null} />
            </CollapsibleRail>
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <Suspense fallback={null}>
                <DeadlockPage rest={sel} nav={nav} overlay />
              </Suspense>
            </div>
          </div>
        </div>

        {/* Resize — hairline grab strips on every edge + corner. */}
        {RESIZE_HANDLES.map((k) => (
          <div key={k} className={`ov-resize-edge e-${k}`} data-no-drag title="Resize" aria-label="Resize scrim panel"
            onPointerDown={startResize(k.includes('l') ? 'left' : k.includes('r') ? 'right' : null, k.includes('t') ? 'top' : k.includes('b') ? 'bottom' : null)}
            {...resizeProps} />
        ))}
      </div>
    </div>
  );
}
