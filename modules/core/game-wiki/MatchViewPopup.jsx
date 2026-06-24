// MatchViewPopup — the "View Full Match" popup (Full Match Data Extraction, SF-A).
// Settings-drawer-style chrome: AppWindow + a left rail of candy-btn rows + a content
// pane, mirroring SettingsDrawer. Only the active tab mounts (heavy per-tab extraction
// runs lazily on mount). Reads the raw sidecar (the source of truth) once and hands it
// to each tab. Degrades gracefully: missing sidecar → re-run prompt; bad JSON → error.

import { useEffect, useState } from 'react';
import { api } from '@host/api.js';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { candyGap } from '@host/util/candy.js';
import { IconTable, IconUsers, IconSword, IconChart, IconMap } from '@host/components/icons.jsx';
import { extractMatch } from './matchData.js';
import ScoreboardTab from './ScoreboardTab.jsx';
import PlayerStatsTab from './PlayerStatsTab.jsx';
import LanesTab from './LanesTab.jsx';
import GraphTab from './GraphTab.jsx';
import MapTab from './MapTab.jsx';

const TABS = [
  { id: 'scoreboard', label: 'Scoreboard', icon: IconTable },
  { id: 'players', label: 'Player Stats', icon: IconUsers },
  { id: 'lanes', label: 'Lanes', icon: IconSword },
  { id: 'graph', label: 'Graph', icon: IconChart },
  { id: 'map', label: 'Map', icon: IconMap },
];

const muted = { color: 'var(--text-muted)', fontSize: 13 };

function RailButton({ active, accent, onClick, icon: Icon, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-own-press
      className={`candy-btn${active ? ' is-active' : ''}`}
      data-shape="row"
      style={accent ? { '--accent': accent } : undefined}
    >
      <span className="candy-face">
        {Icon && <Icon size={18} />}
        <span style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>{children}</span>
      </span>
    </button>
  );
}

export default function MatchViewPopup({ sidecarPath, matchN, accent, onClose }) {
  const [tab, setTab] = useState('scoreboard');
  const [state, setState] = useState({ status: 'loading' });

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

  const { status, m, raw } = state;

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
      {/* Left rail */}
      <div style={{
        width: 186, flexShrink: 0, padding: '14px 10px',
        borderRight: '1px solid var(--border)', background: 'var(--surface-2)',
        display: 'flex', flexDirection: 'column', gap: candyGap(8),
        overflowY: 'auto', overflowX: 'hidden',
      }}>
        {TABS.map((t) => (
          <RailButton key={t.id} active={t.id === tab} accent={accent} icon={t.icon}
            onClick={() => setTab(t.id)}>{t.label}</RailButton>
        ))}
      </div>

      {/* Content pane */}
      <div style={{ flex: 1, minWidth: 0, padding: '20px 24px', overflowY: 'auto' }}>
        {status === 'loading' && <div style={muted}>Loading match data…</div>}
        {status === 'missing' && <div style={muted}>Raw match data unavailable — re-run Process.</div>}
        {status === 'parse-error' && <div style={{ color: 'var(--error)', fontSize: 13 }}>Couldn’t parse stored match data.</div>}
        {status === 'ready' && (
          <>
            {tab === 'scoreboard' && <ScoreboardTab m={m} raw={raw} />}
            {tab === 'players' && <PlayerStatsTab raw={raw} />}
            {tab === 'lanes' && <LanesTab raw={raw} />}
            {tab === 'graph' && <GraphTab raw={raw} />}
            {tab === 'map' && <MapTab raw={raw} />}
          </>
        )}
      </div>
    </AppWindow>
  );
}
