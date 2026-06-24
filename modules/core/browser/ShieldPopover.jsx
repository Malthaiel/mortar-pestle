// Toolbar Shield popup: global on/off + per-site on/off toggles, filter-list
// sizes (per-site block counts aren't tracked by the backend), an inline
// exceptions manager, and a deep-link to the full Shield & Data settings tab.
// Mirrors ShieldSettingsTab's blocker logic; rendered as a top drop-panel by
// BrowserPage. Opens even with no current site so global controls stay reachable.

import { useEffect, useState } from 'react';
import { useModuleSettings } from '@host/hooks/useSettings.js';
import { applyEnabled, applySiteAllowed, isHostAllowed, reloadShieldTabs } from './blocker.js';
import { candyGap } from '@host/util/candy.js';
import BrowserPopover from './BrowserPopover.jsx';

function ToggleButton({ on, accent, disabled, onToggle }) {
  const accentColor = accent || 'var(--text)';
  return (
    <button
      type="button" onClick={disabled ? undefined : onToggle} aria-pressed={on} disabled={disabled}
      style={{
        width: 44, height: 24, borderRadius: 999, flex: '0 0 auto',
        background: on ? accentColor : 'var(--border-2)', border: 'none', position: 'relative',
        cursor: disabled ? 'default' : 'pointer', padding: 0, opacity: disabled ? 0.5 : 1,
        transition: 'background 160ms ease',
      }}
    >
      <span aria-hidden style={{
        position: 'absolute', top: 2, left: on ? 22 : 2, width: 20, height: 20,
        borderRadius: '50%', background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
        transition: 'left 160ms cubic-bezier(0.16, 1, 0.3, 1)',
      }} />
    </button>
  );
}

function Row({ label, hint, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '2px 0' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500 }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export default function ShieldPopover({ api, accent, host, onClose }) {
  const { settings, setSetting } = useModuleSettings('browser');
  const blocker = settings.blocker || {};
  const enabled = blocker.enabled !== false;
  const allowlist = Array.isArray(blocker.allowlist) ? blocker.allowlist : [];
  const siteAllowed = isHostAllowed(allowlist, host);
  const siteShieldOn = enabled && !!host && !siteAllowed;
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let live = true;
    api.invoke('blocker_get_state').then(s => { if (live) setStats(s); }).catch(() => {});
    return () => { live = false; };
  }, [enabled, allowlist.length, api]);

  const toggleEnabled = () => {
    const next = !enabled;
    setSetting('blocker', { ...blocker, enabled: next, allowlist });
    applyEnabled(next);
    reloadShieldTabs();
  };
  const toggleSite = () => {
    if (!host) return;
    const nextAllowed = !siteAllowed;
    const list = nextAllowed ? [...allowlist.filter(h => h !== host), host] : allowlist.filter(h => h !== host);
    setSetting('blocker', { ...blocker, enabled, allowlist: list });
    applySiteAllowed(host, nextAllowed);
    reloadShieldTabs();
  };
  const removeSite = (h) => {
    const list = allowlist.filter(x => x !== h);
    setSetting('blocker', { ...blocker, enabled, allowlist: list });
    applySiteAllowed(h, false);
    reloadShieldTabs();
  };
  const openSettings = () => { api.events.emit('host:open-settings', { tab: 'browser-shield' }); onClose(); };

  return (
    <BrowserPopover title="Shield" host={host} onClose={onClose}>
      <div style={{ padding: '12px 12px 0', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Row label="Block ads & trackers" hint="Global — applies to every site.">
          <ToggleButton on={enabled} accent={accent} onToggle={toggleEnabled} />
        </Row>
        <Row
          label={host ? `Shield on ${host}` : 'Shield on this site'}
          hint={host ? 'Per-site exception.' : 'Load a site to toggle it individually.'}
        >
          <ToggleButton on={siteShieldOn} accent={accent} disabled={!enabled || !host} onToggle={toggleSite} />
        </Row>

        <div>
          <div style={sectionLabel}>Filter lists</div>
          <div style={statRow}><span style={statKey}>Blocked domains</span><span style={statVal}>{stats ? stats.hostRules.toLocaleString() : '—'}</span></div>
          <div style={statRow}><span style={statKey}>Scriptlet rules</span><span style={statVal}>{stats ? stats.scriptletRules.toLocaleString() : '—'}</span></div>
          <div style={note}>Per-site block counts aren’t tracked.</div>
        </div>

        <div>
          <div style={sectionLabel}>Per-site exceptions</div>
          {allowlist.length === 0 ? (
            <div style={note}>No exceptions. Turn Shield off for a site with the toggle above.</div>
          ) : (
            allowlist.slice().sort().map(h => (
              <div key={h} style={exRow}>
                <span style={exHost}>{h}</span>
                <button type="button" style={removeBtn} onClick={() => removeSite(h)} title={`Re-enable Shield on ${h}`}>Remove</button>
              </div>
            ))
          )}
        </div>

        <button type="button" className="candy-btn" data-shape="text" data-own-press
          onClick={openSettings} style={{ width: '100%', marginBottom: candyGap(16), '--accent': accent }}>
          <span className="candy-face">Open Shield settings</span>
        </button>
      </div>
    </BrowserPopover>
  );
}

const sectionLabel = {
  fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--text-faint)', fontWeight: 600, marginBottom: 8,
};
const statRow = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' };
const statKey = { fontSize: 12, color: 'var(--text-muted)' };
const statVal = { fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'var(--text)', fontWeight: 600 };
const note = { fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5, paddingTop: 4 };
const exRow = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' };
const exHost = { fontSize: 12.5, color: 'var(--text)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const removeBtn = {
  flex: '0 0 auto', fontSize: 11, padding: '3px 10px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)',
  cursor: 'pointer', fontFamily: 'inherit',
};
