// Scrim Overlay Panel — the GameWiki as a draggable candy panel in the Overlay
// Host (GameWiki Unification Phase 5): the shared GameWikiRail tree in a
// CollapsibleRail + the shared GameWikiPage pane, driven by LOCAL selection
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
import { invoke } from '../api.js';
import CollapsibleRail from '../components/ui/CollapsibleRail.jsx';
import GameWikiRail, { RailHeaderPill } from '@modules/core/game-wiki/GameWikiRail.jsx';
import { readStopwatch } from '@modules/core/game-wiki/useStopwatch.js';
import {
  appendMatchNote, setMatchFieldIfEmpty, readOverviewFm, DICTATION_TARGET_KEY,
} from '@modules/core/game-wiki/scrimShared.jsx';

// react-markdown rides in GameWikiPage (~100KB) — lazy-split off the overlay boot
// chunk, mirroring the main app's split (index.jsx).
const GameWikiPage = lazy(() => import('@modules/core/game-wiki/GameWikiPage.jsx'));

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

export default function ScrimOverlayPanel() {
  const { style: dragStyle, dragProps, nudgeX, nudgeY, commitPos } = useOverlayPanelDrag('overlay-panel-scrim', { x: 40, y: 40 });
  // Minimized/open — driven by the bottom-left launcher chip.
  const [open, setOpen] = useState(isPanelOpen);
  useEffect(() => {
    const onChange = (e) => setOpen(!!e.detail);
    window.addEventListener(OPEN_EVT, onChange);
    return () => window.removeEventListener(OPEN_EVT, onChange);
  }, []);

  // Local selection + nav shim (GameWikiRail/GameWikiPage call nav with
  // '/game-wiki/<encoded path>' — decode into the sel string).
  const [sel, setSel] = useState(loadSel);
  const selRef = useRef(sel); selRef.current = sel;
  const nav = useCallback((to) => {
    const m = String(to || '').match(/^\/game-wiki(?:\/(.*))?$/);
    const rest = m && m[1] ? decodeURIComponent(m[1]) : '';
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
  const matchN = Number((sel.match(/\/Matches\/Match (\d+)$/) || [])[1]) || null;
  const scrimTitle = scrimFolder ? titleOf(scrimFolder.split('/').pop()) : '';
  const [ov, setOv] = useState(null); // Overview frontmatter (teams, coached) for the open scrim
  useEffect(() => {
    if (!scrimFolder) { setOv(null); return undefined; }
    let c = false;
    readOverviewFm(scrimFolder).then((f) => { if (!c) setOv(f); }).catch(() => {});
    return () => { c = true; };
  }, [scrimFolder]);
  const coached = ov?.['Coached Team'] || ov?.['Team 1'] || '';

  // Elapsed — polled from the same per-match stopwatch the notes timer uses.
  const [elapsed, setElapsed] = useState(null);
  useEffect(() => {
    if (!scrimFolder || matchN == null || !matchN) { setElapsed(null); return undefined; }
    const key = `gw-sw:${scrimFolder}:m${matchN}:${coached}`;
    const tick = () => setElapsed(readStopwatch(key).elapsedSec);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [scrimFolder, matchN, coached]);

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

  // Dictation / screenshot fallback: when the target match page is NOT the page
  // currently open here, finish the capture on disk (scrimShared helpers). A
  // mounted MatchPage handles its own events through its save loop.
  useEffect(() => {
    const subs = [
      listen('overlay-dictation-committed', (e) => {
        const p = e.payload || {};
        if (!p.scrimPath || p.matchN == null) return;
        if (selRef.current === `${p.scrimPath}/Matches/Match ${p.matchN}`) return; // MatchPage owns it
        appendMatchNote(p.scrimPath, Number(p.matchN), p.coachedTeam || '', p.text)
          .then(() => invoke('overlay_note_toast', { text: String(p.text || '').trim() }).catch(() => {}))
          .catch(() => {});
      }),
      listen('capture-screenshot-saved', (e) => {
        const pth = e.payload?.path;
        if (!pth) return;
        let t = null;
        try { t = JSON.parse(localStorage.getItem(DICTATION_TARGET_KEY) || 'null'); } catch { /* corrupt */ }
        if (!t?.folder || !t?.n) return;
        if (selRef.current === `${t.folder}/Matches/Match ${t.n}`) return; // MatchPage owns it
        setMatchFieldIfEmpty(t.folder, Number(t.n), 'Scoreboard', pth).catch(() => {});
      }),
    ];
    return () => subs.forEach((s) => s.then((u) => u()).catch(() => {}));
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

  // Ticker items: SCRIM OVERLAY · scrim title · MATCH n · MM:SS ELAPSED (LIVE
  // died with Go Live). One group = items each led by a ● separator; rendered
  // twice in the track for a seamless translateX(0 → -50%) loop.
  const tickerItems = [{ text: 'GAMEWIKI OVERLAY', bright: true }];
  if (scrimTitle) tickerItems.push({ text: scrimTitle, bright: true });
  if (matchN) {
    tickerItems.push({ text: `MATCH ${matchN}` });
    if (elapsed != null) {
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      tickerItems.push({ text: `${mm}:${ss} ELAPSED` });
    }
  }
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
          {live && (
            <button type="button" data-no-drag className="candy-btn" data-size="small"
              title="Stop routing scrim voice notes to this match"
              aria-label="End live scrim" onClick={endLive}>
              End Live
            </button>
          )}
        </div>

        {/* Body — shared tree rail + shared page pane, local selection. */}
        <div className="ov-scrim-body" style={height != null ? { flex: 1 } : undefined}>
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <CollapsibleRail expanded={railOpen} width={210} railWidth={44}
              header={<RailHeaderPill label={scrimTitle || 'GAMEWIKI OVERLAY'}
                title={railOpen ? 'Collapse rail' : 'Expand rail'} onClick={toggleRail} expanded={railOpen} />}
              containerStyle={{ borderRight: '1px solid var(--border)' }}>
              <GameWikiRail route={{ page: 'game-wiki', rest: sel }} nav={nav} header={null} />
            </CollapsibleRail>
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <Suspense fallback={null}>
                <GameWikiPage rest={sel} nav={nav} overlay />
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
