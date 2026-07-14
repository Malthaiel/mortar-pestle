// MatchViewPopup — the "View Full Match" popup (Full Match Data Extraction, SF-A; Match View
// Rework, Phase 0). AppWindow + a folding, resizeable file-tree sidebar (MatchTree, built from
// the shared treeKit primitives) + a content pane. The old flat 5-row candy rail is gone: the
// rail is now six sections — Scoreboard, Player Stats (per-player leaves), Lanes (per-lane
// leaves), Graphs (per-player leaves), Map, and Match Analysis. Reads the raw sidecar (source
// of truth) once and hands it to each section. Degrades gracefully: missing sidecar → re-run
// prompt; bad JSON → error.

import { useEffect, useState } from 'react';
import { api, invoke } from '@host/api.js';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { IconTable } from '@host/components/icons.jsx';
import { extractMatch, extractPlayers, extractLanes } from './matchData.js';
import MatchTree from './MatchTree.jsx';
import TreeToolbar from '@host/components/vault-tree/TreeToolbar.jsx';
import RailSplitter from './RailSplitter.jsx';
import ScoreboardTab from './ScoreboardTab.jsx';
import PlayerStatsTab from './PlayerStatsTab.jsx';
import LanesTab from './LanesTab.jsx';
import GraphTab from './GraphTab.jsx';
import MapTab from './MapTab.jsx';
import TeamfightCommsView from './TeamfightCommsView.jsx';

const muted = { color: 'var(--text-muted)', fontSize: 13 };

// Rail width persistence (per-popup; the tree is denser than the old 186px rail).
const RAIL_KEY = 'mvpopup.railW';
const RAIL_MIN = 150, RAIL_MAX = 360, RAIL_DEFAULT = 210;
const readRailW = () => {
  const v = Number(localStorage.getItem(RAIL_KEY));
  return Number.isFinite(v) && v >= RAIL_MIN && v <= RAIL_MAX ? v : RAIL_DEFAULT;
};

// Steam persona resolution is deferred (CORS-blocked → needs a Rust command + the user's key);
// until it lands the tree labels fall back to hero names. This empty map is the seam.
const NO_PERSONAS = new Map();

export default function MatchViewPopup({ sidecarPath, matchN, accent, onClose }) {
  const [sel, setSel] = useState({ section: 'scoreboard' });
  const [railW, setRailW] = useState(readRailW);
  const [tfOpen, setTfOpen] = useState(false);
  const [state, setState] = useState({ status: 'loading' });
  const [ctrl, setCtrl] = useState(null); // MatchTree controller handle (collapse/expand-all) for the toolbar

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api.getRawFileMeta(sidecarPath, 'gamewiki')
      .then((r) => {
        if (cancelled) return;
        let raw;
        try { raw = JSON.parse(r.content); } catch { setState({ status: 'parse-error' }); return; }
        setState({ status: 'ready', raw, m: extractMatch(raw) });
      })
      .catch(() => { if (!cancelled) setState({ status: 'missing' }); });
    return () => { cancelled = true; };
  }, [sidecarPath]);

  const setWidth = (w) => { setRailW(w); localStorage.setItem(RAIL_KEY, String(w)); };

  const { status, m, raw } = state;
  const ready = status === 'ready';
  const players = ready ? extractPlayers(raw) : [];
  const lanes = ready ? extractLanes(raw).map((l) => l.lane) : [];
  // The teamfight-comms review sidecar is the matchdata sidecar's twin (same base, .tfcomms prefix).
  const tfPath = sidecarPath.includes('.matchdata.') ? sidecarPath.replace('.matchdata.', '.tfcomms.') : null;

  return (
    <AppWindow
      open
      onClose={onClose}
      title={`Match ${matchN}`}
      accent={accent}
      icon={<IconTable size={18} />}
      width="min(1100px, 92vw)"
      height="min(760px, 88vh)"
      footer={(
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.5, fontFamily: 'var(--font-mono)' }}>
          <b style={{ color: 'var(--text-2)' }}>Rendered:</b> scoreboard · meta · per-player stats, builds, abilities, focus-fire · lanes · time-series · deaths · movement.
          {' '}<b style={{ color: 'var(--text-2)' }}>Deferred:</b> real map overlay, accolade names (not in payload), damage-by-source, <code>stats_type_stat</code>, hero build templates.
        </div>
      )}
      bodyStyle={{ padding: 0, overflowY: 'hidden', display: 'flex', fontFamily: 'var(--font-mono)' }}
    >
      {/* Left rail — toolbar (fixed) + folding resizeable tree (scroll). Tweak 1: TreeToolbar
          above MatchTree, collapse/expand-all driven via the MatchTree controller + reveal-match-file. */}
      <div style={{
        width: railW, flexShrink: 0,
        background: 'var(--surface-2)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ flexShrink: 0, padding: '10px 10px 6px' }}>
          <TreeToolbar
            buttons={{
              collapse: { show: true },
              revealInFiles: { show: true, title: 'Reveal match file', onClick: () => invoke('coaching_reveal_path', { path: sidecarPath }).catch((e) => console.error('coaching_reveal_path failed:', e)) },
            }}
            controller={ctrl || { anyExpanded: false, expandAll: () => {}, collapseAll: () => {} }}
            accent={accent}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '4px 10px 14px' }}>
          {ready && (
            <MatchTree players={players} lanes={lanes} sel={sel} onSel={setSel}
              accent={accent} personas={NO_PERSONAS} onController={setCtrl} />
          )}
        </div>
      </div>
      <RailSplitter width={railW} min={RAIL_MIN} max={RAIL_MAX} onWidth={setWidth} />

      {/* Content pane */}
      <div style={{ flex: 1, minWidth: 0, padding: '20px 24px', overflowY: 'auto' }}>
        {status === 'loading' && <div style={muted}>Loading match data…</div>}
        {status === 'missing' && <div style={muted}>Raw match data unavailable — re-run Process.</div>}
        {status === 'parse-error' && <div style={{ color: 'var(--error)', fontSize: 13 }}>Couldn’t parse stored match data.</div>}
        {ready && (
          <>
            {sel.section === 'scoreboard' && <ScoreboardTab m={m} raw={raw} />}
            {sel.section === 'players' && <PlayerStatsTab raw={raw} only={sel.slot} />}
            {sel.section === 'lanes' && <LanesTab raw={raw} only={sel.lane} />}
            {sel.section === 'graphs' && <GraphTab raw={raw} only={sel.slot} />}
            {sel.section === 'map' && <MapTab raw={raw} />}
            {sel.section === 'analysis' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 460 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Match Analysis</div>
                <div style={{ ...muted, lineHeight: 1.5 }}>
                  The teamfight comms review for this match. Run <b>Review Comms</b> on the match first if it isn’t ready yet.
                </div>
                <button type="button" className="candy-btn" data-shape="chip" data-own-press
                  disabled={!tfPath} onClick={() => setTfOpen(true)}
                  style={accent ? { '--accent': accent, alignSelf: 'flex-start' } : { alignSelf: 'flex-start' }}>
                  <span className="candy-face">Open Review</span>
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {tfOpen && tfPath && (
        <TeamfightCommsView sidecarPath={tfPath} accent={accent} onClose={() => setTfOpen(false)} />
      )}
    </AppWindow>
  );
}
